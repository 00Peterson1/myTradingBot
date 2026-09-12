import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { z } from 'zod';
import { getEnv } from '../../config/index.js';
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
} from './DerivTypes.js';
import type {
  ActiveSymbol,
  DerivTick,
  TickHistoryResponse,
  Proposal,
  BuyResponse,
  Balance,
} from './DerivTypes.js';
import {
  buildActiveSymbolsRequest,
  buildTicksHistoryRequest,
  buildTicksHistoryRangeRequest,
  buildSubscribeTicksRequest,
  buildUnsubscribeTicksRequest,
  buildProposalRequest,
  buildBuyRequest,
  buildSellRequest,
  buildBalanceRequest,
  buildPingRequest,
} from './DerivMessages.js';

const log = createLogger('DerivClient');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

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
}

declare interface DerivClient {
  on<K extends keyof DerivClientEvents>(event: K, listener: DerivClientEvents[K]): this;
  emit<K extends keyof DerivClientEvents>(
    event: K,
    ...args: Parameters<DerivClientEvents[K]>
  ): boolean;
}

// ---------------------------------------------------------------------------
// DerivClient
//
// Architecture (new Deriv API — developers.deriv.com):
//
//   Public WS  (wss://api.derivws.com/.../ws/public)
//     → no auth required
//     → active_symbols, ticks, ticks_history, proposal
//
//   Trading WS (OTP URL from REST POST /accounts/{id}/otp)
//     → requires PAT token + App ID in REST header
//     → buy, sell, balance, proposal_open_contract
//
// ---------------------------------------------------------------------------
class DerivClient extends EventEmitter {
  // Public WebSocket — market data, no auth
  private publicWs: WebSocket | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private publicPending = new Map<number, PendingRequest<any>>();
  private publicPing: NodeJS.Timeout | null = null;

  // Trading WebSocket — authenticated operations
  private tradingWs: WebSocket | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tradingPending = new Map<number, PendingRequest<any>>();

  private reqIdCounter = 1;
  private subscriptions = new Map<string, string>(); // symbol → subscription ID
  private reconnectAttempts = 0;
  private isShuttingDown = false;
  private accountId: string | null = null;

  // ---------------------------------------------------------------------------
  // Public: Connection
  // ---------------------------------------------------------------------------

  /**
   * Connects to the public WebSocket gateway.
   * No authentication required.
   * Sufficient for: active_symbols, ticks, ticks_history, proposal (pricing).
   */
  async connectPublic(): Promise<void> {
    log.info({ url: DERIV_WS_PUBLIC }, 'Connecting to public WebSocket');
    await this.openPublicConnection();
    log.info('Public WebSocket connected');
    this.emit('connected');
  }

  /**
   * Alias for connectPublic() — research and data-only modes use this.
   */
  async connect(): Promise<void> {
    return this.connectPublic();
  }

  /**
   * Connects to the authenticated trading WebSocket.
   * Call this AFTER connectPublic() when you need to place trades.
   *
   * Flow:
   *   1. REST GET  /trading/v1/options/accounts           → get account ID
   *   2. REST POST /trading/v1/options/accounts/{id}/otp  → get OTP WebSocket URL
   *   3. WS connect to that URL                           → ready to trade
   *
   * @param mode 'demo' | 'real'
   */
  async connectTrading(mode: 'demo' | 'real'): Promise<void> {
    const accountId = await this.getAccountId(mode);
    const otpUrl = await this.fetchOtpUrl(accountId, mode);
    await this.openTradingConnection(otpUrl);
    log.info({ accountId, mode }, 'Trading WebSocket connected');
  }

  /**
   * Gracefully disconnects all connections.
   */
  async disconnect(): Promise<void> {
    log.info('Disconnecting from Deriv API');
    this.isShuttingDown = true;
    this.clearPublicPing();
    this.rejectAllPending(this.publicPending, new Error('Client disconnecting'));
    this.rejectAllPending(this.tradingPending, new Error('Client disconnecting'));
    if (this.publicWs) {
      this.publicWs.close(1000, 'Client disconnect');
      this.publicWs = null;
    }
    if (this.tradingWs) {
      this.tradingWs.close(1000, 'Client disconnect');
      this.tradingWs = null;
    }
    this.emit('disconnected', 'Client disconnect');
  }

  // ---------------------------------------------------------------------------
  // Public: Market Data (uses publicWs)
  // ---------------------------------------------------------------------------

  /**
   * Fetches all active symbols. Does NOT require auth.
   */
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

  /**
   * Fetches tick history for a symbol.
   */
  async getTickHistory(symbol: string, count: number): Promise<TickHistoryResponse> {
    const reqId = this.nextReqId();
    const response = await this.sendPublicRequest<{ history: unknown; pip_size?: number }>(
      buildTicksHistoryRequest(symbol, count, 'latest', reqId),
      reqId,
    );
    return TickHistoryResponseSchema.parse(response);
  }

  /**
   * Fetches tick history for a specific time range.
   */
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

  /**
   * Subscribes to live ticks for a symbol. Emits 'tick' events.
   */
  async subscribeTicks(symbol: string): Promise<string> {
    if (this.subscriptions.has(symbol)) {
      return this.subscriptions.get(symbol)!;
    }
    const reqId = this.nextReqId();
    const response = await this.sendPublicRequest<{
      tick?: unknown;
      subscription?: { id: string };
    }>(buildSubscribeTicksRequest(symbol, reqId), reqId);

    const subscriptionId = response.subscription?.id ?? `sub-${reqId}`;
    this.subscriptions.set(symbol, subscriptionId);
    log.info({ symbol, subscriptionId }, 'Subscribed to ticks');
    return subscriptionId;
  }

  /**
   * Unsubscribes from live ticks for a symbol.
   */
  async unsubscribeTicks(symbol: string): Promise<void> {
    const subscriptionId = this.subscriptions.get(symbol);
    if (!subscriptionId) return;
    const reqId = this.nextReqId();
    await this.sendPublicRequest(buildUnsubscribeTicksRequest(subscriptionId, reqId), reqId);
    this.subscriptions.delete(symbol);
    log.info({ symbol, subscriptionId }, 'Unsubscribed from ticks');
  }

  /**
   * Requests a price proposal. Uses publicWs.
   */
  async requestProposal(opts: Parameters<typeof buildProposalRequest>[0]): Promise<Proposal> {
    const reqId = this.nextReqId();
    const response = await this.sendPublicRequest<{ proposal: unknown }>(
      buildProposalRequest({ ...opts, reqId }),
      reqId,
    );
    return ProposalSchema.parse(response.proposal);
  }

  // ---------------------------------------------------------------------------
  // Public: Trading Operations (uses tradingWs — requires connectTrading() first)
  // ---------------------------------------------------------------------------

  async buyContract(proposalId: string, price: number): Promise<BuyResponse> {
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{ buy: unknown }>(
      buildBuyRequest(proposalId, price, reqId),
      reqId,
    );
    return BuyResponseSchema.parse(response.buy);
  }

  async sellContract(contractId: number, price: number): Promise<void> {
    const reqId = this.nextReqId();
    await this.sendTradingRequest(buildSellRequest(contractId, price, reqId), reqId);
  }

  async subscribeBalance(): Promise<Balance> {
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{ balance: unknown }>(
      buildBalanceRequest(reqId),
      reqId,
    );
    return BalanceSchema.parse(response.balance);
  }

  async getContractResult(contractId: string): Promise<{ profit: number; isSettled: boolean }> {
    const reqId = this.nextReqId();
    const response = await this.sendTradingRequest<{
      proposal_open_contract: Record<string, unknown>;
    }>(
      { proposal_open_contract: 1, contract_id: Number(contractId), req_id: reqId },
      reqId,
    );
    const contract = response.proposal_open_contract;
    const profit = (contract['profit'] as number | undefined) ?? 0;
    const isSettled = contract['status'] === 'sold' || contract['is_expired'] === 1;
    return { profit, isSettled };
  }

  // ---------------------------------------------------------------------------
  // Private: REST — Account + OTP
  // ---------------------------------------------------------------------------

  private async getAccountId(mode: 'demo' | 'real'): Promise<string> {
    if (this.accountId) return this.accountId;

    const env = getEnv();
    log.info('Fetching Deriv account list');

    const res = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
      headers: {
        Authorization: `Bearer ${env.DERIV_API_TOKEN}`,
        'Deriv-App-ID': env.DERIV_APP_ID,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch accounts: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { data: Array<{ id: string; type: string }> };
    const account =
      data.data.find((a) => a.type === (mode === 'demo' ? 'demo' : 'real')) ?? data.data[0];

    if (!account) throw new Error('No trading account found');

    this.accountId = account.id;
    log.info({ accountId: this.accountId, type: account.type }, 'Using account');
    return this.accountId;
  }

  private async fetchOtpUrl(accountId: string, mode: 'demo' | 'real'): Promise<string> {
    const env = getEnv();
    log.info({ accountId, mode }, 'Fetching OTP WebSocket URL');

    const res = await fetch(
      `${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/otp`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.DERIV_API_TOKEN}`,
          'Deriv-App-ID': env.DERIV_APP_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: mode }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch OTP URL: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { url: string };
    log.info('OTP URL received');
    return data.url;
  }

  // ---------------------------------------------------------------------------
  // Private: WebSocket Connection Helpers
  // ---------------------------------------------------------------------------

  private openPublicConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(DERIV_WS_PUBLIC);

      ws.once('open', () => {
        this.publicWs = ws;
        this.reconnectAttempts = 0;
        this.startPublicPing();

        ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data, this.publicPending);
        });

        ws.on('close', (code: number, reason: Buffer) => {
          this.handlePublicClose(code, reason.toString());
        });

        ws.on('error', (err: Error) => {
          log.error({ err }, 'Public WebSocket error');
          this.emit('error', err);
        });

        resolve();
      });

      ws.once('error', (err: Error) => {
        log.error({ err }, 'Public WebSocket error during connect');
        reject(err);
      });
    });
  }

  private openTradingConnection(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);

      ws.once('open', () => {
        this.tradingWs = ws;

        ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data, this.tradingPending);
        });

        ws.on('close', (code: number, reason: Buffer) => {
          log.warn({ code, reason: reason.toString() }, 'Trading WebSocket closed');
          this.tradingWs = null;
        });

        ws.on('error', (err: Error) => {
          log.error({ err }, 'Trading WebSocket error');
          this.emit('error', err);
        });

        resolve();
      });

      ws.once('error', (err: Error) => {
        log.error({ err }, 'Trading WebSocket error during connect');
        reject(err);
      });
    });
  }

  private handlePublicClose(code: number, reason: string): void {
    log.warn({ code, reason }, 'Public WebSocket closed');
    this.publicWs = null;
    this.clearPublicPing();
    this.emit('disconnected', reason);

    if (!this.isShuttingDown) {
      void this.scheduleReconnect();
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (
      DERIV_RECONNECT_MAX_ATTEMPTS > 0 &&
      this.reconnectAttempts >= DERIV_RECONNECT_MAX_ATTEMPTS
    ) {
      log.error({ attempts: this.reconnectAttempts }, 'Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      DERIV_RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      DERIV_RECONNECT_MAX_DELAY_MS,
    );

    log.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting public WS');
    this.emit('reconnecting', this.reconnectAttempts, delay);

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.openPublicConnection();
      for (const symbol of this.subscriptions.keys()) {
        this.subscriptions.delete(symbol);
        await this.subscribeTicks(symbol);
      }
    } catch (err) {
      log.error({ err }, 'Reconnect failed');
      await this.scheduleReconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Message Handling
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(data: WebSocket.RawData, pending: Map<number, PendingRequest<any>>): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      log.warn({ raw: data.toString().slice(0, 200) }, 'Malformed WebSocket message');
      return;
    }

    const msgType = parsed['msg_type'] as string | undefined;
    const reqId = parsed['req_id'] as number | undefined;

    if (parsed['error']) {
      const error = parsed['error'] as { code: string; message: string };
      log.error({ code: error.code, message: error.message }, 'Deriv API error');
      if (reqId !== undefined) {
        this.rejectPending(
          pending,
          reqId,
          new Error(`Deriv API error [${error.code}]: ${error.message}`),
        );
      }
      return;
    }

    // Tick — resolve pending subscribe AND emit event
    if (msgType === 'tick') {
      if (reqId !== undefined) this.resolvePending(pending, reqId, parsed);
      const tickData = parsed['tick'] as Record<string, unknown> | undefined;
      if (tickData) {
        const tick: DerivTick = {
          symbol: tickData['symbol'] as string,
          epoch: tickData['epoch'] as number,
          quote: tickData['quote'] as number,
          id: tickData['id'] as number | undefined,
          pip_size: tickData['pip_size'] as number | undefined,
        };
        this.emit('tick', tick);
      }
      return;
    }

    // Balance — resolve pending AND emit event
    if (msgType === 'balance') {
      if (reqId !== undefined) this.resolvePending(pending, reqId, parsed);
      const balance = BalanceSchema.safeParse(parsed['balance']);
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
    if (!this.publicWs || this.publicWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Public WebSocket not connected. Call connectPublic() first.'));
    }
    return this.sendOn<T>(this.publicWs, this.publicPending, payload, reqId);
  }

  private sendTradingRequest<T>(payload: Record<string, unknown>, reqId: number): Promise<T> {
    if (!this.tradingWs || this.tradingWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error('Trading WebSocket not connected. Call connectTrading() first.'),
      );
    }
    return this.sendOn<T>(this.tradingWs, this.tradingPending, payload, reqId);
  }

  private sendOn<T>(
    ws: WebSocket,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pending: Map<number, PendingRequest<any>>,
    payload: Record<string, unknown>,
    reqId: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`Request ${reqId} timed out after ${DERIV_REQUEST_TIMEOUT_MS}ms`));
      }, DERIV_REQUEST_TIMEOUT_MS);

      pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });

      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolvePending(pending: Map<number, PendingRequest<any>>, reqId: number, data: unknown): void {
    const p = pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(reqId);
    p.resolve(data);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rejectPending(pending: Map<number, PendingRequest<any>>, reqId: number, err: Error): void {
    const p = pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(reqId);
    p.reject(err);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rejectAllPending(pending: Map<number, PendingRequest<any>>, err: Error): void {
    for (const [reqId, p] of pending.entries()) {
      clearTimeout(p.timer);
      p.reject(err);
      pending.delete(reqId);
    }
  }

  private nextReqId(): number {
    return this.reqIdCounter++;
  }

  // ---------------------------------------------------------------------------
  // Private: Keepalive
  // ---------------------------------------------------------------------------

  private startPublicPing(): void {
    this.clearPublicPing();
    this.publicPing = setInterval(() => {
      if (this.publicWs?.readyState === WebSocket.OPEN) {
        const reqId = this.nextReqId();
        this.publicWs.send(JSON.stringify(buildPingRequest(reqId)));
      }
    }, DERIV_PING_INTERVAL_MS);
  }

  private clearPublicPing(): void {
    if (this.publicPing !== null) {
      clearInterval(this.publicPing);
      this.publicPing = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _client: DerivClient | null = null;

export function getDerivClient(): DerivClient {
  if (_client === null) _client = new DerivClient();
  return _client;
}

export { DerivClient };
export type { ActiveSymbol, DerivTick, TickHistoryResponse, Proposal, BuyResponse, Balance };
