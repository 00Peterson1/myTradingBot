import { assertDefined } from '../../utils/assertDefined.js';
/**
 * Statistical validation tools for quantitative research.
 *
 * Implements:
 *   - Sharpe Ratio & Sortino Ratio
 *   - Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014)
 *   - Probability of Backtest Overfitting (Bailey et al., 2014)
 *   - Ljung-Box autocorrelation test
 *   - Jarque-Bera normality test
 *   - Conditional probability analysis
 *   - Multiple hypothesis testing corrections
 *
 * IMPORTANT: These are research tools. A statistically significant result
 * does NOT guarantee future profitability — especially on synthetic indices
 * where the data-generating process may change or may not be exploitable
 * after costs.
 */

import { mean, stddev, skewness, kurtosis } from '../../features/indicators/indicators.js';
import { MIN_TRADES_FOR_SHARPE } from '../../config/constants.js';

// ---------------------------------------------------------------------------
// Normal Distribution Utilities (approximation — no external libs)
// ---------------------------------------------------------------------------

/**
 * Approximation of the standard normal CDF using Abramowitz & Stegun formula.
 * Accurate to ±1.5×10⁻⁷.
 */
export function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/**
 * Inverse standard normal CDF (Beasley-Springer-Moro algorithm).
 */
export function normalInvCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((assertDefined(c[0]) * q + assertDefined(c[1])) * q + assertDefined(c[2])) * q + assertDefined(c[3])) * q + assertDefined(c[4])) * q + assertDefined(c[5])) /
      ((((assertDefined(d[0]) * q + assertDefined(d[1])) * q + assertDefined(d[2])) * q + assertDefined(d[3])) * q + 1)
    );
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((assertDefined(a[0]) * r + assertDefined(a[1])) * r + assertDefined(a[2])) * r + assertDefined(a[3])) * r + assertDefined(a[4])) * r + assertDefined(a[5])) * q) /
      (((((assertDefined(b[0]) * r + assertDefined(b[1])) * r + assertDefined(b[2])) * r + assertDefined(b[3])) * r + assertDefined(b[4])) * r + 1)
    );
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((assertDefined(c[0]) * q + assertDefined(c[1])) * q + assertDefined(c[2])) * q + assertDefined(c[3])) * q + assertDefined(c[4])) * q + assertDefined(c[5])) /
      ((((assertDefined(d[0]) * q + assertDefined(d[1])) * q + assertDefined(d[2])) * q + assertDefined(d[3])) * q + 1)
    );
  }
}

// ---------------------------------------------------------------------------
// Sharpe & Sortino Ratios
// ---------------------------------------------------------------------------

export interface SharpeResult {
  sharpe: number;
  annualizedSharpe: number;
  observations: number;
  meanReturn: number;
  stdReturn: number;
}

/**
 * Computes Sharpe Ratio from a series of returns.
 * Sharpe = mean(r) / std(r) * sqrt(periods_per_year)
 *
 * For tick-level strategies, periodsPerYear should reflect the actual
 * sampling frequency. Use with care — different frequencies give very
 * different Sharpe values.
 */
export function computeSharpe(
  returns: readonly number[],
  periodsPerYear = 1,
  riskFreeRate = 0,
): SharpeResult | null {
  if (returns.length < MIN_TRADES_FOR_SHARPE) return null;

  const excess = returns.map((r) => r - riskFreeRate / periodsPerYear);
  const m = mean(excess);
  const s = stddev(excess);

  if (s === 0) return null;

  const sharpe = m / s;
  const annualizedSharpe = sharpe * Math.sqrt(periodsPerYear);

  return {
    sharpe,
    annualizedSharpe,
    observations: returns.length,
    meanReturn: m,
    stdReturn: s,
  };
}

/**
 * Sortino Ratio — uses downside deviation instead of total std.
 * More appropriate when return distribution is asymmetric.
 */
export function computeSortino(
  returns: readonly number[],
  periodsPerYear = 1,
  targetReturn = 0,
): number | null {
  if (returns.length < MIN_TRADES_FOR_SHARPE) return null;

  const m = mean(returns) - targetReturn / periodsPerYear;
  const downsideReturns = returns.filter((r) => r < targetReturn / periodsPerYear);

  if (downsideReturns.length === 0) return null;

  const downsideVariance =
    downsideReturns.reduce((acc, r) => acc + Math.pow(r - targetReturn / periodsPerYear, 2), 0) /
    returns.length;
  const downsideStd = Math.sqrt(downsideVariance);

  if (downsideStd === 0) return null;
  return (m / downsideStd) * Math.sqrt(periodsPerYear);
}

// ---------------------------------------------------------------------------
// Deflated Sharpe Ratio (DSR)
// ---------------------------------------------------------------------------
// Bailey, D.H. & Lopez de Prado, M. (2014)
// "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest
//  Overfitting, and Non-Normality"
//
// DSR corrects the Sharpe ratio for:
// 1. Non-normality of returns (skewness and kurtosis)
// 2. Multiple testing / selection bias (how many strategies were tried)
// 3. Finite sample size
//
// Interpretation:
//   DSR close to 1 → Sharpe likely real
//   DSR close to 0 → Sharpe likely due to selection bias / overfitting

export interface DeflatedSharpeResult {
  sharpeObs: number; // Observed Sharpe ratio
  sharpeRef: number; // Reference (expected max Sharpe under H0)
  dsr: number; // Deflated Sharpe Ratio ∈ [0,1]
  pValue: number; // Probability that true Sharpe > 0
  skew: number | null;
  excessKurtosis: number | null;
}

/**
 * Computes the Deflated Sharpe Ratio.
 *
 * @param returns - Out-of-sample returns of the selected strategy
 * @param numTrials - Number of strategies/parameters tried (selection bias)
 * @param sharpeRef - Expected Sharpe of best strategy under H0 (if known)
 */
export function deflatedSharpeRatio(
  returns: readonly number[],
  numTrials = 1,
  sharpeRef?: number,
): DeflatedSharpeResult | null {
  const n = returns.length;
  if (n < MIN_TRADES_FOR_SHARPE) return null;

  const skew = skewness(returns);
  const exKurt = kurtosis(returns);
  const m = mean(returns);
  const s = stddev(returns);

  if (s === 0) return null;

  const sharpeObs = m / s; // Per-period Sharpe (not annualized)

  // Expected maximum Sharpe under H0 across numTrials strategies
  // Using the Euler-Mascheroni approximation for E[max(Z_1,...,Z_N)]
  const gamma = 0.5772156649; // Euler-Mascheroni constant
  const ref =
    sharpeRef ??
    (1 - gamma) * normalInvCDF(1 - 1 / numTrials) +
      gamma * normalInvCDF(1 - 1 / (numTrials * Math.E));

  // Variance of the Sharpe estimator corrected for non-normality
  // V[SR] = (1 + (1/2)*SR²*(k-1) - SR*skew) / (n-1)
  // where k = excess kurtosis + 3 (full kurtosis)
  const fullKurtosis = (exKurt ?? 0) + 3;
  const skewVal = skew ?? 0;
  const varSharpe =
    (1 + 0.5 * Math.pow(sharpeObs, 2) * (fullKurtosis - 1) - sharpeObs * skewVal) / (n - 1);

  if (varSharpe <= 0) return null;

  const z = (sharpeObs - ref) / Math.sqrt(varSharpe);
  const dsr = normalCDF(z);
  const pValue = 1 - normalCDF(sharpeObs / Math.sqrt((1 + 0.5 * sharpeObs * sharpeObs) / (n - 1)));

  return {
    sharpeObs,
    sharpeRef: ref,
    dsr,
    pValue,
    skew: skew,
    excessKurtosis: exKurt,
  };
}

// ---------------------------------------------------------------------------
// Probability of Backtest Overfitting (PBO)
// ---------------------------------------------------------------------------
// Bailey, D.H., Borwein, J., Lopez de Prado, M., Zhu, Q. (2014)
// "Pseudomathematics and Financial Charlatanism"
// "The Probability of Backtest Overfitting"
//
// Uses Combinatorially Symmetric Cross Validation (CSCV).
//
// Steps:
//   1. Divide returns into S submatrices (here S/2 train, S/2 test combinations)
//   2. For each partition: rank strategies by train Sharpe, pick best
//   3. Check if that strategy ranks above median on test set
//   4. PBO = fraction of partitions where winner underperforms median
//
// PBO > 0.5 is alarming — more than half the time the "best" backtest
// strategy underperforms on out-of-sample data.

export interface PBOResult {
  pbo: number; // Probability of backtest overfitting ∈ [0, 1]
  partitions: number; // Number of CSCV partitions used
  numStrategies: number; // Number of strategies evaluated
  interpretaton: string;
}

/**
 * Computes PBO using Combinatorially Symmetric Cross Validation.
 *
 * @param strategyReturns - Matrix [strategy][period] of per-period returns
 * @param numPartitions - Number of time partitions (S, must be even, default 16)
 */
export function probabilityOfBacktestOverfitting(
  strategyReturns: readonly (readonly number[])[],
  numPartitions = 16,
): PBOResult | null {
  const numStrategies = strategyReturns.length;
  if (numStrategies < 2) return null;

  const T = strategyReturns[0]?.length ?? 0;
  if (T < numPartitions) return null;

  const S = numPartitions;
  const halfS = S / 2;

  // Divide time series into S blocks
  const blockSize = Math.floor(T / S);
  const blocks: number[][] = [];

  for (let s = 0; s < S; s++) {
    const start = s * blockSize;
    const end = s === S - 1 ? T : start + blockSize;
    blocks.push(Array.from({ length: end - start }, (_, i) => start + i));
  }

  // All combinations of S/2 blocks for training
  const trainCombinations = combinations(
    Array.from({ length: S }, (_, i) => i),
    halfS,
  );

  let overfit = 0;

  for (const trainIdx of trainCombinations) {
    const testIdx = Array.from({ length: S }, (_, i) => i).filter((i) => !trainIdx.includes(i));

    const trainPeriods = trainIdx.flatMap((i) => blocks[i] ?? []);
    const testPeriods = testIdx.flatMap((i) => blocks[i] ?? []);

    // Compute Sharpe for each strategy on train set
    const trainSharpes = strategyReturns.map((r) => {
      const trainReturns = trainPeriods.map((t) => r[t] ?? 0);
      const m = mean(trainReturns);
      const s = stddev(trainReturns);
      return s === 0 ? 0 : m / s;
    });

    // Find best strategy on train set
    const bestStrategyIdx = trainSharpes.indexOf(Math.max(...trainSharpes));

    // Compute Sharpe for each strategy on test set
    const testSharpes = strategyReturns.map((r) => {
      const testReturns = testPeriods.map((t) => r[t] ?? 0);
      const m = mean(testReturns);
      const s = stddev(testReturns);
      return s === 0 ? 0 : m / s;
    });

    // Check if best train strategy is above median on test
    const bestTestSharpe = testSharpes[bestStrategyIdx] ?? 0;
    const sortedTestSharpes = [...testSharpes].sort((a, b) => a - b);
    const medianTestSharpe = sortedTestSharpes[Math.floor(sortedTestSharpes.length / 2)] ?? 0;

    if (bestTestSharpe < medianTestSharpe) {
      overfit++;
    }
  }

  const pbo = overfit / trainCombinations.length;

  return {
    pbo,
    partitions: S,
    numStrategies,
    interpretaton: interpretPBO(pbo),
  };
}

function interpretPBO(pbo: number): string {
  if (pbo < 0.1) return 'LOW OVERFIT RISK — Strategy appears robust';
  if (pbo < 0.25) return 'MODERATE OVERFIT RISK — Some caution warranted';
  if (pbo < 0.5) return 'ELEVATED OVERFIT RISK — Strong caution warranted';
  return 'HIGH OVERFIT RISK — Strategy likely overfit to training data';
}

/** Computes all combinations of size k from array. */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  if (first === undefined) return [];
  const withFirst = combinations(rest, k - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

// ---------------------------------------------------------------------------
// Ljung-Box Autocorrelation Test
// ---------------------------------------------------------------------------
// Tests H0: no autocorrelation up to lag m.
// Reject H0 if Q > chi2_critical(m), suggesting non-random structure.

export interface LjungBoxResult {
  Q: number; // Ljung-Box statistic
  lags: number;
  observations: number;
  pValue: number; // Approximate p-value (chi-squared)
  rejectH0: boolean; // True if autocorrelation detected
}

/**
 * Ljung-Box test for autocorrelation.
 *
 * @param returns - Array of returns
 * @param lags - Number of lags to test (m)
 * @param alpha - Significance level
 */
export function ljungBoxTest(
  returns: readonly number[],
  lags = 20,
  alpha = 0.05,
): LjungBoxResult | null {
  const n = returns.length;
  if (n <= lags) return null;

  const m = mean(returns);
  const demeaned = returns.map((r) => r - m);
  const variance = demeaned.reduce((acc, r) => acc + r * r, 0) / n;

  if (variance === 0) return null;

  // Compute autocorrelations at each lag
  let Q = 0;
  for (let k = 1; k <= lags; k++) {
    let cov = 0;
    for (let t = k; t < n; t++) {
      cov += (demeaned[t] ?? 0) * (demeaned[t - k] ?? 0);
    }
    const rk = cov / (n * variance);
    Q += (rk * rk) / (n - k);
  }
  Q *= n * (n + 2);

  // Chi-squared p-value approximation (Wilson-Hilferty)
  const df = lags;
  const pValue = 1 - chi2CDF(Q, df);

  return {
    Q,
    lags,
    observations: n,
    pValue,
    rejectH0: pValue < alpha,
  };
}

/**
 * Chi-squared CDF approximation (Wilson-Hilferty transformation).
 */
function chi2CDF(x: number, df: number): number {
  if (x <= 0) return 0;
  // Wilson-Hilferty: transform to standard normal
  const z = Math.pow(x / df, 1 / 3) - (1 - 2 / (9 * df));
  const sigma = Math.sqrt(2 / (9 * df));
  return normalCDF(z / sigma);
}

// ---------------------------------------------------------------------------
// Jarque-Bera Normality Test
// ---------------------------------------------------------------------------

export interface JarqueBerаResult {
  JB: number;
  pValue: number;
  isNormal: boolean; // True if we FAIL to reject normality
  skewness: number | null;
  excessKurtosis: number | null;
}

/**
 * Jarque-Bera test for normality of returns.
 * H0: returns are normally distributed.
 *
 * Financial returns almost always reject normality (fat tails, skew).
 * This matters for Sharpe ratio validity and risk calculations.
 */
export function jarqueBera(returns: readonly number[], alpha = 0.05): JarqueBerаResult | null {
  const n = returns.length;
  if (n < 8) return null;

  const sk = skewness(returns);
  const exKurt = kurtosis(returns);

  if (sk === null || exKurt === null) return null;

  const JB = (n / 6) * (Math.pow(sk, 2) + Math.pow(exKurt, 2) / 4);
  const pValue = 1 - chi2CDF(JB, 2);

  return {
    JB,
    pValue,
    isNormal: pValue >= alpha,
    skewness: sk,
    excessKurtosis: exKurt,
  };
}

// ---------------------------------------------------------------------------
// Conditional Probability Analysis
// ---------------------------------------------------------------------------
// Key research question: P(next return > 0 | condition) vs P(next return > 0)
// If these are similar, there is no conditional edge.

export interface ConditionalProbResult {
  condition: string;
  unconditional: number; // P(positive return)
  conditional: number; // P(positive return | condition)
  lift: number; // conditional / unconditional
  observations: number; // Count of observations where condition was true
  totalObservations: number;
  isSignificant: boolean; // Simple proportion test
  pValue: number;
}

/**
 * Computes conditional probability of next return being positive
 * given a user-defined condition function.
 *
 * @param returns - Array of returns (r[i] is the return at period i)
 * @param condition - Function that returns true when the condition is met for index i
 * @param alpha - Significance level for hypothesis test
 */
export function conditionalProbability(
  returns: readonly number[],
  condition: (i: number, returns: readonly number[]) => boolean,
  conditionName: string,
  alpha = 0.05,
): ConditionalProbResult | null {
  // Unconditional: fraction of returns > 0 (excluding last)
  const usable = returns.slice(0, -1); // Use all but last (need next return)
  if (usable.length < 30) return null;

  const unconditional = usable.filter((_, i) => (returns[i + 1] ?? 0) > 0).length / usable.length;

  // Conditional
  let condCount = 0;
  let condPositive = 0;

  for (let i = 0; i < usable.length; i++) {
    if (condition(i, returns)) {
      condCount++;
      if ((returns[i + 1] ?? 0) > 0) condPositive++;
    }
  }

  if (condCount < 10) return null;

  const conditional = condPositive / condCount;
  const lift = unconditional === 0 ? 0 : conditional / unconditional;

  // Two-proportion z-test
  const p1 = conditional;
  const p2 = unconditional;
  const n1 = condCount;
  const n2 = usable.length;
  const pooledP = (condPositive + unconditional * n2) / (n1 + n2);
  const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p1 - p2) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  return {
    condition: conditionName,
    unconditional,
    conditional,
    lift,
    observations: condCount,
    totalObservations: usable.length,
    isSignificant: pValue < alpha,
    pValue,
  };
}

// ---------------------------------------------------------------------------
// Multiple Hypothesis Testing Corrections
// ---------------------------------------------------------------------------

/**
 * Benjamini-Hochberg-Yekutieli (BHY) procedure for controlling
 * False Discovery Rate under arbitrary dependence.
 * More appropriate than Bonferroni when many correlated tests are run.
 *
 * Returns corrected p-values (reject H0 where corrected p < alpha).
 */
export function benjaminiHochbergYekutieli(
  pValues: readonly number[],
  alpha = 0.05,
): { original: number; corrected: number; rejected: boolean }[] {
  const n = pValues.length;
  const harmonicSum = Array.from({ length: n }, (_, i) => 1 / (i + 1)).reduce((a, b) => a + b, 0);
  const adjustedAlpha = alpha / harmonicSum;

  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);

  const corrected = new Array<number>(n);
  let maxRejected = -1;

  for (let rank = 0; rank < n; rank++) {
    const criticalValue = ((rank + 1) / n) * adjustedAlpha;
    const item = indexed[rank];
    if (item && item.p <= criticalValue) {
      maxRejected = rank;
    }
  }

  for (let rank = 0; rank < n; rank++) {
    const item = indexed[rank];
    if (!item) continue;
    corrected[item.i] = Math.min(1, (item.p * n * harmonicSum) / (rank + 1));
  }

  return pValues.map((p, i) => {
    const rank = indexed.findIndex((item) => item.i === i);
    return {
      original: p,
      corrected: corrected[i] ?? 1,
      rejected: rank <= maxRejected,
    };
  });
}

/**
 * Bonferroni correction — conservative, assumes independence.
 * corrected p = original p * n_tests
 */
export function bonferroniCorrection(
  pValues: readonly number[],
  alpha = 0.05,
): { original: number; corrected: number; rejected: boolean }[] {
  const n = pValues.length;
  return pValues.map((p) => {
    const corrected = Math.min(1, p * n);
    return { original: p, corrected, rejected: corrected < alpha };
  });
}

// ---------------------------------------------------------------------------
// Max Drawdown
// ---------------------------------------------------------------------------

export interface DrawdownResult {
  maxDrawdown: number; // Absolute value (negative number)
  maxDrawdownPct: number; // Percentage (e.g., -0.15 = -15%)
  longestDrawdownPeriods: number;
}

export function computeMaxDrawdown(equityCurve: readonly number[]): DrawdownResult {
  if (equityCurve.length === 0) {
    return { maxDrawdown: 0, maxDrawdownPct: 0, longestDrawdownPeriods: 0 };
  }

  let peak = equityCurve[0] ?? 0;
  let maxDD = 0;
  let maxDDPct = 0;
  let currentDrawdownStart = 0;
  let longestDrawdown = 0;

  for (let i = 1; i < equityCurve.length; i++) {
    const v = equityCurve[i] ?? 0;
    if (v > peak) {
      peak = v;
      currentDrawdownStart = i;
    } else {
      const dd = v - peak;
      const ddPct = peak === 0 ? 0 : dd / peak;
      if (dd < maxDD) maxDD = dd;
      if (ddPct < maxDDPct) maxDDPct = ddPct;
      longestDrawdown = Math.max(longestDrawdown, i - currentDrawdownStart);
    }
  }

  return {
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct,
    longestDrawdownPeriods: longestDrawdown,
  };
}
