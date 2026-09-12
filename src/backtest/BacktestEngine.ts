import crypto from 'crypto';
import { createLogger } from '../monitoring/Logger.js';
import { mean, stddev } from '../features/indicators/indicators.js';
import {
  computeSharpe,
  computeSortino,
  deflatedSharpeRatio,
  computeMaxDrawdown,
} from '../research/statistics/stats.js';
import { MIN_TRADES_FOR_SHARPE } from '../config/constants.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import type { TickFeatures } from '../types/tick.js';
import type { BacktestObservation, PerformanceMetrics, BacktestRun } from '../types/backtest.js';

const log = createLogger('BacktestEngine');

// ---------------------------------------------------------------------------
// Backtest Configuration
// ---------------------------------------------------------------------------

export interface BacktestConfig {
  strategy: Strategy;
  symbol: string;
  /** Contract payout multiplier — e.g. 0.85 means 85c payout per $1 stake on win */
  payoutMultiplier: number;
  /** Fee deducted from each stake regardless of outcome */
  feePerTrade: number;
  /** Minimum confidence threshold — signals below this are not traded */
  minConfidence: number;
  /** Context window: how many past ticks to pass to strategy */
  contextWindow: number;
  /** Number of strategies tried (for Deflated Sharpe calculation) */
  numTrials?: number;
}

// ---------------------------------------------------------------------------
// BacktestEngine — Event-driven, Realistic
// ---------------------------------------------------------------------------

/**
 * Event-driven backtesting engine.
 *
 * DESIGN PRINCIPLES:
 *   - Processes ticks in strict chronological order
 *   - No look-ahead: strategy only sees ticks up to and including the current one
 *   - Models payout structure (binary options: win = payout * stake, lose = -stake)
 *   - Models fees
 *   - Models minimum confidence filter
 *   - Tracks full equity curve for drawdown calculation
 *   - NEVER uses test set for optimization
 *
 * LIMITATIONS (be honest about these):
 *   - Does not model execution delay (binary options execute instantly on Deriv)
 *   - Does not model contract unavailability
 *   - Does not model slippage (binary options are priced by Deriv, not a market)
 *   - Does not model potential changes in payout ratios over time
 */
export class BacktestEngine {
  constructor(private readonly config: BacktestConfig) {}

  /**
   * Runs the backtest on a set of feature-enriched ticks.
   *
   * @param features - Feature-enriched ticks in STRICT chronological order
   * @param trainFrom - Training period start (inclusive)
   * @param trainTo - Training period end (inclusive)
   * @param validateFrom - Validation period start (inclusive)
   * @param validateTo - Validation period end (inclusive)
   * @param testFrom - Test period start (inclusive)
   * @param testTo - Test period end (inclusive)
   */
  async run(
    features: readonly TickFeatures[],
    trainFrom: Date,
    trainTo: Date,
    validateFrom: Date,
    validateTo: Date,
    testFrom: Date,
    testTo: Date,
  ): Promise<BacktestRun> {
    log.info(
      {
        strategy: this.config.strategy.name,
        symbol: this.config.symbol,
        total: features.length,
      },
      'Starting backtest',
    );

    const trainObs = this.runPeriod(features, trainFrom, trainTo);
    const validateObs = this.runPeriod(features, validateFrom, validateTo);
    const testObs = this.runPeriod(features, testFrom, testTo);

    const numTrials = this.config.numTrials ?? 1;

    const trainMetrics = this.computeMetrics(trainObs, 'BACKTEST', trainFrom, trainTo, numTrials);
    const validateMetrics = this.computeMetrics(
      validateObs,
      'BACKTEST',
      validateFrom,
      validateTo,
      numTrials,
    );
    const testMetrics = this.computeMetrics(testObs, 'BACKTEST', testFrom, testTo, numTrials);

    log.info(
      {
        train: { trades: trainMetrics.totalTrades, edge: trainMetrics.edgeStatus },
        validate: { trades: validateMetrics.totalTrades, edge: validateMetrics.edgeStatus },
        test: { trades: testMetrics.totalTrades, edge: testMetrics.edgeStatus },
      },
      'Backtest complete',
    );

    return {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      strategy: this.config.strategy.name,
      symbol: this.config.symbol,
      parameters: {
        payoutMultiplier: this.config.payoutMultiplier,
        feePerTrade: this.config.feePerTrade,
        minConfidence: this.config.minConfidence,
      },
      trainFrom,
      trainTo,
      validateFrom,
      validateTo,
      testFrom,
      testTo,
      trainMetrics,
      validateMetrics,
      testMetrics,
      observations: [...trainObs, ...validateObs, ...testObs],
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Simulation
  // ---------------------------------------------------------------------------

  private runPeriod(
    allFeatures: readonly TickFeatures[],
    from: Date,
    to: Date,
  ): BacktestObservation[] {
    const periodFeatures = allFeatures.filter((f) => f.timestamp >= from && f.timestamp <= to);

    if (periodFeatures.length < 2) return [];

    const observations: BacktestObservation[] = [];
    const history: TickFeatures[] = [];

    for (let i = 0; i < periodFeatures.length - 1; i++) {
      const current = periodFeatures[i];
      if (!current) continue;

      // Maintain context window (history = ticks BEFORE current)
      if (history.length > this.config.contextWindow) {
        history.shift();
      }

      const signal = this.config.strategy.generateSignal(current, history);

      // Add current to history AFTER signal generation (causal)
      history.push(current);

      if (signal.direction === 'NONE') continue;
      if (signal.confidence < this.config.minConfidence) continue;

      // Next tick is our "exit" (for simplest binary option simulation)
      const next = periodFeatures[i + 1];
      if (!next) continue;

      const stake = 1.0; // Normalized stake for backtesting — risk engine handles real sizing
      const entryPrice = current.price;
      const exitPrice = next.price;

      const priceWentUp = exitPrice > entryPrice;

      // Win condition depends on direction
      const won =
        (signal.direction === 'BUY' && priceWentUp) ||
        (signal.direction === 'SELL' && !priceWentUp);

      const grossProfit = won ? stake * this.config.payoutMultiplier : -stake;
      const netProfit = grossProfit - this.config.feePerTrade;

      observations.push({
        timestamp: current.timestamp,
        symbol: this.config.symbol,
        entryPrice,
        exitPrice,
        direction: signal.direction,
        stake,
        profit: netProfit,
        returnPct: netProfit / stake,
        won,
      });
    }

    return observations;
  }

  // ---------------------------------------------------------------------------
  // Private: Metrics Computation
  // ---------------------------------------------------------------------------

  private computeMetrics(
    observations: readonly BacktestObservation[],
    mode: 'BACKTEST',
    from: Date,
    to: Date,
    numTrials: number,
  ): PerformanceMetrics {
    const paramHash = this.config.strategy.name; // simplified

    if (observations.length === 0) {
      return this.emptyMetrics(mode, from, to, paramHash);
    }

    const profits = observations.map((o) => o.profit);
    const returns = observations.map((o) => o.returnPct);
    const wins = observations.filter((o) => o.won);
    const losses = observations.filter((o) => !o.won);

    const totalProfit = profits.reduce((a, b) => a + b, 0);
    const totalStaked = observations.reduce((a, o) => a + o.stake, 0);
    const totalWinAmount = wins.reduce((a, o) => a + o.profit, 0);
    const totalLossAmount = Math.abs(losses.reduce((a, o) => a + o.profit, 0));

    const winRate = wins.length / observations.length;
    const avgWin = wins.length > 0 ? totalWinAmount / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLossAmount / losses.length : 0;
    const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : Infinity;

    // Equity curve for drawdown
    let equity = 0;
    const equityCurve = profits.map((p) => (equity += p));
    const { maxDrawdown, maxDrawdownPct } = computeMaxDrawdown(equityCurve);

    // Streaks
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let currentWin = 0;
    let currentLoss = 0;
    for (const o of observations) {
      if (o.won) {
        currentWin++;
        currentLoss = 0;
        maxWinStreak = Math.max(maxWinStreak, currentWin);
      } else {
        currentLoss++;
        currentWin = 0;
        maxLossStreak = Math.max(maxLossStreak, currentLoss);
      }
    }

    // Risk-adjusted metrics
    const sharpeResult = computeSharpe(returns);
    const sortino = computeSortino(returns);
    const dsr = deflatedSharpeRatio(returns, numTrials);
    const netReturn = totalStaked > 0 ? totalProfit / totalStaked : 0;
    const calmar = maxDrawdownPct !== 0 ? netReturn / Math.abs(maxDrawdownPct) : null;

    // Confidence interval (±1.96 SE on expectancy)
    const retStd = stddev(returns);
    const se = retStd / Math.sqrt(returns.length);
    const meanRet = mean(returns);
    const ci95: [number, number] = [meanRet - 1.96 * se, meanRet + 1.96 * se];

    // Edge status
    const edgeStatus = this.determineEdgeStatus(observations.length, dsr, ci95, maxDrawdownPct);

    return {
      mode,
      strategy: this.config.strategy.name,
      symbol: this.config.symbol,
      fromDate: from,
      toDate: to,
      parameterHash: paramHash,
      totalTrades: observations.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      lossRate: 1 - winRate,
      totalProfit,
      totalStaked,
      netReturn,
      averageWin: avgWin,
      averageLoss: avgLoss,
      profitFactor,
      expectancy,
      maxDrawdown,
      maxDrawdownPct,
      longestLosingStreak: maxLossStreak,
      longestWinningStreak: maxWinStreak,
      maxConsecutiveLosses: maxLossStreak,
      sharpeRatio: sharpeResult?.sharpe ?? null,
      sortinoRatio: sortino,
      calmarRatio: calmar,
      deflatedSharpe: dsr?.dsr ?? null,
      pValueSharpe: dsr?.pValue ?? null,
      confidenceInterval95: ci95,
      pbo: null, // PBO computed separately at walk-forward level
      edgeStatus,
    };
  }

  private determineEdgeStatus(
    tradeCount: number,
    dsr: ReturnType<typeof deflatedSharpeRatio>,
    ci95: [number, number],
    maxDrawdownPct: number,
  ): PerformanceMetrics['edgeStatus'] {
    if (tradeCount < MIN_TRADES_FOR_SHARPE) return 'INSUFFICIENT_EVIDENCE';

    if (dsr === null) return 'INSUFFICIENT_EVIDENCE';

    // Catastrophic drawdown = likely overfit or broken
    if (maxDrawdownPct < -0.5) return 'OVERFIT_RISK_HIGH';

    // DSR > 0.95 and CI doesn't cross zero: strong evidence of edge
    if (dsr.dsr > 0.95 && ci95[0] > 0) return 'EDGE_DETECTED';

    // DSR < 0.5: more likely overfitting than real edge
    if (dsr.dsr < 0.5) return 'OVERFIT_RISK_HIGH';

    // CI crosses zero: not enough evidence either way
    if (ci95[0] < 0 && ci95[1] > 0) return 'EDGE_NOT_DETECTED';

    return 'EDGE_NOT_DETECTED';
  }

  private emptyMetrics(
    mode: 'BACKTEST',
    from: Date,
    to: Date,
    paramHash: string,
  ): PerformanceMetrics {
    return {
      mode,
      strategy: this.config.strategy.name,
      symbol: this.config.symbol,
      fromDate: from,
      toDate: to,
      parameterHash: paramHash,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      lossRate: 0,
      totalProfit: 0,
      totalStaked: 0,
      netReturn: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      expectancy: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      longestLosingStreak: 0,
      longestWinningStreak: 0,
      maxConsecutiveLosses: 0,
      sharpeRatio: null,
      sortinoRatio: null,
      calmarRatio: null,
      deflatedSharpe: null,
      pValueSharpe: null,
      confidenceInterval95: null,
      pbo: null,
      edgeStatus: 'INSUFFICIENT_EVIDENCE',
    };
  }
}

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

async function hashObject(obj: unknown): Promise<string> {
  const json = JSON.stringify(obj);
  const encoder = new TextEncoder();
  const data = encoder.encode(json);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { hashObject };
