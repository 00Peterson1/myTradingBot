import { normalizeContractState, PortfolioSchema, DerivTickSchema } from './DerivTypes.js';
import type { ContractState } from './DerivTypes.js';
import { assertDefined } from '../../utils/assertDefined.js';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { z } from 'zod';
import { getTradingEnv } from '../../config/env.js';
import {
  DERIV_WS_PUBLIC,
  DERIV_REST_BASE,
  DERIV_REQUEST_TIMEOUT_MS,
  DERIV_RECONNECT_BASE_DELAY_MS,
  DERIV_RECONNECT_MAX_DELAY_MS,
  DERIV_RECONNECT_MAX_ATTEMPTS,
  DERIV_PING_INTERVAL_MS,
} from '../../config/constants.js';
import { createLogger } from '../../monitoring/Logger.js';
import {
  ActiveSymbolSchema,
  TickHistoryResponseSchema,
  ProposalSchema,
  BuyResponseSchema,
  BalanceSchema,
  AvailableContractSchema,
} from './DerivTypes.js';
import type {
  ActiveSymbol,
  DerivTick,
  TickHistoryResponse,
  Proposal,
  BuyResponse,
  Balance,
  AvailableContract,
} from './DerivTypes.js';
import {
  buildActiveSymbolsRequest,
  buildTicksHistoryRequest,
  buildTicksHistoryRangeRequest,
  buildSubscribeTicksRequest,
  buildUnsubscribeTicksRequest,
  buildProposalRequest,
  buildBuyRequest,
  buildDirectBuyRequest,
  buildSellRequest,
  buildBalanceRequest,
  buildPingRequest,
  buildContractsForRequest,
} from './DerivMessages.js';

const log = createLogger('DerivClient');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

 
interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  changesAccount: boolean;
}

export interface TradingAccount {
  accountId: string;
  accountType: 'demo' | 'real';
  currency: string;
  balance: number;
}

export class DerivApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(`Deriv API error [${code}]: ${message}`);
    this.name = 'DerivApiError';
  }
}

/** A transport failure cannot establish whether a submitted trade executed. */
export class UncertainTradeError extends Error {
  constructor(message: string) {
    super(`${message}. Trade outcome is unknown; reconcile the account before retrying.`);
    this.name = 'UncertainTradeError';
  }
}

// ---------------------------------------------------------------------------
// DerivClient Events
// ---------------------------------------------------------------------------
export interface DerivClientEvents {
  tick: (tick: DerivTick) => void;
  balance: (balance: Balance) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (err: Error) => void;
  reconnecting: (attempt: number, delayMs: number) => void;
  tradingConnected: () => void;
  tradingDisconnected: (reason: string) => void;
}

// ---------------------------------------------------------------------------
// DerivClient
//
// New Deriv API architecture (api.derivws.com):
//
//   Public WS  → wss://api.derivws.com/trading/v1/options/ws/public
//     No auth required.
//     Handles: ticks, ticks_history, active_symbols, proposal (pricing).
//
//   Trading WS → wss://api.derivws.com/trading/v1/options/ws/demo?otp=XXX
//              → wss://api.derivws.com/trading/v1/options/ws/real?otp=XXX
//     Auth: REST POST /trading/v1/options/accounts/{id}/otp returns WS URL.
//     Headers: Authorization: Bearer {PAT} + Deriv-App-ID: {APP_ID}
//     Handles: buy, sell, balance, proposal_open_contract.
//
// Usage:
//   await client.connectPublic();           // market data
//   await client.connectTrading('demo');    // trading (calls REST → OTP → WS)
// ---------------------------------------------------------------------------
class DerivClient extends EventEmitter<{ [K in keyof DerivClientEvents]: Parameters<DerivClientEvents[K]> }> {
  // Public WS — market data (ticks, proposals). No auth.
  private publicWs: WebSocket | null = null;
  private publicPending = new Map<number, PendingRequest<unknown>>();
  private publicPing: NodeJS.Timeout | null = null;

  // Trading WS — authenticated (buy, sell, balance). Auth via OTP.
  private tradingWs: WebSocket | null = null;
  private tradingPending = new Map<number, PendingRequest<unknown>>();
  private tradingPing: NodeJS.Timeout | null = null;
  private publicConnecting: Promise<void> | null = null;
  private tradingConnecting: Promise<void> | null = null;
  private publicReconnectTimer: NodeJS.Timeout | null = null;
  private tradingReconnectTimer: NodeJS.Timeout | null = null;
  private tradingReconnectAttempts = 0;
  private tradingMode: 'demo' | 'real' | null = null;
  private tradingAccount: TradingAccount | null = null;
  private balanceSubscribed = false;
  private restAbort = new AbortController();

  private reqIdCounter = 1;
  private subscriptions = new Map<string, string>(); // symbol → subscription ID
  private desiredSubscriptions = new Set<string>();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number = DERIV_RECONNECT_MAX_ATTEMPTS;
  private isShuttingDown = false;
  public isAuthorized = false;

  // ---------------------------------------------------------------------------
  // Public: Connection
  // ---------------------------------------------------------------------------

  /**
   * Connects to the public WebSocket — market data, no auth.
   * Handles: ticks, ticks_history, active_symbols, proposal.
   */
  async connectPublic(): Promise<void> {
    this.assertActive();
    if (this.publicConnecting) return this.publicConnecting;
    if (this.publicWs?.readyState === WebSocket.OPEN) return;
    if (this.publicReconnectTimer) clearTimeout(this.publicReconnectTimer);
    this.publicReconnectTimer = null;
    this.publicConnecting = (async (): Promise<void> => {
      log.info({ url: DERIV_WS_PUBLIC }, 'Connecting to public WebSocket');
      await this.openConnection('public', DERIV_WS_PUBLIC);
      // Snapshot before awaiting: mutating a Map while iterating can revisit entries forever.
      for (const symbol of [...this.desiredSubscriptions]) {
        await this.subscribeTicks(symbol);
      }
      this.reconnectAttempts = 0;
      log.info('Public WebSocket connected');
      this.emit('connected');
    })();
    try {
      await this.publicConnecting;
    } finally {
      this.publicConnecting = null;
    }
  }

  /** Alias for connectPublic() */
  async connect(): Promise<void> {
    return this.connectPublic();
  }

  /**
   * Connects to the authenticated trading WebSocket via OTP flow:
   *   1. REST GET  /trading/v1/options/accounts           → list accounts
   *   2. REST POST /trading/v1/options/accounts/{id}/otp  → get WS URL with OTP
   *   3. WS connect to that URL                           → ready to trade
   *
   * Headers: Authorization: Bearer {PAT} + Deriv-App-ID: {APP_ID}
   */
  async connectTrading(mode: 'demo' | 'real'): Promise<void> {
    this.assertActive();
    if (this.tradingMode !== null && this.tradingMode !== mode) {
      throw new Error('Cannot switch account mode on an existing client; create a new client.');
    }
    this.tradingMode = mode;
    if (this.tradingConnecting) return this.tradingConnecting;
    if (this.isTradingConnected()) return;
    if (this.tradingReconnectTimer) clearTimeout(this.tradingReconnectTimer);
    this.tradingReconnectTimer = null;
    this.tradingConnecting = (async (): Promise<void> => {
      this.tradingAccount ??= await this.getAccount(mode);
      this.assertActive();
      // OTPs are single use: always request a fresh one, including reconnects.
      const wsUrl = await this.fetchOtpUrl(this.tradingAccount.accountId, mode);
      this.assertActive();
      await this.openConnection('trading', wsUrl);
      this.assertActive();
      this.isAuthorized = true;
      if (this.balanceSubscribed) await this.subscribeBalance();
      this.tradingReconnectAttempts = 0;
      log.info({ accountId: this.tradingAccount.accountId, mode }, 'Trading WebSocket connected and authenticated');
      this.emit('tradingConnected');
    })();
    try {
      await this.tradingConnecting;
    } finally {
      this.tradingConnecting = null;
    }
  }

  getTradingMode(): 'demo' | 'real' | null {
    return this.tradingMode;
  }

  isTradingConnected(): boolean {
    return this.isAuthorized && this.tradingWs?.readyState === WebSocket.OPEN;
  }

  getTradingAccount(): TradingAccount | null {
    return this.tradingAccount ? { ...this.tradingAccount } : null;
  }

  /**
   * Gracefully disconnects all connections.
   */
  disconnect(): Promise<void> {
    log.info('Disconnecting from Deriv API');
    this.isShuttingDown = true;
    this.isAuthorized = false;
    this.restAbort.abort();
    this.clearPing('public');
    this.clearPing('trading');
    if (this.publicReconnectTimer) clearTimeout(this.publicReconnectTimer);
    if (this.tradingReconnectTimer) clearTimeout(this.tradingReconnectTimer);
    this.publicReconnectTimer = null;
    this.tradingReconnectTimer = null;
    this.rejectAllPending(this.publicPending, new Error('Client disconnecting'));
    this.rejectAllPending(this.tradingPending, new Error('Client disconnecting'));
    if (this.publicWs) {
      if (this.publicWs.readyState === WebSocket.CONNECTING) this.publicWs.terminate();
      else this.publicWs.close(1000, 'Client disconnect');
      this.publicWs = null;
    }
    if (this.tradingWs) {
      if (this.tradingWs.readyState === WebSocket.CONNECTING) this.tradingWs.terminate();
      else this.tradingWs.close(1000, 'Client disconnect');
      this.tradingWs = null;
    }
    this.emit('disconnected', 'Client disconnect');
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Public: Market Data (publicWs — no auth required)
  // ---------------------------------------------------------------------------

  async getActiveSymbols(): Promise<ActiveSymbol[]> {
    const reqId = this.nextReqId();
    const response = await this.sendPublicRequest<{ active_symbols: unknown[] }>(
      buildActiveSymbolsRequest('brief', reqId),
      reqId,
    );
    const raw = response.active_symbols;
    if (!Array.isArray(raw)) return [];
    return z.array(ActiveSymbolSchema).parse(raw);
  }

  async getContractsFor(symbol: string): Promise<AvailableContract[]> {
    const reqId = this.nextReqId();
    const request = buildContractsForRequest(symbol, reqId);
    const response = this.isTradingConnected()
      ? await this.sendTradingRequest<{ contracts_for: { available: unknown[] } }>(request, reqId)
      : await this.sendPublicRequest<{ contracts_for: { available: unknown[] } }>(request, reqId);
    return z.array(AvailableContractSchema).parse(response.contracts_for.available);
  }

  async getTickHistory(symbol: string, count: number): Promise<TickHistoryResponse> {
    const reqId = this.nextReqId();
    const response = await this.sendPublicRequest<{ history: unknown; pip_size?: number }>(
      buildTicksHistoryRequest(symbol, count, 'latest', reqId),
      reqId,
    );
    return TickHistoryResponseSchema.parse(response);
  }

  async getTickHistoryRange(
    symbol: string,
    startEpoch: number,
    endEpoch: number,
  ): Promise<TickHistoryResponse> {
    const reqId = this.nextReqId();
    const response = await this.sendPublicRequest<{ history: unknown; pip_size?: number }>(
      buildTicksHistoryRangeRequest(symbol, startEpoch, endEpoch, reqId),
      reqId,
    );
    return TickHistoryResponseSchema.parse(response);
  }

  async subscribeTicks(symbol: string): Promise<string> {
    this.desiredSubscriptions.add(symbol);
    if (this.subscriptions.has(symbol)) {
      return assertDefined(this.subscriptions.get(symbol));
    }
    const reqId = this.nextReqId();
    const response = await this.sendPublicRequest<{
      tick?: unknown;
      subscription?: { id: string };
    }>(buildSubscribeTicksRequest(symbol, reqId), reqId);

    const subscriptionId = response.subscription?.id ?? `sub-${String(reqId)}`;
    this.subscriptions.set(symbol, subscriptionId);
    log.info({ symbol, subscriptionId }, 'Subscribed to ticks');
    return subscriptionId;
  }

  async unsubscribeTicks(symbol: string): Promise<void> {
    this.desiredSubscriptions.delete(symbol);
    const subscriptionId = this.subscriptions.get(symbol);
    if (!subscriptionId) return;
    const reqId = this.nextReqId();
    await this.sendPublicRequest(buildUnsubscribeTicksRequest(subscriptionId, reqId), reqId);
    this.subscriptions.delete(symbol);
    log.info({ symbol, subscriptionId }, 'Unsubscribed from ticks');
  }

  async requestProposal(opts: Parameters<typeof buildProposalRequest>[0]): Promise<Proposal> {
    const reqId = this.nextReqId();
    const isTradingOpen = this.tradingWs !== null && this.tradingWs.readyState === WebSocket.OPEN;
    const response = isTradingOpen
      ? await this.sendTradingRequest<{ proposal: unknown }>(
          buildProposalRequest({ ...opts, reqId }),
          reqId,
        )
      : await this.sendPublicRequest<{ proposal: unknown }>(
          buildProposalRequest({ ...opts, reqId }),
          reqId,
        );
    return ProposalSchema.parse(response.proposal);
  }

  // ---------------------------------------------------------------------------
  // Public: Trading Operations (tradingWs — requires connectTrading() first)
  // ---------------------------------------------------------------------------

  async buyContract(proposalId: string, price: number): Promise<BuyResponse> {
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{ buy: unknown }>(
      buildBuyRequest(proposalId, price, reqId),
      reqId,
    );
    return BuyResponseSchema.parse(response.buy);
  }

  async buyContractDirect(opts: Parameters<typeof buildProposalRequest>[0]): Promise<BuyResponse> {
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{ buy: unknown }>(
      buildDirectBuyRequest({ ...opts, reqId }),
      reqId,
    );
    return BuyResponseSchema.parse(response.buy);
  }

  async sellContract(contractId: number, price: number): Promise<void> {
    const reqId = this.nextReqId();
    await this.sendTradingRequest(buildSellRequest(contractId, price, reqId), reqId);
  }

  async subscribeBalance(): Promise<Balance> {
    this.balanceSubscribed = true;
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{ balance: unknown }>(
      buildBalanceRequest(reqId),
      reqId,
    );
    return BalanceSchema.parse(response.balance);
  }

  async getContractResult(contractId: string): Promise<ContractState> {
    const numericId = Number(contractId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) throw new Error('Invalid contract ID');
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{ proposal_open_contract: unknown }>(
      { proposal_open_contract: 1, contract_id: numericId, req_id: reqId }, reqId,
    );
    const state = normalizeContractState(response.proposal_open_contract);
    if (state.contractId !== contractId) throw new Error('Contract response ID mismatch');
    return state;
  }

  async getBalance(): Promise<Balance> {
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{ balance: unknown }>({ balance: 1, req_id: reqId }, reqId);
    return BalanceSchema.parse(response.balance);
  }

  async getPortfolio(): Promise<ReturnType<typeof PortfolioSchema.parse>['contracts']> {
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{ portfolio: unknown }>({ portfolio: 1, req_id: reqId }, reqId);
    return PortfolioSchema.parse(response.portfolio).contracts;
  }

  // ---------------------------------------------------------------------------
  // Private: REST — Account lookup + OTP
  // ---------------------------------------------------------------------------

  private async getAccount(mode: 'demo' | 'real'): Promise<TradingAccount> {
    const env = getTradingEnv();
    log.info({ mode }, 'Fetching Deriv account list');

    const res = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
      signal: AbortSignal.any([this.restAbort.signal, AbortSignal.timeout(DERIV_REQUEST_TIMEOUT_MS)]),
      headers: {
        'Authorization': `Bearer ${env.DERIV_API_TOKEN}`,
        'Deriv-App-ID': env.DERIV_APP_ID,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw accountRequestError(res.status, 'account discovery');
    }

    const data = await res.json() as {
      data?: { account_id: string; account_type: string; balance: string; currency: string; status: string }[];
    };

    if (!data.data || data.data.length === 0) {
      throw new Error('No trading accounts found. Please create a Deriv account first.');
    }

    const account = data.data.find((a) => a.account_type === mode);
    if (!account) {
      throw new Error(`No ${mode} Options account found. Refusing to use a different account type.`);
    }
    const balance = Number(account.balance);
    if (!account.account_id || !account.currency || !Number.isFinite(balance)) {
      throw new Error('Deriv account response is missing a valid account ID, currency, or balance.');
    }

    log.info(
      { accountId: account.account_id, type: account.account_type, balance: account.balance },
      'Using account',
    );
    return { accountId: account.account_id, accountType: mode, currency: account.currency, balance };
  }

  private async fetchOtpUrl(accountId: string, mode: 'demo' | 'real'): Promise<string> {
    const env = getTradingEnv();
    log.info({ accountId }, 'Fetching OTP WebSocket URL');

    const res = await fetch(
      `${DERIV_REST_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      {
        method: 'POST',
        signal: AbortSignal.any([this.restAbort.signal, AbortSignal.timeout(DERIV_REQUEST_TIMEOUT_MS)]),
        headers: {
          'Authorization': `Bearer ${env.DERIV_API_TOKEN}`,
          'Deriv-App-ID': env.DERIV_APP_ID,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!res.ok) {
      throw accountRequestError(res.status, 'OTP request');
    }

    const data = await res.json() as { data?: { url: string } };
    const url = data.data?.url;
    if (!url) throw new Error('OTP response missing WebSocket URL');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('OTP response contains an invalid WebSocket URL');
    }
    if (parsed.protocol !== 'wss:' || parsed.hostname !== new URL(DERIV_REST_BASE).hostname ||
        parsed.pathname !== `/trading/v1/options/ws/${mode}` || !parsed.searchParams.has('otp')) {
      throw new Error('OTP WebSocket endpoint does not match the requested account mode');
    }
    log.info({ accountId, mode }, 'Trading OTP received');
    return url;
  }

  // ---------------------------------------------------------------------------
  // Private: WebSocket Connection Helpers
  // ---------------------------------------------------------------------------

  private assertActive(): void {
    if (this.isShuttingDown) throw new Error('Client is disconnected; create a new client to reconnect.');
  }

  private openConnection(channel: 'public' | 'trading', url: string): Promise<void> {
    this.assertActive();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: DERIV_REQUEST_TIMEOUT_MS });
      if (channel === 'public') this.publicWs = ws;
      else this.tradingWs = ws;
      let opened = false;
      const pending = channel === 'public' ? this.publicPending : this.tradingPending;
      ws.on('message', (data: WebSocket.RawData) => { this.handleMessage(data, pending); });
      ws.once('open', () => {
        if (this.isShuttingDown) {
          ws.close(1000, 'Client disconnect');
          reject(new Error('Client disconnecting'));
          return;
        }
        opened = true;
        this.startPing(channel, ws);
        resolve();
      });
      ws.on('error', () => {
        // A transport error may embed the URL (including OTP): expose only context.
        const error = new Error(`${channel} WebSocket ${opened ? 'transport' : 'connection'} error`);
        if (!opened) reject(error);
        this.rejectAllPending(pending, error);
        log.error({ channel }, 'WebSocket transport error');
        if (this.listenerCount('error') > 0) this.emit('error', error);
        ws.terminate();
      });
      ws.once('close', (code: number) => {
        // Do not log the arbitrary server close reason: it may contain credentials.
        if (!opened) reject(new Error(`${channel} WebSocket closed during connection (${String(code)})`));
        const current = channel === 'public' ? this.publicWs : this.tradingWs;
        if (current !== ws) return;
        if (channel === 'public') {
          this.publicWs = null;
          this.subscriptions.clear();
        } else {
          this.tradingWs = null;
          this.isAuthorized = false;
        }
        this.clearPing(channel);
        const reason = `${channel} WebSocket disconnected (${String(code)})`;
        this.rejectAllPending(pending, new Error(reason));
        log.warn({ channel, code }, 'WebSocket closed');
        if (channel === 'public') this.emit('disconnected', reason);
        else this.emit('tradingDisconnected', reason);
        if (opened && !this.isShuttingDown) this.scheduleReconnect(channel);
      });
    });
  }

  private scheduleReconnect(channel: 'public' | 'trading'): void {
    if (this.isShuttingDown) return;
    if (channel === 'public' ? this.publicReconnectTimer : this.tradingReconnectTimer) return;
    const attempts = channel === 'public' ? this.reconnectAttempts : this.tradingReconnectAttempts;
    const maxAttempts = this.maxReconnectAttempts;
    if (maxAttempts > 0 && attempts >= maxAttempts) {
      log.error({ channel, attempts }, 'Max reconnect attempts reached');
      return;
    }
    const attempt = attempts + 1;
    if (channel === 'public') this.reconnectAttempts = attempt;
    else this.tradingReconnectAttempts = attempt;
    const delay = Math.min(DERIV_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), DERIV_RECONNECT_MAX_DELAY_MS);
    log.info({ channel, attempt, delayMs: delay }, 'Reconnecting WebSocket');
    this.emit('reconnecting', attempt, delay);
    const timer = setTimeout(() => {
      if (channel === 'public') this.publicReconnectTimer = null;
      else this.tradingReconnectTimer = null;
      if (this.isShuttingDown) return;
      const connection = channel === 'public'
        ? this.connectPublic()
        : this.connectTrading(assertDefined(this.tradingMode));
      void connection.catch(() => {
        log.warn({ channel, attempt }, 'WebSocket reconnect failed');
        // Failure while restoring subscriptions must not leave a half-ready socket.
        const ws = channel === 'public' ? this.publicWs : this.tradingWs;
        ws?.terminate();
        this.scheduleReconnect(channel);
      });
    }, delay);
    if (channel === 'public') this.publicReconnectTimer = timer;
    else this.tradingReconnectTimer = timer;
  }

  // ---------------------------------------------------------------------------
  // Private: Message Handling
  // ---------------------------------------------------------------------------

  private handleMessage(data: WebSocket.RawData, pending: Map<number, PendingRequest<unknown>>): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = z.record(z.unknown()).parse(JSON.parse((Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data).toString('utf8')));
    } catch {
      log.warn('Malformed WebSocket message discarded');
      return;
    }

    const msgType = parsed.msg_type as string | undefined;
    const reqId = parsed.req_id as number | undefined;

    if (parsed.error) {
      const error = parsed.error as { code: string; message: string };
      log.debug({ code: error.code, message: error.message }, 'Deriv API response error');
      if (reqId !== undefined) {
        this.rejectPending(
          pending,
          reqId,
          new DerivApiError(error.code, error.message),
        );
      }
      return;
    }

    // Tick — resolve pending subscribe AND emit event
    if (msgType === 'tick') {
      if (reqId !== undefined) this.resolvePending(pending, reqId, parsed);
      const tick = DerivTickSchema.safeParse(parsed.tick);
      if (tick.success) this.emit('tick', tick.data);
      else log.warn('Invalid tick discarded');
      return;
    }

    // Balance — resolve pending AND emit event
    if (msgType === 'balance') {
      if (reqId !== undefined) this.resolvePending(pending, reqId, parsed);
      const balance = BalanceSchema.safeParse(parsed.balance);
      if (balance.success) this.emit('balance', balance.data);
      return;
    }

    // All other responses
    if (reqId !== undefined) this.resolvePending(pending, reqId, parsed);
  }

  // ---------------------------------------------------------------------------
  // Private: Request/Response Correlation
  // ---------------------------------------------------------------------------

  private sendPublicRequest<T>(payload: Record<string, unknown>, reqId: number): Promise<T> {
    if (this.publicWs?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Public WebSocket not connected. Call connectPublic() first.'));
    }
    return this.sendOn<T>(this.publicWs, this.publicPending, payload, reqId);
  }

  private sendTradingRequest<T>(payload: Record<string, unknown>, reqId: number): Promise<T> {
    if (this.tradingWs?.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error('Trading WebSocket not connected. Call connectTrading() first.'),
      );
    }
    return this.sendOn<T>(this.tradingWs, this.tradingPending, payload, reqId);
  }

  private sendOn<T>(
    ws: WebSocket,
      pending: Map<number, PendingRequest<unknown>>,
    payload: Record<string, unknown>,
    reqId: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const changesAccount = payload.buy !== undefined || payload.sell !== undefined || payload.cancel !== undefined;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(changesAccount ? new UncertainTradeError('Account-changing request timed out') : new Error(`Request ${String(reqId)} timed out after ${String(DERIV_REQUEST_TIMEOUT_MS)}ms`));
      }, DERIV_REQUEST_TIMEOUT_MS);

      pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer, changesAccount });

      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(reqId);
        reject(changesAccount ? new UncertainTradeError('Account-changing send failed') : err instanceof Error ? err : new Error('WebSocket send failed'));
      }
    });
  }

  private resolvePending(pending: Map<number, PendingRequest<unknown>>, reqId: number, data: unknown): void {
    const p = pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(reqId);
    p.resolve(data);
  }

  private rejectPending(pending: Map<number, PendingRequest<unknown>>, reqId: number, err: Error): void {
    const p = pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(reqId);
    p.reject(err);
  }

  private rejectAllPending(pending: Map<number, PendingRequest<unknown>>, err: Error): void {
    for (const [reqId, p] of pending.entries()) {
      clearTimeout(p.timer);
      p.reject(p.changesAccount ? new UncertainTradeError('Connection lost during account-changing request') : err);
      pending.delete(reqId);
    }
  }

  private nextReqId(): number {
    return this.reqIdCounter++;
  }

  // ---------------------------------------------------------------------------
  // Private: Keepalive
  // ---------------------------------------------------------------------------

  private startPing(channel: 'public' | 'trading', ws: WebSocket): void {
    this.clearPing(channel);
    let inFlight = false;
    const timer = setInterval(() => {
      if (this.isShuttingDown || ws.readyState !== WebSocket.OPEN || inFlight) return;
      inFlight = true;
      const reqId = this.nextReqId();
      const pending = channel === 'public' ? this.publicPending : this.tradingPending;
      void this.sendOn(ws, pending, buildPingRequest(reqId), reqId)
        .catch(() => {
          log.warn({ channel }, 'WebSocket heartbeat failed');
          ws.terminate();
        })
        .finally(() => { inFlight = false; });
    }, DERIV_PING_INTERVAL_MS);
    if (channel === 'public') this.publicPing = timer;
    else this.tradingPing = timer;
  }

  private clearPing(channel: 'public' | 'trading'): void {
    const timer = channel === 'public' ? this.publicPing : this.tradingPing;
    if (timer) clearInterval(timer);
    if (channel === 'public') this.publicPing = null;
    else this.tradingPing = null;
  }

}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _client: DerivClient | null = null;

export function getDerivClient(): DerivClient {
  _client ??= new DerivClient();
  return _client;
}

export { DerivClient };
export type { ActiveSymbol, DerivTick, TickHistoryResponse, Proposal, BuyResponse, Balance };

function accountRequestError(status: number, phase: string): Error {
  const category = status === 401 ? 'AUTHENTICATION_FAILED' : status === 403 ? 'AUTHORIZATION_FAILED' :
    status >= 500 ? 'DERIV_SERVICE_ERROR' : 'ACCOUNT_REQUEST_REJECTED';
  return new Error(`${category}: ${phase} returned HTTP ${String(status)}. ` +
    (status === 401 ? 'The provider did not distinguish an invalid, expired, or revoked token from application mismatch.' :
      status === 403 ? 'Check application access, token scopes, and account permissions.' : 'Inspect the account request and provider availability.'));
}
