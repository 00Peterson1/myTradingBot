import { assertDefined } from '../../../src/utils/assertDefined.js';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationStudy, type StudyCandidate } from '../../../src/backtest/ValidationStudy.js';
import { WalkForwardRunner, type WalkForwardResult } from '../../../src/backtest/WalkForwardRunner.js';
import { BacktestEngine } from '../../../src/backtest/BacktestEngine.js';
import { ExperimentRegistry } from '../../../src/research/experiments/ExperimentRegistry.js';
import { FeatureEngine } from '../../../src/features/FeatureEngine.js';
import { makeSignal, type Strategy } from '../../../src/strategies/base/Strategy.js';
import type { BacktestRun } from '../../../src/types/backtest.js';
let db: Database.Database;
let registry: ExperimentRegistry;
const factory = (): Strategy => ({ name: 'fixture', description: 'test', generateSignal: current => makeSignal('fixture', current, 'NONE', 0) });
function candidate(id: string): StudyCandidate {
  return { id, family: 'declared-neighbors', config: { strategyFactory: factory, strategyName: id, strategyDeclaration: { id },
    symbol: 'TEST', payoutMultiplier: 0.85, feePerTrade: 0, minConfidence: 0.5, contextWindow: 200 } };
}
function result(id: string, negative = false): WalkForwardResult {
  const config = candidate(id).config;
  const observations = Array.from({ length: 120 }, (_, i) => ({ timestamp: new Date((1000 + i) * 1000), symbol: 'TEST',
    entryPrice: 100, exitPrice: 101, direction: 'BUY' as const, stake: 1,
    profit: negative ? -1 : i % 2 ? -0.1 : id === 'a' ? 0.5 : 0.51,
    returnPct: negative ? -1 : i % 2 ? -0.1 : id === 'a' ? 0.5 : 0.51, won: !negative && i % 2 === 0 }));
  const metrics = new BacktestEngine(config).computeMetrics(observations, 'BACKTEST', new Date(1000000), new Date(1200000), 2);
  const run: BacktestRun = { id, createdAt: new Date(0), strategy: id, symbol: 'TEST', parameters: {}, trainFrom: new Date(0), trainTo: new Date(1000),
    validateFrom: new Date(2000), validateTo: new Date(3000), testFrom: new Date(1000000), testTo: new Date(1200000),
    trainMetrics: metrics, validateMetrics: metrics, testMetrics: metrics, observations };
  return { strategy: id, symbol: 'TEST', config: { trainFraction: 0.6, validateFraction: 0.2, testFraction: 0.2, numFolds: 2, minTradesPerFold: 10 },
    folds: [0, 1].map(foldIndex => ({ foldIndex, trainFrom: run.trainFrom, trainTo: run.trainTo, validateFrom: run.validateFrom,
      validateTo: run.validateTo, testFrom: run.testFrom, testTo: run.testTo, run })), aggregatedTestMetrics: metrics,
    pbo: null, pboInterpretation: 'unavailable', passesRigorousValidation: false, validationNotes: [] };
}
beforeEach(() => { db = new Database(':memory:'); registry = new ExperimentRegistry(db, { fixture: 'v1' }); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function events(): ReturnType<FeatureEngine['process']>[] {
  const features = new FeatureEngine('TEST');
  return Array.from({ length: 2000 }, (_, epoch) => features.process({ symbol: 'TEST', price: 100, epoch, timestamp: new Date(epoch * 1000) }));
}
function study(): ValidationStudy { return new ValidationStudy(registry, { trainFraction: 0.6, validateFraction: 0.2, testFraction: 0.2, numFolds: 2, minTradesPerFold: 10 }); }
describe('sealed final holdout and sensitivity selection', () => {
  it('integrates real folds without counting each fold as a new hypothesis', async () => {
    const outcome = await study().run(events(), [candidate('a'), candidate('b')]);
    expect(outcome.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(registry.countHypotheses()).toBe(2);
    expect(db.prepare('SELECT * FROM experiment_outcomes').all()).toHaveLength(5);
    const studyOutcome = db.prepare("SELECT content FROM experiment_outcomes WHERE json_extract(content,'$.verdict') IS NOT NULL").get() as { content: string };
    expect(JSON.parse(studyOutcome.content)).toMatchObject({ verdict: 'INSUFFICIENT_EVIDENCE', selectedId: null, trials: 2 });
    expect(db.prepare('SELECT * FROM research_holdout_claims').all()).toEqual([]);
  });
  it('hides the final 20% from selection and consumes it only once', async () => {
    const development = vi.spyOn(WalkForwardRunner.prototype, 'run').mockImplementation((features, config) => {
      expect(features).toHaveLength(1600);
      return Promise.resolve(result(config.strategyName));
    });
    const final = vi.spyOn(BacktestEngine.prototype, 'run').mockResolvedValue(assertDefined(result('b').folds[0]).run);
    const rows = events();
    const outcome = await study().run(rows, [candidate('a'), candidate('b')]);
    expect(development).toHaveBeenCalledTimes(2);
    expect(outcome.selectedId).toBe('b');
    expect(final).toHaveBeenCalledTimes(1);
    expect(final.mock.calls[0]?.[5]).toEqual(new Date(1600000));
    await expect(study().run(rows, [candidate('a'), candidate('b')])).rejects.toThrow('UNIQUE');
    expect(final).toHaveBeenCalledTimes(1);
  });
  it('does not open the holdout when a predeclared neighboring parameter fails', async () => {
    vi.spyOn(WalkForwardRunner.prototype, 'run').mockImplementation((_features, config) => Promise.resolve(result(config.strategyName, config.strategyName === 'a')));
    const final = vi.spyOn(BacktestEngine.prototype, 'run');
    const outcome = await study().run(events(), [candidate('a'), candidate('b')]);
    expect(outcome.selectedId).toBeNull();
    expect(final).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM research_holdout_claims').all()).toEqual([]);
  });
});
