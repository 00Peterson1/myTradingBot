/**
 * Pure mathematical functions for financial time-series features.
 *
 * CRITICAL INVARIANT: All functions here are strictly causal.
 * A value at index i may only depend on values at indices 0..i.
 * Future data NEVER leaks into past features.
 *
 * Every function is stateless and operates on arrays.
 * The FeatureEngine owns the windowing logic.
 */

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/**
 * Computes log return: ln(price[i] / price[i-1]).
 * Returns null for index 0 (no previous price).
 */
export function logReturn(prices: readonly number[], i: number): number | null {
  if (i <= 0 || i >= prices.length) return null;
  const prev = prices[i - 1];
  const curr = prices[i];
  if (prev === undefined || curr === undefined || prev <= 0 || curr <= 0) return null;
  return Math.log(curr / prev);
}

/**
 * Computes simple return: (price[i] - price[i-1]) / price[i-1].
 */
export function simpleReturn(prices: readonly number[], i: number): number | null {
  if (i <= 0 || i >= prices.length) return null;
  const prev = prices[i - 1];
  const curr = prices[i];
  if (prev === undefined || curr === undefined || prev === 0) return null;
  return (curr - prev) / prev;
}

// ---------------------------------------------------------------------------
// Momentum
// ---------------------------------------------------------------------------

/**
 * Time-series momentum: log return over k periods.
 * R_t(k) = ln(price[i] / price[i-k])
 *
 * Based on Moskowitz, Ooi & Pedersen (2012):
 * "Time Series Momentum", Journal of Financial Economics.
 */
export function momentum(prices: readonly number[], i: number, k: number): number | null {
  if (i < k || i >= prices.length) return null;
  const past = prices[i - k];
  const curr = prices[i];
  if (past === undefined || curr === undefined || past <= 0 || curr <= 0) return null;
  return Math.log(curr / past);
}

// ---------------------------------------------------------------------------
// Rolling Statistics
// ---------------------------------------------------------------------------

/**
 * Rolling mean of prices over a window ending at index i.
 * Uses exactly `window` values if available, otherwise null.
 */
export function rollingMean(prices: readonly number[], i: number, window: number): number | null {
  if (i < window - 1 || i >= prices.length) return null;
  const slice = prices.slice(i - window + 1, i + 1);
  if (slice.length < window) return null;
  return slice.reduce((a, b) => a + b, 0) / window;
}

/**
 * Rolling standard deviation of prices over a window (population std).
 * Returns null if fewer than `window` values available.
 */
export function rollingStd(prices: readonly number[], i: number, window: number): number | null {
  const mean = rollingMean(prices, i, window);
  if (mean === null) return null;
  const slice = prices.slice(i - window + 1, i + 1);
  const variance = slice.reduce((acc, p) => acc + Math.pow(p - mean, 2), 0) / window;
  return Math.sqrt(variance);
}

/**
 * Rolling standard deviation of an array of returns (not prices).
 */
export function rollingStdOfReturns(
  returns: readonly (number | null)[],
  i: number,
  window: number,
): number | null {
  if (i < window - 1) return null;
  const slice: number[] = [];
  for (let j = i - window + 1; j <= i; j++) {
    const r = returns[j];
    if (r === null || r === undefined) return null;
    slice.push(r);
  }
  if (slice.length < window) return null;
  const mean = slice.reduce((a, b) => a + b, 0) / window;
  const variance = slice.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / window;
  return Math.sqrt(variance);
}

/**
 * Realized volatility: sqrt(sum of squared log returns over window).
 * This is the standard realized variance estimator (Andersen & Bollerslev, 1998).
 */
export function realizedVolatility(
  logReturns: readonly (number | null)[],
  i: number,
  window: number,
): number | null {
  if (i < window - 1) return null;
  let sumSq = 0;
  for (let j = i - window + 1; j <= i; j++) {
    const r = logReturns[j];
    if (r === null || r === undefined) return null;
    sumSq += r * r;
  }
  return Math.sqrt(sumSq);
}

// ---------------------------------------------------------------------------
// Z-Score (Mean Reversion Signal)
// ---------------------------------------------------------------------------

/**
 * Z-score of price relative to rolling mean and std.
 * Z = (price - mean) / std
 *
 * Used for mean-reversion strategies: extreme Z implies expected reversal.
 */
export function zScore(prices: readonly number[], i: number, window: number): number | null {
  const mean = rollingMean(prices, i, window);
  const std = rollingStd(prices, i, window);
  if (mean === null || std === null || std === 0) return null;
  const curr = prices[i];
  if (curr === undefined) return null;
  return (curr - mean) / std;
}

/**
 * Volatility-adjusted momentum (z-score of momentum return).
 * Z_t = momentum(k) / realized_vol
 *
 * Based on Barroso & Santa-Clara (2015):
 * "Momentum has its moments"
 */
export function volAdjustedMomentum(
  prices: readonly number[],
  logReturns: readonly (number | null)[],
  i: number,
  momentumWindow: number,
  volWindow: number,
): number | null {
  const mom = momentum(prices, i, momentumWindow);
  const vol = realizedVolatility(logReturns, i, volWindow);
  if (mom === null || vol === null || vol === 0) return null;
  return mom / vol;
}

// ---------------------------------------------------------------------------
// Rolling High / Low (Breakout Features)
// ---------------------------------------------------------------------------

export function rollingHigh(prices: readonly number[], i: number, window: number): number | null {
  if (i < window - 1 || i >= prices.length) return null;
  const slice = prices.slice(i - window + 1, i + 1);
  return Math.max(...slice);
}

export function rollingLow(prices: readonly number[], i: number, window: number): number | null {
  if (i < window - 1 || i >= prices.length) return null;
  const slice = prices.slice(i - window + 1, i + 1);
  return Math.min(...slice);
}

/**
 * Drawdown from rolling high: (price - rollingHigh) / rollingHigh
 * Always <= 0. A value of -0.05 means 5% below the rolling high.
 */
export function drawdownFromHigh(
  prices: readonly number[],
  i: number,
  window: number,
): number | null {
  const high = rollingHigh(prices, i, window);
  const curr = prices[i];
  if (high === null || curr === undefined || high === 0) return null;
  return (curr - high) / high;
}

// ---------------------------------------------------------------------------
// Autocorrelation (Lag-1)
// ---------------------------------------------------------------------------

/**
 * Pearson autocorrelation of returns at lag `lag`, using the past `window` returns.
 * AC(1) = corr(r[t], r[t-1]) over the window.
 *
 * Positive AC(1) suggests momentum / trending behavior.
 * Negative AC(1) suggests mean-reversion / anti-persistence.
 * Zero AC(1) is consistent with a random walk (EMH).
 */
export function autocorrelation(
  returns: readonly (number | null)[],
  i: number,
  window: number,
  lag = 1,
): number | null {
  if (i < window + lag - 1) return null;

  const y: number[] = [];
  const x: number[] = [];

  for (let j = i - window + 1; j <= i; j++) {
    const curr = returns[j];
    const prev = returns[j - lag];
    if (curr === null || curr === undefined || prev === null || prev === undefined) return null;
    y.push(curr);
    x.push(prev);
  }

  if (y.length < window) return null;

  return pearsonCorrelation(x, y);
}

/**
 * Pearson correlation coefficient between two equal-length arrays.
 * Returns null if computation is not possible.
 */
export function pearsonCorrelation(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n !== y.length || n < 2) return null;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    const dx = xi - meanX;
    const dy = yi - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return null;
  return num / denom;
}

// ---------------------------------------------------------------------------
// Descriptive Statistics
// ---------------------------------------------------------------------------

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function variance(values: readonly number[], ddof = 1): number {
  if (values.length <= ddof) return 0;
  const m = mean(values);
  return values.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / (values.length - ddof);
}

export function stddev(values: readonly number[], ddof = 1): number {
  return Math.sqrt(variance(values, ddof));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

/**
 * Skewness (Fisher's moment coefficient of skewness).
 * Positive = right tail, negative = left tail.
 */
export function skewness(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const m = mean(values);
  const s = stddev(values, 1);
  if (s === 0) return null;
  const sum = values.reduce((acc, v) => acc + Math.pow((v - m) / s, 3), 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

/**
 * Excess kurtosis (kurtosis - 3).
 * 0 = normal, positive = fat tails, negative = thin tails.
 * Financial returns typically have positive excess kurtosis (leptokurtic).
 */
export function kurtosis(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 4) return null;
  const m = mean(values);
  const s = stddev(values, 1);
  if (s === 0) return null;
  const sum = values.reduce((acc, v) => acc + Math.pow((v - m) / s, 4), 0);
  const k =
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum -
    (3 * Math.pow(n - 1, 2)) / ((n - 2) * (n - 3));
  return k; // Excess kurtosis
}

// ---------------------------------------------------------------------------
// Exponential Moving Average
// ---------------------------------------------------------------------------

/**
 * Exponential Moving Average at index i with given period.
 *
 * Uses the standard EMA formula: EMA_t = α * P_t + (1 - α) * EMA_{t-1}
 * where α = 2 / (period + 1)
 *
 * Initialization: EMA is seeded with the SMA of the first `period` values.
 * Returns null if fewer than `period` values are available.
 *
 * CAUSAL: only uses prices[0..i].
 */
export function ema(prices: readonly number[], i: number, period: number): number | null {
  if (i < period - 1 || i >= prices.length) return null;

  const alpha = 2 / (period + 1);

  // Seed with SMA of first `period` values
  const seedSlice = prices.slice(0, period);
  let emaValue = seedSlice.reduce((a, b) => a + b, 0) / period;

  // Apply EMA formula from index `period` to `i`
  for (let j = period; j <= i; j++) {
    const p = prices[j];
    if (p === undefined) return null;
    emaValue = alpha * p + (1 - alpha) * emaValue;
  }

  return emaValue;
}
