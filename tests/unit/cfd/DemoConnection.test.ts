import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ live: false, mismatch: false, tokenError: '', refreshed: false, requests: [] as number[], sockets: [] as { emit: (name: string, ...args: unknown[]) => boolean }[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); state.sockets.push(this); queueMicrotask(() => { this.emit('open'); }); }
    send(raw: string, callback?: (error?: Error) => void): void {
      const request = JSON.parse(raw) as { payloadType: number; clientMsgId: string; payload: Record<string, unknown> };
      state.requests.push(request.payloadType);
      if ('ctidTraderAccountId' in request.payload && typeof request.payload.ctidTraderAccountId !== 'number') throw new Error('cTrader JSON requires a numeric account ID');
      const responses: Record<number, { type: number; payload: unknown }> = {
        2100: { type: 2101, payload: {} },
        2149: { type: 2150, payload: { ctidTraderAccount: [{ ctidTraderAccountId: '123', isLive: state.live }] } },
        2102: { type: 2103, payload: { ctidTraderAccountId: state.mismatch ? '456' : '123' } },
        2114: { type: 2115, payload: { ctidTraderAccountId: '123', symbol: [{ symbolId: '1', symbolName: 'US SP 500', symbolCategoryId: '10', enabled: true }] } },
        2160: { type: 2161, payload: { ctidTraderAccountId: '123', symbolCategory: [{ id: '10', assetClassId: '20', name: 'US Indices' }] } },
        2153: { type: 2154, payload: { ctidTraderAccountId: '123', assetClass: [{ id: '20', name: 'Indices' }] } },
        2124: { type: 2125, payload: { ctidTraderAccountId: '123', position: [], order: [] } },
      };
      if (request.payloadType === 2173) {
        state.refreshed = true;
        queueMicrotask(() => { this.emit('message', Buffer.from(JSON.stringify({ clientMsgId: request.clientMsgId, payloadType: 2174, payload: { accessToken: 'new-fixture-access', refreshToken: 'new-fixture-refresh', expiresIn: 1000 } }))); });
        callback?.(); return;
      }
      if (request.payloadType === 2149 && state.tokenError && !state.refreshed) {
        queueMicrotask(() => { this.emit('message', Buffer.from(JSON.stringify({ clientMsgId: request.clientMsgId, payloadType: 2142, payload: { errorCode: state.tokenError } }))); });
        callback?.(); return;
      }
      const response = responses[request.payloadType];
      if (!response) throw new Error('Unexpected request');
      queueMicrotask(() => { this.emit('message', Buffer.from(JSON.stringify({ clientMsgId: request.clientMsgId, payloadType: response.type, payload: response.payload }))); });
      callback?.();
    }
    terminate(): void { this.readyState = 3; this.emit('close'); }
  }
  return { default: Socket };
});
import { CTraderDemoConnection } from '../../../src/cfd/ctrader/DemoConnection.js';
const config = { clientId: 'fixture', clientSecret: 'secret-fixture', accessToken: 'token-fixture', accountId: '123' };
beforeEach(() => { state.live = false; state.mismatch = false; state.tokenError = ''; state.refreshed = false; state.requests = []; state.sockets = []; });
describe('cTrader demo read-only authentication', () => {
  it('authorizes the selected demo account and inspects without order requests', async () => {
    const connection = new CTraderDemoConnection(config);
    try {
      await connection.connect();
      expect(await connection.inspect()).toEqual({ symbolCount: 1, positionCount: 0, pendingOrderCount: 0 });
      expect(state.requests).toEqual([2100, 2149, 2102, 2114, 2124]);
    } finally { connection.close(); }
  });
  it('discovers provider names, IDs and categories using only read-only requests', async () => {
    const connection = new CTraderDemoConnection(config);
    try {
      await connection.connect();
      const catalogue = await connection.catalogue();
      expect(catalogue.accountId).toBe('123');
      expect(catalogue.symbols[0]?.symbolName).toBe('US SP 500');
      expect(catalogue.symbols[0]?.symbolId).toBe('1');
      expect(state.requests).toEqual([2100, 2149, 2102, 2114, 2160, 2153]);
    } finally { connection.close(); }
  });
  it('ignores delayed events from an old socket after physical reconnect', async () => {
    const connection = new CTraderDemoConnection(config);
    try {
      await connection.connect();
      const oldSocket = state.sockets[0];
      if (!oldSocket) throw new Error('Missing fixture socket');
      connection.close();
      await connection.connect();
      oldSocket.emit('close');
      oldSocket.emit('error', new Error('Delayed old-session error'));
      oldSocket.emit('message', Buffer.from(JSON.stringify({ payloadType: 2164, payload: {} })));
      expect(await connection.inspect()).toEqual({ symbolCount: 1, positionCount: 0, pendingOrderCount: 0 });
    } finally { connection.close(); }
  });
  it('keeps diagnostic order capability disabled after authentication', async () => {
    const connection = new CTraderDemoConnection(config);
    try {
      await connection.connect();
      await expect(connection.trade(2106, {})).rejects.toThrow('disabled');
      expect(state.requests).not.toContain(2106);
    } finally { connection.close(); }
  });
  it('renews an explicitly rejected token and persists the replacement before authenticating', async () => {
    state.tokenError = 'OA_AUTH_TOKEN_EXPIRED';
    const save = vi.fn(() => { expect(state.requests.at(-1)).toBe(2173); return Promise.resolve(); });
    const connection = new CTraderDemoConnection({ ...config, refreshToken: 'fixture-refresh' }, { saveTokens: save });
    try {
      await connection.connect();
      expect(save).toHaveBeenCalledWith({ accessToken: 'new-fixture-access', refreshToken: 'new-fixture-refresh', expiresIn: 1000 });
      expect(state.requests).toEqual([2100, 2149, 2173, 2149, 2102]);
    } finally { connection.close(); }
  });
  it('does not rotate credentials for a server outage or without durable token storage', async () => {
    state.tokenError = 'CH_SERVER_NOT_REACHABLE';
    const connection = new CTraderDemoConnection({ ...config, refreshToken: 'fixture-refresh' }, { saveTokens: () => Promise.resolve() });
    await expect(connection.connect()).rejects.toThrow('authentication failed');
    expect(state.requests).not.toContain(2173);
    state.tokenError = 'OA_AUTH_TOKEN_EXPIRED';
    const noStorage = new CTraderDemoConnection({ ...config, refreshToken: 'fixture-refresh' });
    await expect(noStorage.connect()).rejects.toThrow('authentication failed');
    expect(state.requests).not.toContain(2173);
  });
  it('refuses live account selection before account authorization', async () => {
    state.live = true;
    const connection = new CTraderDemoConnection(config);
    await expect(connection.connect()).rejects.toThrow('authentication failed');
    expect(state.requests).toEqual([2100, 2149]);
    await expect(connection.inspect()).rejects.toThrow('not authenticated');
  });
  it('refuses mismatched authenticated account identity', async () => {
    state.mismatch = true;
    const connection = new CTraderDemoConnection(config);
    await expect(connection.connect()).rejects.toThrow('authentication failed');
    await expect(connection.inspect()).rejects.toThrow('not authenticated');
  });
});
