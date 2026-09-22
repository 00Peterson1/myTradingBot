import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaperCfdBroker } from '../../../src/cfd/PaperCfdBroker.js';
import { approveCfdOrder, sizeCfdLots } from '../../../src/cfd/CfdRisk.js';
import type { CfdInstrument, CfdOrder, CfdQuote } from '../../../src/cfd/types.js';

const instrument: CfdInstrument = { symbol: 'EURUSD', category: 'forex', contractSize: 100000, volumeMin: 0.01, volumeMax: 10, volumeStep: 0.01, priceTick: 0.00001, minStopDistance: 0, profitCurrency: 'USD' };
const order = (overrides: Partial<CfdOrder> = {}): CfdOrder => ({ product: 'CFD', clientOrderId: randomUUID(), hypothesisId: 'research-only', symbol: 'EURUSD', side: 'LONG', volumeLots: 0.1, stopLoss: 1.09, takeProfit: null, maxSlippagePoints: 2, createdAtMs: 1000, ...overrides });
function broker(slippageTicks = 0): PaperCfdBroker {
  const result = new PaperCfdBroker({ initialBalance: 10000, currency: 'USD', leverage: 100, commissionPerLotPerSide: 3, slippageTicks, stopOutMarginRatio: 0.5 }, [instrument]);
  result.advance({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: 1000 });
  return result;
}

describe('CFD accounting uses executable bid/ask prices', () => {
  it('charges spread, both commissions and financing, and releases margin on close', async () => {
    const b = broker();
    const opened = await b.submit(order());
    if (opened.status !== 'FILLED') throw new Error('Expected fill');
    let state = await b.snapshot();
    expect(state.account.balance).toBeCloseTo(9999.7);
    expect(state.account.equity).toBeCloseTo(9997.7);
    expect(state.account.margin).toBeCloseTo(110.02);
    b.accrueFinancing('swap-1', opened.fill.positionId, -1.5, 1000);
    expect(() => { b.accrueFinancing('swap-1', opened.fill.positionId, -1.5, 1000); }).toThrow('already applied');
    b.advance({ symbol: 'EURUSD', bid: 1.101, ask: 1.1012, timeMs: 2000 });
    await b.close(opened.fill.positionId, 0.1, randomUUID());
    state = await b.snapshot();
    expect(state.account.balance).toBeCloseTo(10005.9);
    expect(state.account.equity).toBe(state.account.balance);
    expect(state.account.margin).toBe(0);
    expect(state.positions).toHaveLength(0);
  });
  it('fills a gapped stop at the next bid with adverse slippage', async () => {
    const b = broker(2);
    await b.submit(order());
    b.advance({ symbol: 'EURUSD', bid: 1.08, ask: 1.0802, timeMs: 3000 });
    expect(b.fills[1]?.price).toBeCloseTo(1.07998);
    expect(b.fills[1]?.reason).toBe('STOP_LOSS');
    expect((await b.snapshot()).account.balance).toBeCloseTo(9797);
  });
  it('marks shorts at ask and supports partial closes without duplicate execution', async () => {
    const b = broker();
    const request = order({ side: 'SHORT', stopLoss: 1.11 });
    const opened = await b.submit(request);
    expect(await b.submit(request)).toEqual(opened);
    if (opened.status !== 'FILLED') throw new Error('Expected fill');
    expect((await b.snapshot()).account.equity).toBeCloseTo(9997.7);
    b.advance({ symbol: 'EURUSD', bid: 1.099, ask: 1.0992, timeMs: 2000 });
    const id = randomUUID();
    const closed = await b.close(opened.fill.positionId, 0.04, id);
    expect(await b.close(opened.fill.positionId, 0.04, id)).toEqual(closed);
    expect((await b.snapshot()).positions[0]?.volumeLots).toBeCloseTo(0.06);
    expect(b.fills).toHaveLength(2);
  });
  it('retains rejections and refuses changed request identifiers', async () => {
    const b = broker(2), request = order({ maxSlippagePoints: 0 });
    expect((await b.submit(request)).status).toBe('REJECTED');
    expect(await b.submit(request)).toEqual(await b.submit(request));
    expect(() => b.submit({ ...request, maxSlippagePoints: 2 })).toThrow('reused');
    expect((await b.snapshot()).positions).toHaveLength(0);
  });
  it('requires historical currency conversion and chronological uncrossed quotes', () => {
    const b = new PaperCfdBroker({ initialBalance: 10000, currency: 'EUR', leverage: 100, commissionPerLotPerSide: 0, slippageTicks: 0, stopOutMarginRatio: 0.5 }, [instrument]);
    const quote = { symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: 1000 };
    expect(() => { b.advance(quote); }).toThrow('conversion');
    b.advance(quote, 0.9);
    expect(() => { b.advance({ ...quote, timeMs: 999 }, 0.9); }).toThrow('chronological');
    expect(() => { b.advance({ ...quote, ask: 1 }, 0.9); }).toThrow();
  });
  it('checks freshness after asynchronous quote and margin requests', async () => {
    const b = broker(), { account } = await b.snapshot();
    const policy = { maxRiskFraction: 0.02, maxMarginFraction: 0.5, maxSpreadFraction: 0.01, maxQuoteAgeMs: 5000, commissionPerLotRoundTrip: 6, maxPositions: 3, maxDailyLossFraction: 0.05 };
    const exposure = { positions: 0, reservedMargin: 0, reservedRisk: 0, dailyStartEquity: 10000 };
    let now = 1000;
    const quote = b.quote.bind(b), margin = b.estimateMargin.bind(b);
    b.quote = async (symbol): Promise<CfdQuote> => {
      now = 2000;
      b.advance({ symbol, bid: 1.1, ask: 1.1002, timeMs: now });
      return quote(symbol);
    };
    await expect(approveCfdOrder(b, order(), account, policy, exposure, () => now)).resolves.toHaveProperty('plannedLoss');
    b.estimateMargin = async (request, price): Promise<number> => { now = 7000; return margin(request, price); };
    await expect(approveCfdOrder(b, order(), account, policy, exposure, () => now)).rejects.toThrow('snapshot is stale');
  });
  it('rounds sizing down and enforces aggregate stop risk', async () => {
    expect(sizeCfdLots(109, 1000, instrument)).toBe(0.1);
    expect(() => sizeCfdLots(9, 1000, instrument)).toThrow('minimum');
    const b = broker(), { account } = await b.snapshot();
    const policy = { maxRiskFraction: 0.02, maxMarginFraction: 0.5, maxSpreadFraction: 0.01, maxQuoteAgeMs: 5000, commissionPerLotRoundTrip: 6, maxPositions: 3, maxDailyLossFraction: 0.05 };
    const exposure = { positions: 0, reservedMargin: 0, reservedRisk: 0, dailyStartEquity: 10000 };
    expect((await approveCfdOrder(b, order(), account, policy, exposure, 1000)).plannedLoss).toBeCloseTo(102.8);
    await expect(approveCfdOrder(b, order(), account, policy, { ...exposure, reservedRisk: 100 }, 1000)).rejects.toThrow('risk budget');
  });
});
