import { assertDefined } from '../utils/assertDefined.js';
import { BacktestEngine, type BacktestConfig } from './BacktestEngine.js';
import type { TickFeatures } from '../types/tick.js';
import type { BacktestRun, PerformanceMetrics } from '../types/backtest.js';

export interface WalkForwardConfig {
  trainFraction: number;
  validateFraction: number;
  testFraction: number;
  numFolds: number;
  minTradesPerFold: number;
}

export interface WalkForwardFold {
  foldIndex: number;
  trainFrom: Date;
  trainTo: Date;
  validateFrom: Date;
  validateTo: Date;
  testFrom: Date;
  testTo: Date;
  run: BacktestRun;
}

export interface WalkForwardResult {
  strategy: string;
  symbol: string;
  config: WalkForwardConfig;
  folds: WalkForwardFold[];
  aggregatedTestMetrics: PerformanceMetrics | null;
  pbo: number | null;
  pboInterpretation: string;
  passesRigorousValidation: boolean;
  validationNotes: string[];
}

/** Anchored folds with non-overlapping test periods and fresh strategy instances. */
export class WalkForwardRunner {
  constructor(private readonly config: WalkForwardConfig) {
    const fractions = [config.trainFraction, config.validateFraction, config.testFraction];
    if (fractions.some((f) => !Number.isFinite(f) || f <= 0) || Math.abs(fractions.reduce((a, b) => a + b, 0) - 1) > 0.001) {
      throw new Error('Positive train/validate/test fractions must sum to 1.0');
    }
    if (!Number.isInteger(config.numFolds) || config.numFolds < 2) throw new Error('numFolds must be >= 2');
    if (!Number.isInteger(config.minTradesPerFold) || config.minTradesPerFold < 1) throw new Error('minTradesPerFold must be positive');
  }

  async run(features: readonly TickFeatures[], config: BacktestConfig, numStrategiesTried = 1): Promise<WalkForwardResult> {
    if (features.length < 100) throw new Error(`Insufficient data for walk-forward: need >=100 ticks, got ${String(features.length)}`);
    for (let i = 1; i < features.length; i++) {
      if (assertDefined(features[i]).timestamp < assertDefined(features[i - 1]).timestamp) throw new Error('Backtest features must be chronological');
    }
    const folds: WalkForwardFold[] = [];
    const engine = new BacktestEngine({ ...config, numTrials: numStrategiesTried });
    // Keep the requested initial training fraction, split the remaining test
    // allocation into disjoint folds, and grow training as each fold advances.
    const firstTest = Math.floor(features.length * (this.config.trainFraction + this.config.validateFraction));
    const validationLength = Math.floor(features.length * this.config.validateFraction);
    const testLength = features.length - firstTest;
    const boundary = (index: number): number => {
      while (index > 0 && index < features.length && assertDefined(features[index]).timestamp.getTime() === assertDefined(features[index - 1]).timestamp.getTime()) index++;
      return index;
    };
    for (let i = 0; i < this.config.numFolds; i++) {
      const testStart = boundary(firstTest + Math.floor(testLength * i / this.config.numFolds));
      const testEnd = boundary(firstTest + Math.floor(testLength * (i + 1) / this.config.numFolds));
      const validationStart = boundary(Math.max(1, testStart - validationLength));
      if (testEnd - testStart < 2 || validationStart >= testStart) continue;
      const trainFrom = assertDefined(features[0]).timestamp;
      const trainTo = assertDefined(features[validationStart - 1]).timestamp;
      const validateFrom = assertDefined(features[validationStart]).timestamp;
      const validateTo = assertDefined(features[testStart - 1]).timestamp;
      const testFrom = assertDefined(features[testStart]).timestamp;
      const testTo = assertDefined(features[testEnd - 1]).timestamp;
      const run = await engine.run(features, trainFrom, trainTo, validateFrom, validateTo, testFrom, testTo);
      folds.push({ foldIndex: i, trainFrom, trainTo, validateFrom, validateTo, testFrom, testTo, run });
    }
    // Include ALL test trades, even from sparse or losing folds; excluding those
    // trades biases the result. Compute totals/CI/drawdown from the combined path.
    const observations = folds.flatMap((f) => f.run.observations.filter((o) => o.timestamp >= f.testFrom && o.timestamp <= f.testTo));
    const aggregated = folds.length ? engine.computeMetrics(observations, 'BACKTEST', assertDefined(folds[0]).testFrom, assertDefined(folds[folds.length - 1]).testTo, numStrategiesTried) : null;
    const notes: string[] = [];
    if (folds.length < this.config.numFolds) notes.push(`FAIL: Only ${String(folds.length)}/${String(this.config.numFolds)} usable folds`);
    const sparse = folds.filter((f) => f.run.testMetrics.totalTrades < this.config.minTradesPerFold).length;
    if (sparse) notes.push(`FAIL: Insufficient data: ${String(sparse)} folds have fewer than ${String(this.config.minTradesPerFold)} test trades`);
    if (!aggregated || aggregated.totalTrades < 30) notes.push(`FAIL: Insufficient data: ${String(aggregated?.totalTrades ?? 0)} out-of-sample trades; need >=30`);
    if (!aggregated || !Number.isFinite(aggregated.expectancy) || aggregated.expectancy <= 0) notes.push('FAIL: Out-of-sample expectancy must be positive after payout and fees');
    if (!aggregated?.confidenceInterval95 || !Number.isFinite(aggregated.confidenceInterval95[0]) || aggregated.confidenceInterval95[0] <= 0) notes.push('FAIL: Lower 95% confidence bound on out-of-sample return must be positive');
    if (aggregated && aggregated.maxDrawdownPct < -0.3) notes.push('FAIL: Maximum drawdown exceeds 30% of simulated starting capital');
    const profitable = folds.filter((f) => f.run.testMetrics.totalProfit > 0).length;
    if (!folds.length || profitable / folds.length < 0.6) notes.push('FAIL: Fewer than 60% of test folds are profitable');
    const passed = notes.length === 0;
    if (passed) notes.push(`PASS: Positive out-of-sample evidence across ${String(folds.length)} folds`);
    notes.push('Simulation assumes zero execution latency and a fixed minimum payout; historical ticks cannot reproduce dealer quotes or guarantee future performance.');
    return {
      strategy: config.strategyName,
      symbol: config.symbol,
      config: this.config,
      folds,
      aggregatedTestMetrics: aggregated,
      pbo: null,
      pboInterpretation: 'Unavailable: PBO requires aligned returns for multiple candidate strategies; temporal folds are not separate strategies.',
      passesRigorousValidation: passed,
      validationNotes: notes,
    };
  }
}
