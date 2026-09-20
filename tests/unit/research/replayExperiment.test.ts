import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getEnv } from '../../../src/config/env.js';
import { BacktestEngine } from '../../../src/backtest/BacktestEngine.js';
import { FeatureEngine } from '../../../src/features/FeatureEngine.js';
import { strategyFactories } from '../../../src/strategies/catalogue.js';
import { ExperimentRegistry, captureResearchCode } from '../../../src/research/experiments/ExperimentRegistry.js';
import { replayExperiment } from '../../../src/research/experiments/replayExperiment.js';
import { assertDefined } from '../../../src/utils/assertDefined.js';

describe('saved catalogue experiment replay', () => {
  it('reconstructs nonempty trade outcomes from registered raw prices and refuses changed source', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const db = new Database(':memory:');
    try {
      const registry = new ExperimentRegistry(db, captureResearchCode(root));
      const entry = assertDefined(strategyFactories[0]);
      const env = getEnv();
      const config = { strategyFactory: entry.factory, strategyName: entry.name, strategyDeclaration: { catalogKey: entry.name, version: 1 },
        symbol: 'TEST', payoutMultiplier: env.BACKTEST_PAYOUT_MULTIPLIER, feePerTrade: 0, minConfidence: env.MIN_CONSENSUS_CONFIDENCE,
        contextWindow: 200, contractDuration: env.CONTRACT_DURATION, contractDurationUnit: env.CONTRACT_DURATION_UNIT, registry };
      const features = new FeatureEngine('TEST');
      const rows = Array.from({ length: 600 }, (_, i) => features.process({ symbol: 'TEST', price: 100 + i, epoch: i, timestamp: new Date(i * 1000) }));
      const boundaries = [0, 199, 200, 399, 400, 599].map(i => new Date(i * 1000));
      const run = await new BacktestEngine(config).run(rows, assertDefined(boundaries[0]), assertDefined(boundaries[1]), assertDefined(boundaries[2]), assertDefined(boundaries[3]), assertDefined(boundaries[4]), assertDefined(boundaries[5]));
      expect(run.observations.length).toBeGreaterThan(0);
      expect(await replayExperiment(db, assertDefined(run.experimentId), root)).toMatchObject({ observations: run.observations.length, matchedAttempts: 1 });
      const otherRegistry = new ExperimentRegistry(db, { changed: 'source' });
      const other = otherRegistry.begin([], { ...new BacktestEngine(config).declaration(), periods: boundaries.map(date => date.toISOString()), numTrials: 1 });
      otherRegistry.finish(other.attemptId, 'COMPLETED', { observations: [] });
      await expect(replayExperiment(db, other.experimentId, root)).rejects.toThrow('captured source');
    } finally { db.close(); }
  });
});
