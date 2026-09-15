import type { TradingMode } from './trade.js';

/**
 * A single observation in a backtest — one trade's contribution.
 */
export interface BacktestObservation {
  readonly timestamp: Date;
  readonly symbol: string;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly direction: 'BUY' | 'SELL';
  readonly stake: number;
  readonly profit: number;
  readonly returnPct: number; // profit / stake
  readonly won: boolean;
}

/**
 * Comprehensive performance metrics for a backtest run or live period.
 * These metrics must never mix data from different TradingModes.
 */
export interface PerformanceMetrics {
  // Identity
  readonly mode: TradingMode;
  readonly strategy: string;
  readonly symbol: string;
  readonly fromDate: Date;
  readonly toDate: Date;
  readonly parameterHash: string; // Hash of strategy parameters (for PBO)

  // Trade counts
  readonly totalTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number; // wins / totalTrades
  readonly lossRate: number;

  // P&L
  readonly totalProfit: number;
  readonly totalStaked: number;
  readonly netReturn: number; // totalProfit / totalStaked
  readonly averageWin: number;
  readonly averageLoss: number;
  readonly profitFactor: number; // |sum wins| / |sum losses|
  readonly expectancy: number; // P(win)*avgWin - P(loss)*avgLoss

  // Risk
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number;
  readonly longestLosingStreak: number;
  readonly longestWinningStreak: number;
  readonly maxConsecutiveLosses: number;

  // Risk-adjusted returns
  readonly sharpeRatio: number | null; // Annualized, stddev of returns denominator
  readonly sortinoRatio: number | null; // Downside deviation denominator
  readonly calmarRatio: number | null; // Net return / maxDrawdown

  // Statistical
  readonly deflatedSharpe: number | null; // DSR-corrected Sharpe
  readonly pValueSharpe: number | null; // H0: Sharpe <= 0
  readonly confidenceInterval95: readonly [number, number] | null; // 95% CI on expectancy

  // Overfitting
  readonly pbo: number | null; // Probability of Backtest Overfitting [0,1]
  readonly edgeStatus:
    'EDGE_DETECTED' | 'EDGE_NOT_DETECTED' | 'INSUFFICIENT_EVIDENCE' | 'OVERFIT_RISK_HIGH';
}

/**
 * A complete backtest run — one strategy, one symbol, one parameter set.
 */
export interface BacktestRun {
  readonly experimentId?: string;
  readonly attemptId?: string;
  readonly id: string;
  readonly createdAt: Date;
  readonly strategy: string;
  readonly symbol: string;
  readonly parameters: Record<string, unknown>;
  readonly trainFrom: Date;
  readonly trainTo: Date;
  readonly validateFrom: Date;
  readonly validateTo: Date;
  readonly testFrom: Date;
  readonly testTo: Date;
  readonly trainMetrics: PerformanceMetrics;
  readonly validateMetrics: PerformanceMetrics;
  readonly testMetrics: PerformanceMetrics; // Only inspected AFTER validation
  readonly observations: readonly BacktestObservation[];
}

/**
 * Walk-forward result — aggregation of multiple train/validate/test windows.
 */
export interface WalkForwardResult {
  readonly id: string;
  readonly strategy: string;
  readonly symbol: string;
  readonly windows: readonly BacktestRun[];
  readonly aggregatedTestMetrics: PerformanceMetrics;
  readonly isRobust: boolean; // True if edge detected across majority of windows
}
