import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { OptionsLedger } from '../../../src/portfolio/OptionsLedger.js';
import { RiskEngine } from '../../../src/risk/RiskEngine.js';
import { resetEnvForTesting } from '../../../src/config/env.js';
import type { Signal } from '../../../src/types/signal.js';

let db: Database.Database;
let folder: string;
let file: string;
let ledger: OptionsLedger;
let risk: RiskEngine;
function signal(): Signal {
  return { id: crypto.randomUUID(), product: 'OPTIONS', hypothesisId: null, strategyVersion: '1',
    timestamp: new Date(), symbol: 'TEST', price: 100, direction: 'BUY', strategy: 'test', confidence: 0.8, metadata: {} };
}
function reserve(): ReturnType<OptionsLedger['reserve']> {
  return ledger.reserve(() => {
    const result = risk.evaluate(signal(), 'DEMO');
    if (!result.approved) throw new Error(result.reason);
    return result.approvedSignal;
  });
}
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'options-ledger-'));
  file = join(folder, 'test.db');
  db = new Database(file);
  vi.stubEnv('DEMO_TRADING', 'true'); vi.stubEnv('LIVE_TRADING', 'false');
  vi.stubEnv('LIVE_CONFIRMATION', 'false'); vi.stubEnv('STAKE_AMOUNT', '1');
  vi.stubEnv('MAX_OPEN_TRADES', '1');
  resetEnvForTesting();
  ledger = new OptionsLedger(db, 'demo-account', 'DEMO', 1000);
  risk = new RiskEngine(1000, 'USD', ledger);
});
afterEach(() => { db.close(); rmSync(folder, { recursive: true }); vi.unstubAllEnvs(); resetEnvForTesting(); });

describe('durable Options accounting', () => {
  it('reserves before submission and rejects competing exposure', () => {
    reserve();
    expect(ledger.snapshot()).toMatchObject({ cashMinor: 100000, reservedMinor: 100, availableMinor: 99900 });
    expect(() => reserve()).toThrow('OPEN_EXPOSURE_LIMIT');
  });
  it('posts purchase and settlement once, with consistent integer cash', () => {
    const intent = reserve();
    ledger.markSubmitting(intent.intent_id);
    ledger.recordPurchase(intent.intent_id, '123', 1);
    ledger.recordPurchase(intent.intent_id, '123', 1);
    expect(ledger.snapshot()).toMatchObject({ cashMinor: 99900, reservedMinor: 0, openCostMinor: 100, equityMinor: 100000 });
    expect(ledger.recordSettlement(intent.intent_id, 1.85, 0.85, () => { risk.recordTradeResult(0.85); })).toBe(true);
    expect(ledger.recordSettlement(intent.intent_id, 1.85, 0.85)).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ cashMinor: 100085, openCostMinor: 0 });
    expect(risk.getState().currentBalance).toBe(1000.85);
    expect(() => ledger.recordSettlement(intent.intent_id, 1.9, 0.9)).toThrow('Conflicting duplicate');
  });
  it('rolls back financial and audit writes when risk update fails', () => {
    const intent = reserve(); ledger.markSubmitting(intent.intent_id); ledger.recordPurchase(intent.intent_id, '123', 1);
    const snapshot = ledger.snapshot();
    expect(() => ledger.recordSettlement(intent.intent_id, 0, -1, () => { throw new Error('risk persistence failure'); })).toThrow();
    expect(ledger.snapshot()).toEqual(snapshot);
  });
  it('restores reservations and kill switches after reopening storage', () => {
    const intent = reserve(); ledger.markSubmitting(intent.intent_id); risk.activateKillSwitch('operator pause');
    db.close(); db = new Database(file);
    ledger = new OptionsLedger(db, 'demo-account', 'DEMO', 9999);
    ledger.recoverAfterRestart();
    risk = new RiskEngine(9999, 'USD', ledger);
    expect(ledger.snapshot().cashMinor).toBe(100000);
    expect(ledger.get(intent.intent_id).status).toBe('UNKNOWN');
    expect(ledger.snapshot().reservedMinor).toBe(100);
    expect(risk.getState().killSwitchActive).toBe(true);
    expect(() => reserve()).toThrow('Portfolio blocked');
  });
  it('separates demo and live accounts and prevents audit-history edits', () => {
    const live = new OptionsLedger(db, 'demo-account', 'LIVE', 10);
    reserve();
    expect(live.snapshot()).toMatchObject({ cashMinor: 1000, reservedMinor: 0 });
    expect(() => db.exec('DELETE FROM options_ledger_events')).toThrow('immutable');
  });
  it('cancels never-submitted reservations on recovery without changing cash', () => {
    const intent = reserve(); ledger.recoverAfterRestart();
    expect(ledger.get(intent.intent_id).status).toBe('CANCELLED');
    expect(ledger.snapshot()).toMatchObject({ cashMinor: 100000, reservedMinor: 0 });
  });
});
