import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv, resetEnvForTesting } from '../../../src/config/env.js';
import { BacktestEngine } from '../../../src/backtest/BacktestEngine.js';
import { strategyFactories } from '../../../src/strategies/catalogue.js';
import { ExperimentRegistry, captureResearchCode } from '../../../src/research/experiments/ExperimentRegistry.js';
import { StrategyLifecycle } from '../../../src/research/experiments/StrategyLifecycle.js';
import { loadEligibleStrategies } from '../../../src/execution/EligibleStrategies.js';
import { FeatureEngine } from '../../../src/features/FeatureEngine.js';
import { assertDefined } from '../../../src/utils/assertDefined.js';
let db: Database.Database;
let lifecycle: StrategyLifecycle;
let registry: ExperimentRegistry;
beforeEach(() => {
  vi.stubEnv('MARKET_SCOPE', 'ALL'); vi.stubEnv('STAKE_AMOUNT', '1'); resetEnvForTesting();
  db = new Database(':memory:');
  registry = new ExperimentRegistry(db, captureResearchCode(fileURLToPath(new URL('../../../', import.meta.url))));
  lifecycle = new StrategyLifecycle(db);
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); resetEnvForTesting(); });
function fixture(): string {
  const entry = assertDefined(strategyFactories[0]);
  const env = getEnv();
  const declaration = new BacktestEngine({ strategyFactory: entry.factory, strategyName: entry.name, strategyDeclaration: { catalogKey: entry.name, version: 1 },
    symbol: 'TEST', payoutMultiplier: env.BACKTEST_PAYOUT_MULTIPLIER, feePerTrade: 0, minConfidence: env.MIN_CONSENSUS_CONFIDENCE,
    contextWindow: 200, contractDuration: env.CONTRACT_DURATION, contractDurationUnit: env.CONTRACT_DURATION_UNIT }).declaration();
  const id = registry.registerHypothesis(declaration);
  const runs = [0, 1, 2].map(period => {
    const run = registry.begin([], { ...declaration, periods: [period] });
    registry.finish(run.attemptId, 'COMPLETED', { observations: [] });
    return run.experimentId;
  });
  const study = registry.begin([], { policy: 'fixture' }, 'VALIDATION_STUDY');
  registry.finish(study.attemptId, 'COMPLETED', { verdict: 'HOLDOUT_SUPPORTED', selectedId: entry.name, finalExperimentId: runs[2],
    candidates: [{ id: entry.name, eligible: true, adjustedPValue: 0.01, foldExperiments: runs.slice(0, 2) }] });
  lifecycle.transition(id, 'BACKTESTED', 'fixture', runs[0]);
  for (const target of ['OOS_VALIDATED', 'WALK_FORWARD_VALIDATED', 'ROBUSTNESS_VALIDATED', 'DEMO_ELIGIBLE'] as const) lifecycle.transition(id, target, 'fixture', study.experimentId);
  return id;
}
describe('registered strategy reconstruction', () => {
  it('refuses rankings, unknown configuration and live loading without evidence', () => {
    expect(() => loadEligibleStrategies(db, 'DEMO', ['TEST'])).toThrow('No DEMO-eligible');
    const id = fixture();
    expect(() => loadEligibleStrategies(db, 'LIVE', ['TEST'], [id])).toThrow('not eligible');
    vi.stubEnv('CONTRACT_DURATION', '9'); resetEnvForTesting();
    expect(() => loadEligibleStrategies(db, 'DEMO', ['TEST'], [id])).toThrow('configuration differs');
  });
  it('reconstructs the registered factory and carries identity, then stops after review', () => {
    const id = fixture();
    const loaded = assertDefined(loadEligibleStrategies(db, 'DEMO', ['TEST'], [id])[0]);
    const features = new FeatureEngine('TEST').process({ symbol: 'TEST', price: 100, epoch: 1, timestamp: new Date(1000) });
    expect(loaded.strategy.generateSignal(features, [])).toMatchObject({ hypothesisId: id, strategy: `hypothesis:${id}` });
    lifecycle.transition(id, 'REVIEW', 'out-of-sample degradation');
    expect(() => loaded.strategy.generateSignal(features, [])).toThrow('not eligible');
  });
});
