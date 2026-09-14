import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OptionsLedger } from '../../../src/portfolio/OptionsLedger.js';
import { SimulatedExecutionEngine } from '../../../src/execution/SimulatedExecutionEngine.js';
import { money } from '../../../src/types/product.js';
import type { ApprovedSignal } from '../../../src/types/signal.js';
import type { Tick } from '../../../src/types/tick.js';

let db: Database.Database;
let ledger: OptionsLedger;
function tick(epoch: number, price = 100): Tick {
  return { symbol: 'TEST', epoch, timestamp: new Date(epoch * 1000), price };
}
function approved(duration = 5, unit: 't' | 's' = 't'): ApprovedSignal {
  return {
    signal: { id: crypto.randomUUID(), product: 'OPTIONS', hypothesisId: null, strategyVersion: '1',
      timestamp: new Date(0), symbol: 'TEST', price: 100, direction: 'BUY', strategy: 'test', confidence: 1, metadata: {} },
    optionSpecification: { product: 'OPTIONS', symbol: 'TEST', contractType: 'CALL', duration,
      durationUnit: unit, basis: 'stake', stake: money(1, 'USD', 2) },
    stakeAmount: 1, contractDuration: duration, contractDurationUnit: unit, approvedAt: new Date(0), riskNotes: 'test',
  };
}
beforeEach(() => { db = new Database(':memory:'); ledger = new OptionsLedger(db, 'simulation', 'BACKTEST', 10); });
afterEach(() => { db.close(); });
describe('ledger-backed Options simulation', () => {
  it('debits immediately and credits only at the fifth subsequent tick', () => {
    const engine = new SimulatedExecutionEngine(ledger, { payoutMultiplier: 0.85, feePerTrade: 0.1 });
    engine.execute(approved(), tick(0));
    expect(ledger.snapshot().cashMinor).toBe(890);
    const profits: number[] = [];
    for (let i = 1; i < 5; i++) expect(engine.onTick(tick(i, 101), profit => { profits.push(profit); })).toEqual([]);
    expect(ledger.snapshot().cashMinor).toBe(890);
    expect(engine.onTick(tick(5, 101), profit => { profits.push(profit); })).toMatchObject([{ profit: 0.75, payout: 1.85 }]);
    expect(profits).toEqual([0.75]);
    expect(ledger.snapshot().cashMinor).toBe(1075);
    expect(engine.onTick(tick(6, 101), profit => { profits.push(profit); })).toEqual([]);
  });
  it('does not use a quote arriving after a time expiry to determine the outcome', () => {
    const engine = new SimulatedExecutionEngine(ledger, { payoutMultiplier: 0.85, feePerTrade: 0 });
    engine.execute(approved(5, 's'), tick(0));
    engine.onTick(tick(4, 99), () => undefined);
    expect(engine.onTick(tick(6, 200), () => undefined)).toMatchObject([{ exitPrice: 99, profit: -1, exitTime: new Date(5000) }]);
    expect(ledger.snapshot().cashMinor).toBe(900);
  });
  it('uses the quote at the exact expiry and treats a strict rise tie as a loss', () => {
    const engine = new SimulatedExecutionEngine(ledger, { payoutMultiplier: 0.85, feePerTrade: 0 });
    engine.execute(approved(5, 's'), tick(0));
    expect(engine.onTick(tick(5), () => undefined)).toMatchObject([{ won: false, profit: -1 }]);
  });
  it('does not reserve unaffordable fees or accept fractional-cent fees', () => {
    const engine = new SimulatedExecutionEngine(ledger, { payoutMultiplier: 0.85, feePerTrade: 10 });
    expect(() => engine.execute(approved(), tick(0))).toThrow();
    expect(ledger.snapshot().cashMinor).toBe(1000);
    expect(ledger.snapshot().reservedMinor).toBe(0);
    expect(() => new SimulatedExecutionEngine(ledger, { payoutMultiplier: 0.85, feePerTrade: 0.001 })).toThrow();
  });
});
