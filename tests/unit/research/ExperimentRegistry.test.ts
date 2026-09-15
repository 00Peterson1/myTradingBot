import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ExperimentRegistry, canonicalJson, contentHash, readExperimentBundle } from '../../../src/research/experiments/ExperimentRegistry.js';
import { BacktestEngine } from '../../../src/backtest/BacktestEngine.js';
import { FeatureEngine } from '../../../src/features/FeatureEngine.js';
import { makeSignal, type Strategy } from '../../../src/strategies/base/Strategy.js';
let db: Database.Database;
let registry: ExperimentRegistry;
beforeEach(() => { db = new Database(':memory:'); registry = new ExperimentRegistry(db, { 'src/test.ts': 'version 1' }); });
afterEach(() => { db.close(); });
describe('immutable experiment registry', () => {
  it('assigns stable experiment identity and distinct attempt identities', () => {
    const first = registry.begin([{ price: 100 }], { b: 2, a: 1 });
    const second = registry.begin([{ price: 100 }], { a: 1, b: 2 });
    expect(first.experimentId).toBe(second.experimentId);
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(registry.begin([{ price: 101 }], { a: 1, b: 2 }).experimentId).not.toBe(first.experimentId);
    expect(registry.begin([{ price: 100 }], { a: 2, b: 2 }).experimentId).not.toBe(first.experimentId);
    const changedCode = new ExperimentRegistry(db, { 'src/test.ts': 'version 2' });
    expect(changedCode.begin([{ price: 100 }], { a: 1, b: 2 }).experimentId).not.toBe(first.experimentId);
  });
  it('exports verified artifacts and records unfinished attempts explicitly', () => {
    const registered = registry.begin([{ price: 100 }], { candidate: 'test' });
    expect(readExperimentBundle(db, registered.experimentId)).toMatchObject({
      dataset: [{ price: 100 }], code: { 'src/test.ts': 'version 1' },
      attempts: [{ id: registered.attemptId, status: 'UNFINISHED' }],
    });
    const hypothesisId = registry.registerHypothesis({ candidate: 'test' });
    registry.claimHoldout([{ symbol: 'TEST', timestamp: '2026-01-01T00:00:00.000Z', price: 100 }], hypothesisId);
    expect(() => registry.claimHoldout([{ symbol: 'TEST', timestamp: '2026-01-01T00:00:00.000Z', price: 100 }], hypothesisId)).toThrow('UNIQUE');
    expect(() => registry.claimHoldout([{ symbol: 'TEST', timestamp: '2026-01-01T00:00:00.000Z', price: 101 }], hypothesisId)).toThrow('overlaps');
  });
  it('preserves ordered datasets and rejects erased or nonfinite manifest fields', () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
    expect(() => canonicalJson({ missing: undefined })).toThrow();
    expect(() => canonicalJson({ invalid: Infinity })).toThrow();
    expect(() => registry.begin([], { invalid: NaN })).toThrow();
    expect(db.prepare('SELECT id FROM experiment_attempts').all()).toHaveLength(0);
    expect(db.prepare('SELECT id FROM experiment_artifacts').all()).toHaveLength(0);
  });
  it('retains failed attempts and prohibits rewriting history or completing twice', () => {
    const { attemptId } = registry.begin([], {});
    registry.finish(attemptId, 'FAILED', { reason: 'insufficient data' });
    expect(() => { registry.finish(attemptId, 'COMPLETED', {}); }).toThrow();
    expect(() => db.exec('DELETE FROM experiment_attempts')).toThrow('immutable');
    expect(() => db.exec("UPDATE experiment_outcomes SET status='COMPLETED'")).toThrow('immutable');
  });
  it('registers actual engine successes and failed evaluations', async () => {
    const features = new FeatureEngine('TEST');
    const rows = Array.from({ length: 6 }, (_, epoch) => features.process({ symbol: 'TEST', price: 100, epoch, timestamp: new Date(epoch * 1000) }));
    const run = (learner: boolean): ReturnType<BacktestEngine['run']> => new BacktestEngine({
      strategyFactory: (): Strategy => ({ name: 'fixture', description: 'test', ...(learner ? { isOnlineLearner: true as const } : {}),
        generateSignal: (current): ReturnType<typeof makeSignal> => makeSignal('fixture', current, 'NONE', 0) }),
      strategyName: 'fixture', symbol: 'TEST', payoutMultiplier: 0.85, feePerTrade: 0, minConfidence: 0.5,
      contextWindow: 20, registry, strategyDeclaration: { learner },
    }).run(rows, new Date(0), new Date(1000), new Date(2000), new Date(3000), new Date(4000), new Date(5000));
    const success = await run(false);
    expect(success.experimentId).toHaveLength(64);
    await expect(run(true)).rejects.toThrow('Online learners');
    expect(db.prepare('SELECT status FROM experiment_outcomes ORDER BY rowid').all()).toEqual([{ status: 'COMPLETED' }, { status: 'FAILED' }]);
  });
});
