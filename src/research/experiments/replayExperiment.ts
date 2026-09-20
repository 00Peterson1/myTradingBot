import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BacktestEngine } from '../../backtest/BacktestEngine.js';
import { FeatureEngine } from '../../features/FeatureEngine.js';
import { strategyFactories } from '../../strategies/catalogue.js';
import { getEnv } from '../../config/env.js';
import { assertDefined } from '../../utils/assertDefined.js';
import { captureResearchCode, contentHash, readExperimentBundle } from './ExperimentRegistry.js';

/** Replay a known factory only when captured code and resolved settings still match. */
export async function replayExperiment(db: Database.Database, id: string, root: string): Promise<{ experimentId: string; observations: number; matchedAttempts: number }> {
  const bundle = readExperimentBundle(db, id);
  const manifest = z.object({ kind: z.literal('EXPERIMENT'), codeId: z.string(), hypothesisId: z.string(),
    configuration: z.object({ strategy: z.string(), symbol: z.string(), declaration: z.object({ catalogKey: z.string(), version: z.literal(1) }),
      numTrials: z.number().int().positive(), periods: z.array(z.string().datetime()).length(6) }) }).parse(bundle.manifest);
  if (manifest.codeId !== contentHash(captureResearchCode(root))) throw new Error('Replay requires the captured source and dependency version');
  const entry = strategyFactories.find(candidate => candidate.name === manifest.configuration.declaration.catalogKey);
  if (!entry) throw new Error('No reconstructable factory for this experiment');
  const env = getEnv();
  const engine = new BacktestEngine({ strategyFactory: entry.factory, strategyName: entry.name,
    strategyDeclaration: { catalogKey: entry.name, version: 1 }, symbol: manifest.configuration.symbol,
    payoutMultiplier: env.BACKTEST_PAYOUT_MULTIPLIER, feePerTrade: 0, minConfidence: env.MIN_CONSENSUS_CONFIDENCE,
    contextWindow: 200, contractDuration: env.CONTRACT_DURATION, contractDurationUnit: env.CONTRACT_DURATION_UNIT,
    numTrials: manifest.configuration.numTrials });
  if (contentHash(engine.declaration()) !== manifest.hypothesisId) throw new Error('Replay settings differ from the saved hypothesis');
  const attempts = z.array(z.object({ status: z.string(), outcome: z.unknown() })).parse(bundle.attempts).filter(attempt => attempt.status === 'COMPLETED');
  if (!attempts.length) throw new Error('No completed attempt to compare');
  const dataset = z.array(z.object({ symbol: z.string(), timestamp: z.string().datetime(), price: z.number().positive() })).parse(bundle.dataset);
  const featureEngine = new FeatureEngine(manifest.configuration.symbol);
  const features = dataset.map(row => featureEngine.process({ ...row, timestamp: new Date(row.timestamp), epoch: Date.parse(row.timestamp) / 1000 }));
  const periods = manifest.configuration.periods.map(value => new Date(value));
  const result = await engine.run(features, assertDefined(periods[0]), assertDefined(periods[1]), assertDefined(periods[2]),
    assertDefined(periods[3]), assertDefined(periods[4]), assertDefined(periods[5]));
  const observations = result.observations.map(row => ({ ...row, timestamp: row.timestamp.toISOString() }));
  for (const attempt of attempts) {
    const recorded = z.object({ observations: z.array(z.unknown()) }).parse(attempt.outcome);
    if (contentHash(recorded.observations) !== contentHash(observations)) throw new Error('Replay observations differ from the saved completed attempt');
  }
  return { experimentId: id, observations: observations.length, matchedAttempts: attempts.length };
}
