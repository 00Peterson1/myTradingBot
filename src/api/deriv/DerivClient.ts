import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { z } from 'zod';
import { getEnv } from '../../config/index.js';
import {
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
  buildAuthorizeRequest,
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

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'AUTHORIZED' | 'CLOSING';

// ---------------------------------------------------------------------------
// DerivClient Events
// ---------------------------------------------------------------------------
export interface DerivClientEvents {
  tick: (tick: DerivTick) => void;
  balance: (balance: Balance) => void;
  connected: () => void;
  authorized: () => void;
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
// ---------------------------------------------------------------------------

/**
 * WebSocket client for the Deriv API.
 *
 * Features:
 *   - Automatic reconnection with exponential backoff
 *   - Request/response correlation via req_id
 *   - Ping/keepalive
 *   - Tick subscription management
 *   - Full graceful shutdown
 *   - No API tokens in logs
 */
class DerivClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'DISCONNECTED';
  private reqIdCounter = 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pending = new Map<number, PendingRequest<any>>();
  private subscriptions = new Map<string, string>(); // symbol → subscription ID
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isShuttingDown = false;
  private authorized = false;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isAuthorized(): boolean {
    return this.authorized;
  }

  /**
   * Connects to Deriv WebSocket and authorizes.
   * Resolves when fully authorized.
   */
  async connect(): Promise<void> {
    if (this.state !== 'DISCONNECTED') {
      log.warn({ state: this.state }, 'connect() called but already connected');
      return;
    }
    this.isShuttingDown = false;
    await this.openConnection();
    await this.authorize();
  }

  /**
   * Gracefully disconnects and cleans up.
   */
  async disconnect(): Promise<void> {
    log.info('Disconnecting from Deriv API');
    this.isShuttingDown = true;
    this.state = 'CLOSING';
    this.clearPing();
    this.rejectAllPending(new Error('Client disconnecting'));
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.state = 'DISCONNECTED';
    this.authorized = false;
  }

  /**
   * Fetches all active symbols from Deriv.
   */
  async getActiveSymbols(): Promise<ActiveSymbol[]> {
    const reqId = this.nextReqId();
    const response = await this.sendRequest<{ active_symbols: unknown[] }>(
      buildActiveSymbolsRequest('full', reqId),
      reqId,
    );
    return z.array(ActiveSymbolSchema).parse(response.active_symbols);
  }

  /**
   * Fetches tick history for a symbol.
   * @param symbol - The instrument symbol
   * @param count - Number of ticks to fetch
   */
  async getTickHistory(symbol: string, count: number): Promise<TickHistoryResponse> {
    const reqId = this.nextReqId();
    const response = await this.sendRequest<{ history: unknown; pip_size?: number }>(
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
    const response = await this.sendRequest<{ history: unknown; pip_size?: number }>(
      buildTicksHistoryRangeRequest(symbol, startEpoch, endEpoch, reqId),
      reqId,
    );
    return TickHistoryResponseSchema.parse(response);
  }

  /**
   * Subscribes to live ticks for a symbol.
   * Ticks are emitted via the 'tick' event.
   */
  async subscribeTicks(symbol: string): Promise<string> {
    if (this.subscriptions.has(symbol)) {
      log.debug({ symbol }, 'Already subscribed to ticks');
      return this.subscriptions.get(symbol)!;
    }

    const reqId = this.nextReqId();
    const response = await this.sendRequest<{
      tick: unknown;
      subscription: { id: string };
    }>(buildSubscribeTicksRequest(symbol, reqId), reqId);

    const subscriptionId = response.subscription.id;
    this.subscriptions.set(symbol, subscriptionId);
    log.info({ symbol, subscriptionId }, 'Subscribed to ticks');
    return subscriptionId;
  }

  /**
   * Unsubscribes from live ticks for a symbol.
   */
  async unsubscribeTicks(symbol: string): Promise<void> {
    const subscriptionId = this.subscriptions.get(symbol);
    if (!subscriptionId) {
      log.warn({ symbol }, 'Not subscribed to this symbol');
      return;
    }

    const reqId = this.nextReqId();
    await this.sendRequest(buildUnsubscribeTicksRequest(subscriptionId, reqId), reqId);
    this.subscriptions.delete(symbol);
    log.info({ symbol, subscriptionId }, 'Unsubscribed from ticks');
  }

  /**
   * Requests a contract proposal (price quote).
   */
  async requestProposal(opts: Parameters<typeof buildProposalRequest>[0]): Promise<Proposal> {
    const reqId = this.nextReqId();
    const response = await this.sendRequest<{ proposal: unknown }>(
      buildProposalRequest({ ...opts, reqId }),
      reqId,
    );
    return ProposalSchema.parse(response.proposal);
  }

  /**
   * Buys a contract using a proposal ID.
   */
  async buyContract(proposalId: string, price: number): Promise<BuyResponse> {
    const reqId = this.nextReqId();
    const response = await this.sendRequest<{ buy: unknown }>(
      buildBuyRequest(proposalId, price, reqId),
      reqId,
    );
    return BuyResponseSchema.parse(response.buy);
  }

  /**
   * Sells an open contract.
   */
  async sellContract(contractId: number, price: number): Promise<void> {
    const reqId = this.nextReqId();
    await this.sendRequest(buildSellRequest(contractId, price, reqId), reqId);
  }

  /**
   * Subscribes to account balance updates.
   */
  async subscribeBalance(): Promise<Balance> {
    const reqId = this.nextReqId();
    const response = await this.sendRequest<{ balance: unknown }>(
      buildBalanceRequest(reqId),
      reqId,
    );
    return BalanceSchema.parse(response.balance);
  }

  // ---------------------------------------------------------------------------
  // Private: Connection Management
  // ---------------------------------------------------------------------------

  private async openConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = getEnv();
      const url = `${env.DERIV_WS_URL}?app_id=${env.DERIV_APP_ID}`;

      log.info({ url: env.DERIV_WS_URL }, 'Connecting to Deriv WebSocket');
      this.state = 'CONNECTING';

      this.ws = new WebSocket(url);

      const onOpen = (): void => {
        this.state = 'CONNECTED';
        this.reconnectAttempts = 0;
        this.startPing();
        log.info('WebSocket connected');
        this.emit('connected');
        resolve();
      };

      const onError = (err: Error): void => {
        log.error({ err }, 'WebSocket error');
        this.emit('error', err);
        reject(err);
      };

      this.ws.once('open', onOpen);
      this.ws.once('error', onError);

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.handleClose(code, reason.toString());
      });
    });
  }

  private async authorize(): Promise<void> {
    const env = getEnv();
    const reqId = this.nextReqId();

    log.info('Authorizing with Deriv API');

    // Build authorize request (we never log the token itself)
    const response = await this.sendRequest<{
      authorize: { email: string; loginid: string; fullname?: string };
    }>(buildAuthorizeRequest(env.DERIV_API_TOKEN, reqId), reqId);

    this.authorized = true;
    this.state = 'AUTHORIZED';
    const { email, loginid } = response.authorize;
    log.info({ email, loginid }, 'Authorized successfully');
    this.emit('authorized');
  }

  private handleClose(code: number, reason: string): void {
    log.warn({ code, reason }, 'WebSocket closed');
    this.authorized = false;
    this.state = 'DISCONNECTED';
    this.clearPing();
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

    log.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting');
    this.emit('reconnecting', this.reconnectAttempts, delay);

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.openConnection();
      await this.authorize();

      // Re-subscribe to all active ticks
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

  private handleMessage(data: WebSocket.RawData): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      log.warn({ raw: data.toString().slice(0, 200) }, 'Malformed WebSocket message');
      return;
    }

    const msgType = parsed['msg_type'] as string | undefined;
    const reqId = parsed['req_id'] as number | undefined;

    // Check for API-level errors
    if (parsed['error']) {
      const error = parsed['error'] as { code: string; message: string };
      log.error({ code: error.code, message: error.message }, 'Deriv API error');
      if (reqId !== undefined) {
        this.rejectPending(reqId, new Error(`Deriv API error [${error.code}]: ${error.message}`));
      }
      return;
    }

    // Route streaming events
    if (msgType === 'tick') {
      const tickData = parsed['tick'] as Record<string, unknown>;
      const tick: DerivTick = {
        symbol: tickData['symbol'] as string,
        epoch: tickData['epoch'] as number,
        quote: tickData['quote'] as number,
        id: tickData['id'] as number | undefined,
        pip_size: tickData['pip_size'] as number | undefined,
      };
      this.emit('tick', tick);
      return;
    }

    if (msgType === 'balance') {
      const balance = BalanceSchema.safeParse(parsed['balance']);
      if (balance.success) {
        this.emit('balance', balance.data);
      }
      // Balance may also have a req_id from initial subscribe request
    }

    // Resolve pending request if applicable
    if (reqId !== undefined) {
      this.resolvePending(reqId, parsed);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Request/Response Correlation
  // ---------------------------------------------------------------------------

  private sendRequest<T>(payload: Record<string, unknown>, reqId: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.state === 'DISCONNECTED' || this.state === 'CLOSING') {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Request ${reqId} timed out after ${DERIV_REQUEST_TIMEOUT_MS}ms`));
      }, DERIV_REQUEST_TIMEOUT_MS);

      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });

      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private resolvePending(reqId: number, data: Record<string, unknown>): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reqId);
    pending.resolve(data);
  }

  private rejectPending(reqId: number, err: Error): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reqId);
    pending.reject(err);
  }

  private rejectAllPending(err: Error): void {
    for (const [reqId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(reqId);
    }
  }

  private nextReqId(): number {
    return this.reqIdCounter++;
  }

  // ---------------------------------------------------------------------------
  // Private: Keepalive
  // ---------------------------------------------------------------------------

  private startPing(): void {
    this.clearPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.state === 'AUTHORIZED') {
        const reqId = this.nextReqId();
        this.ws.send(JSON.stringify(buildPingRequest(reqId)));
      }
    }, DERIV_PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _client: DerivClient | null = null;

/**
 * Returns the singleton DerivClient instance.
 */
export function getDerivClient(): DerivClient {
  if (_client === null) {
    _client = new DerivClient();
  }
  return _client;
}

export { DerivClient };
export type { ActiveSymbol, DerivTick, TickHistoryResponse, Proposal, BuyResponse, Balance };
