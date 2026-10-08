import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { cTraderCatalogueSchema, type CTraderCatalogue } from './Catalogue.js';

export const ctraderConfigSchema = z.object({
  clientId: z.string().min(1), clientSecret: z.string().min(1), accessToken: z.string().min(1),
  accountId: z.string().regex(/^[1-9]\d*$/), refreshToken: z.string().min(1).optional(),
}).strict();
export type CTraderConfig = z.infer<typeof ctraderConfigSchema>;
const frameSchema = z.object({ payloadType: z.number().int(), clientMsgId: z.string().optional(), payload: z.record(z.unknown()).default({}) });
const idSchema = z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()]).transform(String);
const accountsSchema = z.object({ ctidTraderAccount: z.array(z.object({ ctidTraderAccountId: idSchema, isLive: z.boolean() })).default([]) });
const authSchema = z.object({ ctidTraderAccountId: idSchema });

/** Demo-only session. Diagnostic instances reject all order payloads by default. */
export class CTraderDemoConnection {
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<string, { expected: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private authenticated = false;
  private disconnectReason = 'not authenticated';
  private readonly listeners = new Set<(type: number, payload: Record<string, unknown>) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private nextRequestAt = 0;
  constructor(private readonly config: CTraderConfig, private readonly options: { allowDemoOrders?: boolean; saveTokens?: (tokens: { accessToken: string; refreshToken: string; expiresIn: number }) => Promise<void> } = {}) { ctraderConfigSchema.parse(config); }
  get accountId(): string { return this.config.accountId; }
  onEvent(listener: (type: number, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener); return () => { this.disconnectListeners.delete(listener); };
  }
  /** Fixed request/response pairs prevent callers from bypassing the diagnostic allowlist. */
  async read(type: number, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const responses: Record<number, number> = { 2112: 2113, 2114: 2115, 2116: 2117, 2118: 2119,
      2121: 2122, 2124: 2125, 2127: 2128, 2129: 2130, 2133: 2134, 2139: 2140,
      2145: 2146, 2153: 2154, 2160: 2161, 2175: 2176, 2177: 2178, 2179: 2180,
      2181: 2182, 2183: 2184, 2187: 2188 };
    const expected = responses[type];
    if (!this.authenticated || expected === undefined) throw new Error(`Unsupported or unauthenticated cTrader read: ${this.disconnectReason}`);
    const response = await this.request(type, expected, { ...payload, ctidTraderAccountId: this.config.accountId });
    if (idSchema.parse(response.ctidTraderAccountId) !== this.config.accountId) throw new Error('cTrader response account mismatch');
    return response;
  }
  async trade(type: 2106 | 2111, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (![2106, 2111].includes(type) || !this.authenticated || !this.options.allowDemoOrders) throw new Error('cTrader demo order capability is disabled');
    return this.request(type, 2126, { ...payload, ctidTraderAccountId: this.config.accountId });
  }

  async connect(): Promise<void> {
    if (this.socket) throw new Error('cTrader connection already started');
    const socket = new WebSocket('wss://demo.ctraderapi.com:5036', { handshakeTimeout: 10000 });
    this.socket = socket;
    socket.on('message', data => { if (this.socket !== socket) return; this.receive((Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data).toString('utf8')); });
    socket.on('close', () => { if (this.socket === socket) this.fail(); });
    socket.on('error', () => { if (this.socket === socket) this.fail(); });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () => { reject(new Error('cTrader demo connection failed')); });
        socket.once('close', () => { reject(new Error('cTrader demo connection closed')); });
      });
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ payloadType: 51, payload: {} }));
      }, 10000);
      await this.request(2100, 2101, { clientId: this.config.clientId, clientSecret: this.config.clientSecret });
      let accountResponse: Record<string, unknown>;
      try { accountResponse = await this.request(2149, 2150, { accessToken: this.config.accessToken }); }
      catch {
        if (!this.config.refreshToken || !this.options.saveTokens || socket.readyState !== WebSocket.OPEN) throw new Error('Token renewal unavailable');
        const tokens = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresIn: z.number().int().positive() })
          .parse(await this.request(2173, 2174, { refreshToken: this.config.refreshToken }));
        await this.options.saveTokens(tokens);
        this.config.accessToken = tokens.accessToken; this.config.refreshToken = tokens.refreshToken;
        accountResponse = await this.request(2149, 2150, { accessToken: this.config.accessToken });
      }
      const accounts = accountsSchema.parse(accountResponse);
      const account = accounts.ctidTraderAccount.find(item => item.ctidTraderAccountId === this.config.accountId);
      if (!account || account.isLive) throw new Error('Configured cTrader account is not an authorized demo account');
      const auth = authSchema.parse(await this.request(2102, 2103, { ctidTraderAccountId: this.config.accountId, accessToken: this.config.accessToken }));
      if (auth.ctidTraderAccountId !== this.config.accountId) throw new Error('cTrader account identity mismatch');
      this.authenticated = true; this.disconnectReason = 'connected';
    } catch {
      this.close();
      // Broker descriptions/schema errors may contain credentials: do not propagate them.
      throw new Error('cTrader demo authentication failed; check application authorization, demo account ID and token locally');
    }
  }

  async inspect(): Promise<{ symbolCount: number; positionCount: number; pendingOrderCount: number }> {
    if (!this.authenticated) throw new Error('cTrader demo account is not authenticated');
    const payload = { ctidTraderAccountId: this.config.accountId };
    const symbols = await this.request(2114, 2115, payload);
    const state = await this.request(2124, 2125, payload);
    const symbolSchema = z.object({ ctidTraderAccountId: idSchema, symbol: z.array(z.object({ symbolId: idSchema })).default([]) });
    const stateSchema = z.object({ ctidTraderAccountId: idSchema, position: z.array(z.record(z.unknown())).default([]), order: z.array(z.record(z.unknown())).default([]) });
    const parsedSymbols = symbolSchema.parse(symbols), parsedState = stateSchema.parse(state);
    if (parsedSymbols.ctidTraderAccountId !== this.config.accountId || parsedState.ctidTraderAccountId !== this.config.accountId) throw new Error('cTrader snapshot account mismatch');
    return { symbolCount: parsedSymbols.symbol.length, positionCount: parsedState.position.length, pendingOrderCount: parsedState.order.length };
  }

  async catalogue(): Promise<CTraderCatalogue> {
    if (!this.authenticated) throw new Error('cTrader demo account is not authenticated');
    const payload = { ctidTraderAccountId: this.config.accountId };
    const symbols = await this.request(2114, 2115, { ...payload, includeArchivedSymbols: true });
    const categories = await this.request(2160, 2161, payload);
    const classes = await this.request(2153, 2154, payload);
    for (const response of [symbols, categories, classes]) if (idSchema.parse(response.ctidTraderAccountId) !== this.config.accountId) throw new Error('cTrader catalogue account mismatch');
    return cTraderCatalogueSchema.parse({ version: 1, provider: 'CTRADER', environment: 'DEMO', accountId: this.config.accountId,
      capturedAt: new Date().toISOString(), symbols: symbols.symbol ?? [], categories: categories.symbolCategory ?? [],
      assetClasses: classes.assetClass ?? [], archivedSymbols: symbols.archivedSymbol ?? [] });
  }

  private async request(type: number, expected: number, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const originalSocket = this.socket;
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    this.nextRequestAt = Date.now() + wait + 220;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const socket = this.socket;
    if (socket !== originalSocket || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('cTrader connection is closed'));
    if (![2100, 2149, 2102, 2173].includes(type) && !this.authenticated) throw new Error('cTrader session requires authentication');
    // Diagnostic connections cannot submit orders.
    if ([2106, 2111].includes(type) && !this.options.allowDemoOrders) throw new Error('Demo order capability is disabled');
    // The cTrader JSON endpoint requires a numeric account ID on the wire.
    // Keep identity strings internally, and reject values JS cannot represent exactly.
    const wirePayload = { ...payload };
    if ('ctidTraderAccountId' in wirePayload) {
      const accountId = Number(wirePayload.ctidTraderAccountId);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) return Promise.reject(new Error('cTrader JSON account ID cannot be represented safely'));
      wirePayload.ctidTraderAccountId = accountId;
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('cTrader request timed out')); }, 10000);
      this.pending.set(id, { expected, resolve, reject, timer });
      socket.send(JSON.stringify({ clientMsgId: id, payloadType: type, payload: wirePayload }), error => {
        if (error) this.fail();
      });
    });
  }
  private receive(raw: string): void {
    let frame: z.infer<typeof frameSchema>;
    try { frame = frameSchema.parse(JSON.parse(raw) as unknown); }
    catch { this.disconnectReason = 'invalid frame'; this.close(); return; }
    if ([2147, 2148, 2164].includes(frame.payloadType)) { this.close(); return; }
    if ('ctidTraderAccountId' in frame.payload && String(frame.payload.ctidTraderAccountId) !== this.config.accountId) { this.close(); return; }
    try { for (const listener of this.listeners) listener(frame.payloadType, frame.payload); }
    catch (error) { this.disconnectReason = `event ${String(frame.payloadType)} rejected: ${error instanceof z.ZodError ? error.issues.map(issue => issue.message).join(', ') : error instanceof Error ? error.message : 'invalid event'}`; this.close(); return; }
    if (!frame.clientMsgId) return;
    const pending = this.pending.get(frame.clientMsgId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.clientMsgId);
    if (frame.payloadType !== pending.expected) pending.reject(new Error('cTrader rejected the diagnostic request'));
    else pending.resolve(frame.payload);
  }
  private fail(): void {
    const wasAuthenticated = this.authenticated;
    this.authenticated = false;
    if (wasAuthenticated) for (const listener of this.disconnectListeners) listener();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('cTrader connection interrupted')); }
    this.pending.clear();
  }
  close(): void { this.fail(); this.socket?.terminate(); this.socket = undefined; }
}
