import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cfdDatasetIdentity } from '../../../src/cfd/CfdDataset.js';
import { cfdBacktestConfigSchema } from '../../../src/cfd/CfdBacktest.js';
import { CfdDemoRunner } from '../../../src/cfd/CfdDemoRunner.js';
import { CfdLedger } from '../../../src/cfd/CfdLedger.js';
import { CfdExecutionController, type ReconcilingCfdBroker } from '../../../src/cfd/CfdExecutionController.js';
import { PaperCfdBroker } from '../../../src/cfd/PaperCfdBroker.js';
import type { ApprovedCfdStrategy } from '../../../src/cfd/CfdDeployment.js';
import { cfdDirection } from '../../../src/cfd/CfdSignal.js';

const dataset = cfdDatasetIdentity(JSON.parse(readFileSync('examples/cfd/fixture.json', 'utf8')) as unknown).dataset;
const base = cfdBacktestConfigSchema.parse(JSON.parse(readFileSync('examples/cfd/config.json', 'utf8')) as unknown);
describe('continuous CFD demo runner mechanics, software fixtures only', () => {
  it('shares causal signal rules and uses preceding observations only', () => {
    expect(cfdDirection([1, 1, 1], 1.01, { family: 'MOMENTUM', lookback: 3, threshold: 0.001 })).toBe('LONG');
    expect(cfdDirection([1, 1, 1], 1.01, { family: 'MEAN_REVERSION', lookback: 3, threshold: 0.001 })).toBe('SHORT');
    expect(cfdDirection([1, 1], 2, { family: 'BREAKOUT', lookback: 3, threshold: 0.001 })).toBeNull();
  });
  it('waits for the next quote, sizes to cash limits, closes on holding limit and respects pause/revocation', async () => {
    const db = new Database(':memory:');
    const config = { ...base, lookback: 3, threshold: 0.0001, stopFraction: 0.001, maxHoldingQuotes: 2, maxGapMs: 10000 };
    const paper = new PaperCfdBroker({ initialBalance: 10000, currency: 'USD', leverage: 100, commissionPerLotPerSide: 0, slippageTicks: 0, stopOutMarginRatio: 0.5 }, [dataset.instrument]);
    const original = paper.snapshot.bind(paper);
    const broker: ReconcilingCfdBroker = Object.assign(paper, { orderEvidence: () => Promise.resolve(null) });
    broker.snapshot = async () => { const state = await original(); return { ...state, account: { ...state.account, id: '123', provider: 'FIXTURE', mode: 'DEMO' as const } }; };
    let now = 1000, paused = false, revoked = false;
    const deployment = { version: 1 as const, mode: 'DEMO' as const, accountId: '123', symbol: 'EURUSD', hypothesisId: 'a'.repeat(64), studyId: 'b'.repeat(64), studyAttemptId: 'fixture', batchId: 'c'.repeat(64), batchAttemptId: 'fixture', reviewId: 'd'.repeat(64), reviewAttemptId: 'fixture', expiresAt: '2099-01-01T00:00:00.000Z', maxLots: 0.1, maxPlannedLoss: 5, pollIntervalMs: 1000 };
    const strategy: ApprovedCfdStrategy = { config, dataset, deployment };
    const ledger = new CfdLedger(db, { provider: 'FIXTURE', id: '123', mode: 'DEMO' });
    const controller = new CfdExecutionController(broker, ledger, config.risk, 10000, { demoAccountId: '123', externalPositions: 'COEXIST', now: () => now, authorizeHypothesis: () => Promise.resolve() });
    const runner = new CfdDemoRunner(db, broker, controller, ledger, () => { if (revoked) throw new Error('Revoked approval'); return strategy; }, () => paused, () => now);
    const advance = async (bid: number): Promise<string> => { now += 1000; paper.advance({ symbol: 'EURUSD', bid, ask: bid + 0.0001, timeMs: now }); return runner.step(); };
    try {
      await advance(1.1); await advance(1.1002); await advance(1.1004);
      expect(await advance(1.1006)).toBe('SIGNAL_WAITING_FOR_NEXT_QUOTE');
      expect(ledger.intents()).toHaveLength(0);
      expect(await runner.step()).toBe('WAITING_FOR_NEW_QUOTE');
      expect(await advance(1.1008)).toBe('OPEN_RESULT');
      expect((await broker.snapshot()).positions).toHaveLength(1);
      await advance(1.1008);
      expect(await advance(1.1008)).toBe('CLOSE_RESULT');
      expect((await broker.snapshot()).positions).toHaveLength(0);
      paused = true; expect(await runner.step()).toBe('PAUSED');
      paused = false; revoked = true; await expect(runner.step()).rejects.toThrow('Revoked');
      expect(ledger.intents()).toHaveLength(2);
    } finally { controller.dispose(); db.close(); }
  });
});
