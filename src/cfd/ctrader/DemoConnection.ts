import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';

export const ctraderConfigSchema = z.object({
  clientId: z.string().min(1), clientSecret: z.string().min(1), accessToken: z.string().min(1),
  accountId: z.string().regex(/^[1-9]\d*$/),
}).strict();
export type CTraderConfig = z.infer<typeof ctraderConfigSchema>;
const frameSchema = z.object({ payloadType: z.number().int(), clientMsgId: z.string().optional(), payload: z.record(z.unknown()).default({}) });
const idSchema = z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()]).transform(String);
const accountsSchema = z.object({ ctidTraderAccount: z.array(z.object({ ctidTraderAccountId: idSchema, isLive: z.boolean() })).default([]) });
const authSchema = z.object({ ctidTraderAccountId: idSchema });

/** Read-only demo bootstrap. No order payload is accepted by this connection. */
export class CTraderDemoConnection {
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<string, { expected: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private authenticated = false;
  constructor(private readonly config: CTraderConfig) { ctraderConfigSchema.parse(config); }

  async connect(): Promise<void> {
    if (this.socket) throw new Error('cTrader connection already started');
    const socket = new WebSocket('wss://demo.ctraderapi.com:5036', { handshakeTimeout: 10000 });
    this.socket = socket;
    socket.on('message', data => { this.receive((Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data).toString('utf8')); });
    socket.on('close', () => { this.fail(); });
    socket.on('error', () => { this.fail(); });
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
      const accounts = accountsSchema.parse(await this.request(2149, 2150, { accessToken: this.config.accessToken }));
      const account = accounts.ctidTraderAccount.find(item => item.ctidTraderAccountId === this.config.accountId);
      if (!account || account.isLive) throw new Error('Configured cTrader account is not an authorized demo account');
      const auth = authSchema.parse(await this.request(2102, 2103, { ctidTraderAccountId: this.config.accountId, accessToken: this.config.accessToken }));
      if (auth.ctidTraderAccountId !== this.config.accountId) throw new Error('cTrader account identity mismatch');
      this.authenticated = true;
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

  private request(type: number, expected: number, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('cTrader connection is closed'));
    // Explicit allowlist prevents this diagnostic connection from submitting any trade.
    if (![2100, 2149, 2102, 2114, 2124].includes(type)) return Promise.reject(new Error('Unsupported diagnostic request'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('cTrader request timed out')); }, 10000);
      this.pending.set(id, { expected, resolve, reject, timer });
      socket.send(JSON.stringify({ clientMsgId: id, payloadType: type, payload }), error => {
        if (error) this.fail();
      });
    });
  }
  private receive(raw: string): void {
    let frame: z.infer<typeof frameSchema>;
    try { frame = frameSchema.parse(JSON.parse(raw) as unknown); }
    catch { this.close(); return; }
    if ([2147, 2148, 2164].includes(frame.payloadType)) { this.close(); return; }
    if (!frame.clientMsgId) return;
    const pending = this.pending.get(frame.clientMsgId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.clientMsgId);
    if (frame.payloadType !== pending.expected) pending.reject(new Error('cTrader rejected the diagnostic request'));
    else pending.resolve(frame.payload);
  }
  private fail(): void {
    this.authenticated = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('cTrader connection interrupted')); }
    this.pending.clear();
  }
  close(): void { this.fail(); this.socket?.terminate(); this.socket = undefined; }
}
