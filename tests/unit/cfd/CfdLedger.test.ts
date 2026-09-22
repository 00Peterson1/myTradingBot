import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { CfdLedger } from '../../../src/cfd/CfdLedger.js';
import { CfdSubmissionService } from '../../../src/cfd/CfdSubmissionService.js';
import type { CfdBroker, CfdOrder } from '../../../src/cfd/types.js';
const identity = { provider: 'PAPER', id: 'fixture', mode: 'PAPER' } as const;
const order = (): CfdOrder => ({ product: 'CFD', clientOrderId: randomUUID(), hypothesisId: 'fixture', symbol: 'EURUSD', side: 'LONG', volumeLots: 0.1, stopLoss: 1, takeProfit: null, maxSlippagePoints: 1, createdAtMs: 1000 });
const fill = { orderId: 'broker-order', positionId: 'position', filledLots: 0.1, price: 1.1, commission: 0.3, timeMs: 1000 };
type FixtureBroker = { [K in keyof CfdBroker]: Mock<CfdBroker[K]> };
function fixtureBroker(): FixtureBroker {
  return { snapshot: vi.fn().mockResolvedValue({ account: { ...identity, currency: 'USD', balance: 10000, equity: 10000, margin: 0, freeMargin: 10000, tradeAllowed: true, hedging: true, timeMs: 1000 }, positions: [] }),
    instrument: vi.fn(), quote: vi.fn(), estimateMargin: vi.fn(), estimateProfit: vi.fn(), submit: vi.fn().mockResolvedValue({ status: 'FILLED', fill }), close: vi.fn().mockResolvedValue({ status: 'FILLED', fill }) };
}
describe('durable CFD submission boundary', () => {
  it('commits before submission and returns the durable result for concurrent duplicate requests', async () => {
    const db = new Database(':memory:');
    try {
      const ledger = new CfdLedger(db, identity), broker = fixtureBroker(), request = { kind: 'OPEN', order: order() } as const;
      vi.mocked(broker.submit).mockImplementation(() => {
        expect(ledger.find(request.order.clientOrderId)?.status).toBe('SUBMITTING');
        return Promise.resolve({ status: 'FILLED', fill });
      });
      const service = new CfdSubmissionService(broker, ledger);
      const results = await Promise.all([service.dispatch(request), service.dispatch(request)]);
      expect(results[0]).toEqual(results[1]);
      expect(broker.submit).toHaveBeenCalledTimes(1);
      expect(() => ledger.begin({ ...request, order: { ...request.order, volumeLots: 0.2 } })).toThrow('different request');
      expect(() => db.exec('DELETE FROM cfd_events')).toThrow('append-only');
      expect(() => db.exec('UPDATE cfd_events SET kind=\'x\'')).toThrow('append-only');
    } finally { db.close(); }
  });
  it('persists uncertain submission across a real database reopen and never retries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cfd-ledger-')), path = join(directory, 'test.db');
    const request = { kind: 'OPEN', order: order() } as const;
    const initial = new Database(path);
    new CfdLedger(initial, identity).begin(request);
    initial.close();
    const db = new Database(path);
    try {
      const ledger = new CfdLedger(db, identity), broker = fixtureBroker();
      expect(ledger.recover()).toBe(1);
      expect(ledger.recover()).toBe(0);
      expect((await new CfdSubmissionService(broker, ledger).dispatch(request)).status).toBe('UNKNOWN');
      expect(broker.submit).not.toHaveBeenCalled();
      expect(() => ledger.begin({ kind: 'OPEN', order: order() })).toThrow('reconciliation');
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('treats lost responses and malformed full fills as unknown, not rejected', async () => {
    for (const malformed of [false, true]) {
      const db = new Database(':memory:');
      try {
        const ledger = new CfdLedger(db, identity), broker = fixtureBroker(), request = { kind: 'OPEN', order: order() } as const;
        if (malformed) vi.mocked(broker.submit).mockResolvedValue({ status: 'FILLED', fill: { ...fill, filledLots: 0.05 } });
        else vi.mocked(broker.submit).mockRejectedValue(new Error('Connection lost after acceptance'));
        expect((await new CfdSubmissionService(broker, ledger).dispatch(request)).status).toBe('UNKNOWN');
        expect(ledger.find(request.order.clientOrderId)?.status).toBe('UNKNOWN');
      } finally { db.close(); }
    }
  });
  it('locks after partial fills and rejects mismatched close positions atomically', () => {
    const db = new Database(':memory:');
    try {
      const ledger = new CfdLedger(db, identity), id = randomUUID();
      ledger.begin({ kind: 'CLOSE', clientOrderId: id, positionId: 'position', volumeLots: 0.1 });
      expect(() => { ledger.record(id, { status: 'FILLED', fill: { ...fill, positionId: 'wrong' } }); }).toThrow('identity');
      expect(ledger.find(id)?.status).toBe('SUBMITTING');
      ledger.record(id, { status: 'PARTIAL', fill: { ...fill, filledLots: 0.04 } });
      expect(() => ledger.begin({ kind: 'OPEN', order: order() })).toThrow('reconciliation');
    } finally { db.close(); }
  });
  it('persists and deduplicates close requests without a second broker close', async () => {
    const db = new Database(':memory:');
    try {
      const ledger = new CfdLedger(db, identity), broker = fixtureBroker();
      const request = { kind: 'CLOSE', clientOrderId: randomUUID(), positionId: 'position', volumeLots: 0.1 } as const;
      const service = new CfdSubmissionService(broker, ledger);
      expect((await service.dispatch(request)).status).toBe('FILLED');
      expect((await service.dispatch(request)).status).toBe('FILLED');
      expect(broker.close).toHaveBeenCalledTimes(1);
      expect(ledger.find(request.clientOrderId)?.status).toBe('FILLED');
    } finally { db.close(); }
  });
  it('rolls back the intent if its audit event cannot be written', () => {
    const db = new Database(':memory:');
    try {
      const ledger = new CfdLedger(db, identity);
      db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON cfd_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
      expect(() => ledger.begin({ kind: 'OPEN', order: order() })).toThrow('fixture failure');
      expect(ledger.intents()).toHaveLength(0);
    } finally { db.close(); }
  });
  it('enforces runner ownership and preserves the daily baseline across restarts', () => {
    const db = new Database(':memory:');
    try {
      const first = new CfdLedger(db, identity), restarted = new CfdLedger(db, identity);
      first.acquireRunner('first', 1000);
      expect(() => { restarted.acquireRunner('second', 2000); }).toThrow('Another CFD runner');
      restarted.acquireRunner('second', 61000);
      first.releaseRunner('first');
      expect(() => { first.acquireRunner('first', 62000); }).toThrow('Another CFD runner');
      expect(first.dailyBaseline(1000, 10000)).toBe(10000);
      expect(restarted.dailyBaseline(2000, 9000)).toBe(10000);
      expect(restarted.dailyBaseline(86400000, 9500)).toBe(9500);
      expect(() => db.exec('UPDATE cfd_daily_baselines SET equity=1')).toThrow('immutable');
    } finally { db.close(); }
  });
  it('separates account identities and refuses non-paper execution', async () => {
    const db = new Database(':memory:');
    try {
      const ledger = new CfdLedger(db, { ...identity, id: 'other' }), broker = fixtureBroker();
      await expect(new CfdSubmissionService(broker, ledger).dispatch({ kind: 'OPEN', order: order() })).rejects.toThrow('identity');
      const snapshot = await broker.snapshot();
      vi.mocked(broker.snapshot).mockResolvedValue({ ...snapshot, account: { ...snapshot.account, mode: 'DEMO' } });
      await expect(new CfdSubmissionService(broker, ledger).dispatch({ kind: 'OPEN', order: order() })).rejects.toThrow('disabled');
      expect(broker.submit).not.toHaveBeenCalled();
      expect(ledger.intents()).toHaveLength(0);
    } finally { db.close(); }
  });
});
