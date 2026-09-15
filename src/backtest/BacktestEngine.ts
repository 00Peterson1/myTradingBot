import { blockBootstrapMean, DEFAULT_BOOTSTRAP_POLICY, type BootstrapPolicy } from '../research/statistics/bootstrap.js';
import type { ExperimentRegistry } from '../research/experiments/ExperimentRegistry.js';
import { StrategyStream, DEFAULT_WARMUP_TICKS } from '../pipeline/StrategyStream.js';
import Database from 'better-sqlite3';
import { OptionsLedger } from '../portfolio/OptionsLedger.js';
import { RiskEngine } from '../risk/RiskEngine.js';
import { SimulatedExecutionEngine } from '../execution/SimulatedExecutionEngine.js';
import { getEnv } from '../config/env.js';
import type { Tick } from '../types/tick.js';
import { assertDefined } from '../utils/assertDefined.js';
import crypto from 'crypto';
import { createLogger } from '../monitoring/Logger.js';
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
import type { Signal } from '../types/signal.js';

const log = createLogger('BacktestEngine');

// ---------------------------------------------------------------------------
// Backtest Configuration
// ---------------------------------------------------------------------------

export interface BacktestConfig {
  /** A new instance is required for EVERY period; learned state must never leak. */
  strategyFactory: () => Strategy;
  strategyName: string;
  symbol: string;
  /** Contract payout multiplier — e.g. 0.85 means 85c payout per $1 stake on win */
  payoutMultiplier: number;
  /** Additional execution fee charged at entry regardless of outcome */
  feePerTrade: number;
  /** Minimum confidence threshold — signals below this are not traded */
  minConfidence: number;
  /** Context window: how many past ticks to pass to strategy */
  contextWindow: number;
  /** Number of strategies tried (for Deflated Sharpe calculation) */
  numTrials?: number;
  contractDuration?: number;
  contractDurationUnit?: 't' | 's' | 'm' | 'h' | 'd';
  pipSize?: number;
  initialCapital?: number;
  parameterHash?: string;
  maxTradesPerHour?: number;
  maxOpenTrades?: number;
  entryDelayTicks?: number;
  bootstrapPolicy?: BootstrapPolicy;
  registry?: ExperimentRegistry;
  strategyDeclaration?: Record<string, unknown>;
  warmupTicks?: number;
  maxTickGapMs?: number;
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
 *   - Models a declared tick entry delay, not measured broker latency
 *   - Does not model contract unavailability
 *   - Does not model slippage (binary options are priced by Deriv, not a market)
 *   - Does not model potential changes in payout ratios over time
 */
export class BacktestEngine {
  private readonly strategyInstances = new WeakSet<Strategy>();
  constructor(private readonly config: BacktestConfig) {
    if (!Number.isInteger(config.contextWindow) || config.contextWindow < 1) throw new Error('Context window must be a positive integer');
    if (!Number.isFinite(config.minConfidence) || config.minConfidence < 0 || config.minConfidence > 1) throw new Error('Confidence must be between zero and one');
    if (!Number.isFinite(config.payoutMultiplier) || config.payoutMultiplier <= 0) throw new Error('Payout multiplier must be positive');
    if (!Number.isFinite(config.initialCapital ?? 100) || (config.initialCapital ?? 100) <= 0) throw new Error('Initial capital must be positive');
    if (!Number.isInteger(config.entryDelayTicks ?? 1) || (config.entryDelayTicks ?? 1) < 0) throw new Error('Entry delay must be nonnegative ticks');
    if (!Number.isFinite(config.feePerTrade) || config.feePerTrade < 0) throw new Error('Fee must be nonnegative');
    if (!Number.isInteger(config.contractDuration ?? 5) || (config.contractDuration ?? 5) < 1) throw new Error('Contract duration must be a positive integer');
  }

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
  run(
    features: readonly TickFeatures[],
    trainFrom: Date,
    trainTo: Date,
    validateFrom: Date,
    validateTo: Date,
    testFrom: Date,
    testTo: Date,
  ): Promise<BacktestRun> {
    let registration: { experimentId: string; attemptId: string } | undefined;
    return Promise.resolve().then(() => {
    for (let i = 0; i < features.length; i++) {
      const tick = assertDefined(features[i]);
      if (tick.symbol !== this.config.symbol || !Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(tick.timestamp.getTime())) throw new Error('Invalid backtest market event');
      if (i > 0 && tick.timestamp < assertDefined(features[i - 1]).timestamp) throw new Error('Backtest events must be chronological');
    }
    if (!(trainFrom <= trainTo && trainTo < validateFrom && validateFrom <= validateTo && validateTo < testFrom && testFrom <= testTo)) throw new Error('Backtest periods must be disjoint and chronological');

    if (this.config.registry) {
      if (!this.config.strategyDeclaration) throw new Error('Registered experiments require an explicit strategy declaration');
      registration = this.config.registry.begin(
        features.map(tick => ({ symbol: tick.symbol, timestamp: tick.timestamp.toISOString(), price: tick.price })),
        { strategy: this.config.strategyName, symbol: this.config.symbol, declaration: this.config.strategyDeclaration, parameters: this.parameters(),
          numTrials: this.config.numTrials ?? 1,
          periods: [trainFrom, trainTo, validateFrom, validateTo, testFrom, testTo].map(date => date.toISOString()) });
    }

    log.info(
      {
        strategy: this.config.strategyName,
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

    const result: BacktestRun = {
      ...(registration ? { experimentId: registration.experimentId, attemptId: registration.attemptId } : {}),
      id: crypto.randomUUID(),
      createdAt: new Date(),
      strategy: this.config.strategyName,
      symbol: this.config.symbol,
      parameters: this.parameters(),
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
    if (registration) this.config.registry?.finish(registration.attemptId, 'COMPLETED', {
      observations: result.observations.map(observation => ({ ...observation, timestamp: observation.timestamp.toISOString() })),
      note: 'Raw outcomes retained; statistical metrics are not certified by registration',
    });
    return result;
    }).catch((error: unknown) => {
      if (registration) this.config.registry?.finish(registration.attemptId, 'FAILED', { error: error instanceof Error ? error.message : 'Unknown backtest failure' });
      throw error;
    });
  }

  declaration(): Record<string, unknown> {
    return { strategy: this.config.strategyName, symbol: this.config.symbol, declaration: this.config.strategyDeclaration ?? null, parameters: this.parameters() };
  }

  private parameters(): Record<string, unknown> {
    return {
        bootstrap: this.config.bootstrapPolicy ?? DEFAULT_BOOTSTRAP_POLICY,
        payoutMultiplier: this.config.payoutMultiplier,
        feePerTrade: this.config.feePerTrade,
        minConfidence: this.config.minConfidence,
        contractDuration: this.config.contractDuration ?? 5,
        contractDurationUnit: this.config.contractDurationUnit ?? 't',
        initialCapital: this.config.initialCapital ?? 100,
        executionModel: 'Ledger-backed Options simulation; fixed payout rounded to USD cents; latest observed quote at/before time expiry',
        entryDelayTicks: this.config.entryDelayTicks ?? 1,
        maxOpenTrades: this.config.maxOpenTrades ?? 1,
        maxTradesPerHour: this.config.maxTradesPerHour ?? getEnv().MAX_TRADES_PER_HOUR,
        contextWindow: this.config.contextWindow,
        warmupTicks: this.config.warmupTicks ?? DEFAULT_WARMUP_TICKS,
        maxTickGapMs: this.config.maxTickGapMs ?? getEnv().MAX_TICK_GAP_SECONDS * 1000,
        gapPolicy: 'Reject interrupted periods; no carry-forward across gaps exceeding policy',
        featureInitialization: 'Cold start per period; features recomputed from raw prices',
        pipSize: this.config.pipSize ?? null,
        riskPolicy: {
          maxSymbolExposureFraction: getEnv().MAX_SYMBOL_EXPOSURE_FRACTION,
          maxStrategyExposureFraction: getEnv().MAX_STRATEGY_EXPOSURE_FRACTION,
          stakeAmount: getEnv().STAKE_AMOUNT ?? null,
          maxStakePercent: getEnv().MAX_STAKE_PERCENT,
          maxPerTradeFraction: getEnv().RISK_MAX_PER_TRADE_FRACTION,
          maxDailyLossFraction: getEnv().RISK_MAX_DAILY_LOSS_FRACTION,
          maxDailyLossPercent: getEnv().MAX_DAILY_LOSS_PERCENT,
          maxDrawdownFraction: getEnv().RISK_MAX_DRAWDOWN_FRACTION,
          maxConsecutiveLosses: getEnv().RISK_MAX_CONSECUTIVE_LOSSES,
          cooldownSeconds: getEnv().RISK_COOLDOWN_SECONDS,
        },
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
    const strategy = this.config.strategyFactory();
    if (this.strategyInstances.has(strategy)) throw new Error('Strategy factory must return a fresh instance for every period');
    this.strategyInstances.add(strategy);
    if (strategy.isOnlineLearner) {
      throw new Error('Online learners cannot be scored in a standard backtest; frozen evaluation is required');
    }
    const stream = new StrategyStream(this.config.symbol, [strategy], this.config.contextWindow, this.config.warmupTicks ?? DEFAULT_WARMUP_TICKS, this.config.maxTickGapMs ?? getEnv().MAX_TICK_GAP_SECONDS * 1000);
    let now = from;
    const db = new Database(':memory:');
    const startingCapital = this.config.initialCapital ?? 100;
    const ledger = new OptionsLedger(db, this.config.symbol, 'BACKTEST', startingCapital, (): Date => now);
    const env = { ...getEnv(), CONTRACT_DURATION: this.config.contractDuration ?? 5,
      CONTRACT_DURATION_UNIT: this.config.contractDurationUnit ?? 't',
      MIN_CONSENSUS_CONFIDENCE: this.config.minConfidence,
      MAX_OPEN_TRADES: this.config.maxOpenTrades ?? 1,
      MAX_TRADES_PER_HOUR: this.config.maxTradesPerHour ?? getEnv().MAX_TRADES_PER_HOUR };
    const risk = new RiskEngine(startingCapital, 'USD', ledger, { now: (): Date => now, env, executionFee: this.config.feePerTrade });
    const executor = new SimulatedExecutionEngine(ledger, {
      payoutMultiplier: this.config.payoutMultiplier, feePerTrade: this.config.feePerTrade,
      ...(this.config.pipSize !== undefined ? { pipSize: this.config.pipSize } : {}),
    });
    const pending: { index: number; signal: Signal }[] = [];
    const duration = env.CONTRACT_DURATION;
    const unit = env.CONTRACT_DURATION_UNIT;
    const durationMs = unit === 't' ? null : duration * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
    try {
      for (let i = 0; i < periodFeatures.length; i++) {
        const current = assertDefined(periodFeatures[i]);
        now = current.timestamp;
        const tick: Tick = { symbol: current.symbol, timestamp: now, epoch: now.getTime() / 1000, price: current.price };
        for (const settlement of executor.onTick(tick, profit => { risk.recordTradeResult(profit); })) {
          observations.push({ timestamp: settlement.entryTime, symbol: settlement.symbol,
            entryPrice: settlement.entryPrice, exitPrice: settlement.exitPrice, direction: settlement.direction,
            stake: settlement.stake, profit: settlement.profit, returnPct: settlement.profit / settlement.stake, won: settlement.profit > 0 });
        }
        const signal = stream.process(tick).signals[0];
        if (signal && signal.direction !== 'NONE' && signal.confidence >= this.config.minConfidence) {
          pending.push({ index: i + (this.config.entryDelayTicks ?? 1), signal });
        }
        for (const order of pending.filter(item => item.index === i)) {
          // Predeclared period boundaries prohibit positions crossing train/validation/test.
          const fits = durationMs === null ? i + duration < periodFeatures.length : now.getTime() + durationMs <= assertDefined(periodFeatures.at(-1)).timestamp.getTime();
          if (!fits) continue;
          const decision = risk.evaluate(order.signal, 'BACKTEST');
          if (decision.approved) executor.execute(decision.approvedSignal, tick);
        }
        while (pending.length && assertDefined(pending[0]).index <= i) pending.shift();
      }
      if (executor.getOpenCount() !== 0) throw new Error('Simulation ended with unresolved contracts');
      return observations;
    } finally { db.close(); }
  }

  // ---------------------------------------------------------------------------
  // Private: Metrics Computation
  // ---------------------------------------------------------------------------

  computeMetrics(
    observations: readonly BacktestObservation[],
    mode: 'BACKTEST',
    from: Date,
    to: Date,
    numTrials: number,
  ): PerformanceMetrics {
    const paramHash = this.config.parameterHash ?? this.config.strategyName;

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
    let equity = this.config.initialCapital ?? 100;
    const equityCurve = [equity, ...profits.map((p) => (equity += p))];
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
    // Trades are irregularly spaced; no annualized return series supports Calmar here.
    const calmar = null;

    const ci95 = blockBootstrapMean([returns], this.config.bootstrapPolicy ?? DEFAULT_BOOTSTRAP_POLICY);

    // Edge status
    const edgeStatus = this.determineEdgeStatus(observations.length, dsr, ci95, maxDrawdownPct);

    return {
      mode,
      strategy: this.config.strategyName,
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
    ci95: [number, number] | null,
    maxDrawdownPct: number,
  ): PerformanceMetrics['edgeStatus'] {
    if (tradeCount < MIN_TRADES_FOR_SHARPE) return 'INSUFFICIENT_EVIDENCE';

    if (dsr === null || ci95 === null) return 'INSUFFICIENT_EVIDENCE';

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
      strategy: this.config.strategyName,
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

export { contractWon } from './contractOutcome.js';
