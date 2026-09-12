import { createLogger } from '../monitoring/Logger.js';
import { BacktestEngine, type BacktestConfig } from '../backtest/BacktestEngine.js';
import { probabilityOfBacktestOverfitting } from '../research/statistics/stats.js';
import type { TickFeatures } from '../types/tick.js';
import type { BacktestRun, PerformanceMetrics } from '../types/backtest.js';

const log = createLogger('WalkForwardRunner');

// ---------------------------------------------------------------------------
// Walk-Forward Configuration
// ---------------------------------------------------------------------------

export interface WalkForwardConfig {
  /** Fraction of total data used for training in each fold [0, 1] */
  trainFraction: number;
  /** Fraction used for validation [0, 1] */
  validateFraction: number;
  /** Fraction used for out-of-sample test [0, 1] */
  testFraction: number;
  /** Number of rolling folds to run (anchored walk-forward) */
  numFolds: number;
  /** Minimum trades per fold to count as a valid fold */
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
  pbo: number | null; // Probability of Backtest Overfitting across all folds
  pboInterpretation: string;
  passesRigorousValidation: boolean;
  validationNotes: string[];
}

// ---------------------------------------------------------------------------
// WalkForwardRunner
// ---------------------------------------------------------------------------

/**
 * Walk-Forward Validation Orchestrator
 *
 * Implements anchored walk-forward testing — the gold standard for
 * evaluating time-series strategies:
 *
 *  Fold 1: [====TRAIN====][--VAL--][TEST]...remaining data
 *  Fold 2: [======TRAIN======][--VAL--][TEST]...
 *  ...
 *
 * The train set grows with each fold (anchored), validation and test
 * windows slide forward.
 *
 * This prevents:
 *   - Look-ahead bias (test is always strictly in the future)
 *   - Data snooping (validation never touches test set)
 *   - Overfitting (final evaluation on unseen test set only)
 *
 * EMPIRICAL CAUTION:
 * Even walk-forward validation can overfit if the strategy is selected
 * based on test performance. The ONLY legitimate use is:
 *   1. Develop strategy on train set
 *   2. Tune parameters on validation set (once, not repeatedly)
 *   3. Report results on test set (one time, no further tuning)
 */
export class WalkForwardRunner {
  constructor(private readonly config: WalkForwardConfig) {
    const total = config.trainFraction + config.validateFraction + config.testFraction;
    if (Math.abs(total - 1.0) > 0.001) {
      throw new Error(
        `trainFraction + validateFraction + testFraction must sum to 1.0, got ${total}`,
      );
    }
    if (config.numFolds < 2) {
      throw new Error('numFolds must be >= 2 for meaningful walk-forward validation');
    }
  }

  /**
   * Runs walk-forward validation for a single strategy on feature data.
   *
   * @param features - Feature-enriched ticks in STRICT chronological order
   * @param backtestConfig - Strategy + backtest parameters
   * @param numStrategiesTried - Total strategies tried before this one (for PBO/DSR)
   */
  async run(
    features: readonly TickFeatures[],
    backtestConfig: BacktestConfig,
    numStrategiesTried = 1,
  ): Promise<WalkForwardResult> {
    if (features.length < 100) {
      throw new Error(
        `Insufficient data for walk-forward: need ≥100 ticks, got ${features.length}`,
      );
    }

    const strategy = backtestConfig.strategy.name;
    const symbol = backtestConfig.symbol;

    log.info(
      { strategy, symbol, numFolds: this.config.numFolds, total: features.length },
      'Starting walk-forward validation',
    );

    const folds: WalkForwardFold[] = [];
    const allTestReturns: number[][] = [];

    // ---------------------------------------------------------------------------
    // Anchored walk-forward: train grows, test slides forward
    // ---------------------------------------------------------------------------
    const n = features.length;
    const foldStep = Math.floor(n * this.config.testFraction);

    for (let foldIdx = 0; foldIdx < this.config.numFolds; foldIdx++) {
      // Anchored: train start is always the beginning
      const testEnd = n - foldStep * (this.config.numFolds - 1 - foldIdx);
      const testStart = testEnd - foldStep;
      const validateEnd = testStart;
      const validateStart = Math.max(0, validateEnd - Math.floor(n * this.config.validateFraction));
      const trainEnd = validateStart;
      const trainStart = 0; // Anchored

      if (trainEnd <= trainStart || validateEnd <= validateStart || testEnd <= testStart) {
        log.warn({ foldIdx }, 'Skipping invalid fold (insufficient data)');
        continue;
      }

      const trainFrom = features[trainStart]!.timestamp;
      const trainTo = features[trainEnd - 1]!.timestamp;
      const validateFrom = features[validateStart]!.timestamp;
      const validateTo = features[validateEnd - 1]!.timestamp;
      const testFrom = features[testStart]!.timestamp;
      const testTo = features[testEnd - 1]!.timestamp;

      log.info(
        {
          fold: foldIdx + 1,
          trainTicks: trainEnd - trainStart,
          validateTicks: validateEnd - validateStart,
          testTicks: testEnd - testStart,
        },
        'Running fold',
      );

      const engine = new BacktestEngine({
        ...backtestConfig,
        numTrials: numStrategiesTried,
      });

      const run = await engine.run(
        features,
        trainFrom,
        trainTo,
        validateFrom,
        validateTo,
        testFrom,
        testTo,
      );

      folds.push({
        foldIndex: foldIdx,
        trainFrom,
        trainTo,
        validateFrom,
        validateTo,
        testFrom,
        testTo,
        run,
      });

      // Collect test returns for PBO calculation
      const testReturns = run.observations
        .filter((o) => o.timestamp >= testFrom && o.timestamp <= testTo)
        .map((o) => o.returnPct);

      if (testReturns.length >= this.config.minTradesPerFold) {
        allTestReturns.push(testReturns);
      }
    }

    if (folds.length === 0) {
      throw new Error('No valid folds completed — insufficient data or all folds invalid');
    }

    // ---------------------------------------------------------------------------
    // PBO across all test folds
    // ---------------------------------------------------------------------------
    let pbo: number | null = null;
    let pboInterpretation = 'N/A — insufficient folds for PBO';

    if (allTestReturns.length >= 2) {
      const pboResult = probabilityOfBacktestOverfitting(allTestReturns, 8);
      if (pboResult !== null) {
        pbo = pboResult.pbo;
        pboInterpretation = interpretPBO(pbo);
      }
    }

    // ---------------------------------------------------------------------------
    // Aggregate test metrics across folds
    // ---------------------------------------------------------------------------
    const aggregatedTestMetrics = this.aggregateTestMetrics(folds);

    // ---------------------------------------------------------------------------
    // Rigorous validation gate
    // ---------------------------------------------------------------------------
    const { passes, notes } = this.rigorousValidation(folds, aggregatedTestMetrics, pbo);

    log.info(
      {
        strategy,
        symbol,
        folds: folds.length,
        pbo,
        passesValidation: passes,
        validationNotes: notes,
      },
      'Walk-forward complete',
    );

    return {
      strategy,
      symbol,
      config: this.config,
      folds,
      aggregatedTestMetrics,
      pbo,
      pboInterpretation,
      passesRigorousValidation: passes,
      validationNotes: notes,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private aggregateTestMetrics(folds: WalkForwardFold[]): PerformanceMetrics | null {
    const validFolds = folds.filter(
      (f) => f.run.testMetrics.totalTrades >= this.config.minTradesPerFold,
    );

    if (validFolds.length === 0) return null;

    // Average key metrics across folds
    const avg = (arr: (number | null)[]): number | null => {
      const valid = arr.filter((v): v is number => v !== null);
      return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    };

    const first = validFolds[0]!.run.testMetrics;

    return {
      ...first,
      totalTrades: validFolds.reduce((a, f) => a + f.run.testMetrics.totalTrades, 0),
      wins: validFolds.reduce((a, f) => a + f.run.testMetrics.wins, 0),
      losses: validFolds.reduce((a, f) => a + f.run.testMetrics.losses, 0),
      winRate: avg(validFolds.map((f) => f.run.testMetrics.winRate)) ?? 0,
      netReturn: avg(validFolds.map((f) => f.run.testMetrics.netReturn)) ?? 0,
      sharpeRatio: avg(validFolds.map((f) => f.run.testMetrics.sharpeRatio)),
      sortinoRatio: avg(validFolds.map((f) => f.run.testMetrics.sortinoRatio)),
      deflatedSharpe: avg(validFolds.map((f) => f.run.testMetrics.deflatedSharpe)),
      maxDrawdownPct: Math.min(...validFolds.map((f) => f.run.testMetrics.maxDrawdownPct)),
      edgeStatus: this.aggregateEdgeStatus(validFolds),
      fromDate: validFolds[0]!.testFrom,
      toDate: validFolds[validFolds.length - 1]!.testTo,
    };
  }

  private aggregateEdgeStatus(folds: WalkForwardFold[]): PerformanceMetrics['edgeStatus'] {
    const statuses = folds.map((f) => f.run.testMetrics.edgeStatus);
    const edgeCount = statuses.filter((s) => s === 'EDGE_DETECTED').length;
    const overfitCount = statuses.filter((s) => s === 'OVERFIT_RISK_HIGH').length;
    const insufficientCount = statuses.filter((s) => s === 'INSUFFICIENT_EVIDENCE').length;

    if (insufficientCount > folds.length / 2) return 'INSUFFICIENT_EVIDENCE';
    if (overfitCount > 0) return 'OVERFIT_RISK_HIGH';
    if (edgeCount > folds.length * 0.6) return 'EDGE_DETECTED';
    return 'EDGE_NOT_DETECTED';
  }

  private rigorousValidation(
    folds: WalkForwardFold[],
    aggregated: PerformanceMetrics | null,
    pbo: number | null,
  ): { passes: boolean; notes: string[] } {
    const notes: string[] = [];
    let passes = true;

    if (!aggregated) {
      return {
        passes: false,
        notes: ['FAIL: No valid folds with sufficient trades'],
      };
    }

    // 1. Minimum trades
    if (aggregated.totalTrades < 30) {
      notes.push(`FAIL: Only ${aggregated.totalTrades} total test trades — need ≥30`);
      passes = false;
    }

    // 2. DSR must be significant
    if (aggregated.deflatedSharpe === null || aggregated.deflatedSharpe < 0.75) {
      notes.push(
        `FAIL: Deflated Sharpe ${aggregated.deflatedSharpe?.toFixed(3) ?? 'N/A'} < 0.75 threshold`,
      );
      passes = false;
    }

    // 3. PBO must be low
    if (pbo !== null && pbo > 0.4) {
      notes.push(`FAIL: PBO = ${(pbo * 100).toFixed(1)}% > 40% — likely overfit`);
      passes = false;
    }

    // 4. Drawdown must be bounded
    if (aggregated.maxDrawdownPct < -0.3) {
      notes.push(
        `FAIL: Max drawdown ${(aggregated.maxDrawdownPct * 100).toFixed(1)}% exceeds 30% limit`,
      );
      passes = false;
    }

    // 5. Consistent across folds (not just lucky in one)
    const consistentFolds = folds.filter((f) => f.run.testMetrics.netReturn > 0).length;
    const consistencyRate = consistentFolds / folds.length;
    if (consistencyRate < 0.6) {
      notes.push(
        `FAIL: Only ${(consistencyRate * 100).toFixed(0)}% of folds were profitable — need ≥60%`,
      );
      passes = false;
    }

    // 6. Win rate must be economically meaningful
    if (aggregated.winRate < 0.5) {
      notes.push(
        `WARNING: Win rate ${(aggregated.winRate * 100).toFixed(1)}% < 50% — check payout ratio justification`,
      );
      // Don't fail — binary options can be profitable below 50% with right payout
    }

    if (passes) {
      notes.push(
        `PASS: Strategy meets all rigorous validation criteria across ${folds.length} folds`,
      );
      notes.push('NOTE: This is evidence of edge, not guarantee of future performance');
    }

    return { passes, notes };
  }
}

function interpretPBO(pbo: number): string {
  if (pbo < 0.1) return 'Low risk of overfitting (PBO < 10%)';
  if (pbo < 0.25) return 'Moderate risk of overfitting (PBO 10-25%)';
  if (pbo < 0.4) return 'Elevated overfitting risk (PBO 25-40%) — proceed with caution';
  if (pbo < 0.5) return 'High overfitting risk (PBO 40-50%) — strategy likely overfit';
  return 'CRITICAL: PBO ≥ 50% — strategy is essentially random in out-of-sample data';
}
