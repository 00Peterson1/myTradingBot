import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CTraderDemoConnection } from '../../../src/cfd/ctrader/DemoConnection.js';
import { CTraderDemoBroker } from '../../../src/cfd/ctrader/Broker.js';
import { CfdLedger } from '../../../src/cfd/CfdLedger.js';
import type { CfdOrder } from '../../../src/cfd/types.js';
import type { Wire } from '../../../src/cfd/ctrader/Protocol.js';

const resources: (() => void)[] = [];
afterEach(() => { for (const dispose of resources.splice(0)) dispose(); });
async function fixture() {
  const db = new Database(':memory:');
  const connection = new CTraderDemoConnection({ clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture', accountId: '123' });
  const ledger = new CfdLedger(db, { provider: 'CTRADER', mode: 'DEMO', id: '123' });
  let event: (type: number, payload: Wire) => void = () => undefined;
  vi.spyOn(connection, 'onEvent').mockImplementation(listener => { event = listener; return () => undefined; });
  vi.spyOn(connection, 'catalogue').mockResolvedValue({ version: 1, provider: 'CTRADER', environment: 'DEMO', accountId: '123', capturedAt: new Date().toISOString(),
    symbols: [{ symbolId: '101', symbolName: 'BTCUSD', enabled: true, baseAssetId: '31', quoteAssetId: '15', symbolCategoryId: '1' }],
    categories: [{ id: '1', assetClassId: '1', name: 'Cryptos' }], assetClasses: [{ id: '1', name: 'Cryptocurrencies' }], archivedSymbols: [] });
  const state = { brokerOrder: null as Wire | null, deals: [] as Wire[], positions: [] as Wire[], loseAck: false, partial: false, calls: [] as number[] };
  const read = vi.spyOn(connection, 'read').mockImplementation((type, payload) => {
    state.calls.push(type);
    if (type === 2112) return Promise.resolve({ asset: [{ assetId: 15, name: 'USD' }, { assetId: 31, name: 'BTC' }] });
    if (type === 2121) return Promise.resolve({ trader: { ctidTraderAccountId: 123, depositAssetId: 15, balance: 100000, moneyDigits: 2, accountType: 0, accessRights: 0 } });
    if (type === 2116) return Promise.resolve({ symbol: [{ symbolId: 101, lotSize: 100, digits: 3, minVolume: 1, maxVolume: 500, stepVolume: 1,
      slDistance: 4, tpDistance: 4, distanceSetIn: 2, enableShortSelling: true, tradingMode: 0, preciseTradingCommissionRate: 0, preciseMinCommission: 0 }] });
    if (type === 2124) return Promise.resolve({ position: state.positions, order: [] });
    if (type === 2187) return Promise.resolve({ moneyDigits: 2, positionUnrealizedPnL: state.positions.map(row => ({ positionId: row.positionId, netUnrealizedPnL: -5, grossUnrealizedPnL: -5 })) });
    if (type === 2127) { event(2131, { symbolId: 101, bid: 7000000000, ask: 7000100000, timestamp: Date.now() }); return Promise.resolve({}); }
    if (type === 2139) return Promise.resolve({ moneyDigits: 2, margin: [{ volume: (payload?.volume as number[])[0], buyMargin: 700, sellMargin: 701 }] });
    if (type === 2181) return Promise.resolve({ order: state.brokerOrder, deal: state.deals });
    if (type === 2175) return Promise.resolve({ hasMore: false, order: state.brokerOrder ? [state.brokerOrder] : [] });
    throw new Error(`Unexpected fixture read ${String(type)}`);
  });
  const trade = vi.spyOn(connection, 'trade').mockImplementation((type, payload) => {
    state.brokerOrder = { orderId: 44, orderStatus: state.partial ? 5 : 2, clientOrderId: payload.clientOrderId,
      positionId: 55, closingOrder: type === 2111, tradeData: { symbolId: 101, volume: payload.volume, tradeSide: 1 } };
    state.deals = [{ dealId: 77, orderId: 44, positionId: 55, symbolId: 101, filledVolume: state.partial ? 1 : payload.volume,
      dealStatus: 2, executionPrice: 70001, commission: -3, moneyDigits: 2, executionTimestamp: Date.now() }];
    if (state.loseAck) return Promise.reject(new Error('Connection lost after broker received request'));
    // Immediate acknowledgement only; the authoritative details are retrieved separately.
    return Promise.resolve({ executionType: 2, order: { ...state.brokerOrder, orderStatus: 1 } });
  });
  const broker = new CTraderDemoBroker(connection, db, ledger);
  resources.push(() => { broker.dispose(); db.close(); });
  await broker.initialize();
  const order: CfdOrder = { product: 'CFD', clientOrderId: randomUUID(), hypothesisId: 'fixture', symbol: 'BTCUSD', side: 'LONG', volumeLots: 0.02,
    stopLoss: 69950, takeProfit: null, maxSlippagePoints: 1000, createdAtMs: Date.now() };
  return { broker, ledger, order, state, read, trade };
}
describe('actual cTrader demo adapter with protocol fixtures', () => {
  it('uses broker volume/money/distance units and refuses order submission without a durable intent', async () => {
    const { broker, order, trade } = await fixture();
    expect(await broker.instrument('BTCUSD')).toMatchObject({ contractSize: 1, volumeMin: 0.01, volumeStep: 0.01, priceTick: 0.001, minStopDistanceFraction: 0.0004 });
    expect((await broker.snapshot()).account).toMatchObject({ mode: 'DEMO', balance: 1000, equity: 1000, currency: 'USD' });
    expect(await broker.estimateMargin(order, 70001)).toBe(7);
    await expect(broker.submit(order)).rejects.toThrow('intent');
    expect(trade).not.toHaveBeenCalled();
  });
  it('does not confuse ACCEPTED with FILLED and submits an atomic protected market-range order', async () => {
    const { broker, ledger, order, trade, state } = await fixture(); ledger.begin({ kind: 'OPEN', order });
    expect(await broker.submit(order)).toMatchObject({ status: 'FILLED', fill: { orderId: '44', positionId: '55', filledLots: 0.02, commission: 0.03 } });
    expect(state.calls).toContain(2181);
    expect(trade).toHaveBeenCalledWith(2106, expect.objectContaining({ orderType: 5, volume: 2, stopLoss: 69950, timeInForce: 3 }));
    await broker.submit(order);
    expect(trade).toHaveBeenCalledTimes(1);
  });
  it('recovers a lost opening acknowledgement using client identity, without resending', async () => {
    const { broker, ledger, order, trade, state } = await fixture(); state.loseAck = true; ledger.begin({ kind: 'OPEN', order });
    expect((await broker.submit(order)).status).toBe('UNKNOWN');
    const evidence = await broker.orderEvidence({ kind: 'OPEN', order });
    expect(evidence).toMatchObject({ state: 'FILLED', completeDealHistory: true, brokerOrderId: '44' });
    expect(trade).toHaveBeenCalledTimes(1);
  });
  it('preserves terminal partial fills and refuses a mismatched receipt', async () => {
    const { broker, ledger, order, state } = await fixture(); state.partial = true; ledger.begin({ kind: 'OPEN', order });
    expect(await broker.submit(order)).toMatchObject({ status: 'PARTIAL', fill: { filledLots: 0.01 } });
    const evidence = await broker.orderEvidence({ kind: 'OPEN', order });
    expect(evidence?.state).toBe('CANCELLED');
    state.deals[0]!.symbolId = 999;
    await expect(broker.orderEvidence({ kind: 'OPEN', order })).rejects.toThrow('identity');
  });
});
