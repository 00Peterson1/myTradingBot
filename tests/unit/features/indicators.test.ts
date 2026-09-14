import { assertDefined } from '../../../src/utils/assertDefined.js';
import { describe, it, expect } from 'vitest';
import {
  logReturn,
  simpleReturn,
  momentum,
  rollingMean,
  rollingStd,
  realizedVolatility,
  zScore,
  rollingHigh,
  rollingLow,
  drawdownFromHigh,
  autocorrelation,
  pearsonCorrelation,
  mean,
  stddev,
  median,
  skewness,
  kurtosis,
} from '../../../src/features/indicators/indicators.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const prices = [100, 101, 99, 102, 100, 103, 101, 104, 102, 105];

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

describe('logReturn', () => {
  it('returns null for index 0 (no prior price)', () => {
    expect(logReturn(prices, 0)).toBeNull();
  });

  it('computes correct log return at index 1', () => {
    const expected = Math.log(101 / 100);
    expect(logReturn(prices, 1)).toBeCloseTo(expected, 10);
  });

  it('returns null for out-of-bounds index', () => {
    expect(logReturn(prices, prices.length)).toBeNull();
    expect(logReturn(prices, -1)).toBeNull();
  });

  it('returns null when prior price is 0', () => {
    expect(logReturn([0, 1], 1)).toBeNull();
  });

  // Critical: no future data leaks into past
  it('INVARIANT: value at index i only uses prices[0..i]', () => {
    const pricesA = [100, 102, 200]; // future spike
    const pricesB = [100, 102, 50]; // future crash
    // logReturn at index 1 must be identical regardless of prices[2]
    expect(logReturn(pricesA, 1)).toBeCloseTo(assertDefined(logReturn(pricesB, 1)), 10);
  });
});

describe('simpleReturn', () => {
  it('returns null for index 0', () => {
    expect(simpleReturn(prices, 0)).toBeNull();
  });

  it('computes correct simple return', () => {
    expect(simpleReturn([100, 110], 1)).toBeCloseTo(0.1, 10);
    expect(simpleReturn([100, 90], 1)).toBeCloseTo(-0.1, 10);
  });
});

// ---------------------------------------------------------------------------
// Momentum
// ---------------------------------------------------------------------------

describe('momentum', () => {
  it('returns null when insufficient history', () => {
    expect(momentum(prices, 3, 5)).toBeNull(); // i=3, k=5: not enough
  });

  it('computes k-period momentum correctly', () => {
    // mom at i=5 with k=5: ln(103/100)
    const expected = Math.log(103 / 100);
    expect(momentum(prices, 5, 5)).toBeCloseTo(expected, 10);
  });

  it('INVARIANT: does not use future prices', () => {
    const p1 = [100, 102, 104, 106, 200, 300]; // future spike
    const p2 = [100, 102, 104, 106, 200, 10]; // future crash
    // momentum at i=4, k=4: ln(p[4]/p[0]) — independent of p[5]
    expect(momentum(p1, 4, 4)).toBeCloseTo(assertDefined(momentum(p2, 4, 4)), 10);
  });
});

// ---------------------------------------------------------------------------
// Rolling Statistics
// ---------------------------------------------------------------------------

describe('rollingMean', () => {
  it('returns null when insufficient data', () => {
    expect(rollingMean(prices, 2, 5)).toBeNull(); // i=2, window=5: not enough
  });

  it('computes rolling mean over exact window', () => {
    const p = [1, 2, 3, 4, 5, 6, 7];
    // i=4, window=5: mean of [1,2,3,4,5] = 3
    expect(rollingMean(p, 4, 5)).toBeCloseTo(3, 10);
  });

  it('INVARIANT: does not use future values', () => {
    const p1 = [1, 2, 3, 4, 5, 999]; // future outlier
    const p2 = [1, 2, 3, 4, 5, 0];
    expect(rollingMean(p1, 4, 5)).toBeCloseTo(assertDefined(rollingMean(p2, 4, 5)), 10);
  });
});

describe('rollingStd', () => {
  it('returns null for insufficient data', () => {
    expect(rollingStd(prices, 0, 5)).toBeNull();
  });

  it('computes correct std for constant series (should be 0)', () => {
    const constant = [5, 5, 5, 5, 5];
    expect(rollingStd(constant, 4, 5)).toBeCloseTo(0, 10);
  });

  it('computes non-zero std for varying series', () => {
    const varying = [1, 3, 2, 5, 4];
    const std = rollingStd(varying, 4, 5);
    expect(std).not.toBeNull();
    expect(assertDefined(std)).toBeGreaterThan(0);
  });
});

describe('realizedVolatility', () => {
  it('returns null for insufficient data', () => {
    const rets: (number | null)[] = [null, 0.01, 0.02];
    expect(realizedVolatility(rets, 2, 3)).toBeNull(); // null value in window
  });

  it('computes sqrt(sum of squared returns)', () => {
    const rets: (number | null)[] = [0, 0.1, 0.2, 0.3];
    // Window=3, i=3: sqrt(0.1^2 + 0.2^2 + 0.3^2)
    const expected = Math.sqrt(0.01 + 0.04 + 0.09);
    expect(realizedVolatility(rets, 3, 3)).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// Z-Score
// ---------------------------------------------------------------------------

describe('zScore', () => {
  it('returns null when std is 0', () => {
    const constant = [5, 5, 5, 5, 5];
    expect(zScore(constant, 4, 5)).toBeNull();
  });

  it('returns 0 for price at rolling mean', () => {
    const p = [3, 3, 3, 3, 3];
    expect(zScore(p, 4, 5)).toBeCloseTo(0, 10);
  });

  it('INVARIANT: does not use future prices', () => {
    const p1 = [1, 2, 3, 4, 5, 999];
    const p2 = [1, 2, 3, 4, 5, -999];
    expect(zScore(p1, 4, 5)).toBeCloseTo(assertDefined(zScore(p2, 4, 5)), 10);
  });
});

// ---------------------------------------------------------------------------
// Rolling High/Low & Drawdown
// ---------------------------------------------------------------------------

describe('rollingHigh', () => {
  it('returns correct max in window', () => {
    const p = [10, 5, 8, 3, 9, 2];
    expect(rollingHigh(p, 4, 3)).toBe(9); // max of [8, 3, 9]
  });

  it('INVARIANT: does not use future values', () => {
    const p1 = [1, 2, 3, 100]; // p1[3] is huge
    const p2 = [1, 2, 3, -100]; // p2[3] is tiny
    expect(rollingHigh(p1, 2, 3)).toBe(rollingHigh(p2, 2, 3));
  });
});

describe('rollingLow', () => {
  it('returns correct min in window', () => {
    const p = [10, 5, 8, 3, 9, 2];
    expect(rollingLow(p, 3, 3)).toBe(3); // min of [8, 3, 9] = 3
  });
});

describe('drawdownFromHigh', () => {
  it('returns 0 when at rolling high', () => {
    const p = [1, 2, 3, 4, 5]; // monotone increasing
    expect(drawdownFromHigh(p, 4, 5)).toBeCloseTo(0, 10);
  });

  it('returns negative value when below rolling high', () => {
    const p = [10, 9, 8, 7, 6];
    // rollingHigh = 10, current = 6: dd = (6-10)/10 = -0.4
    expect(drawdownFromHigh(p, 4, 5)).toBeCloseTo(-0.4, 10);
  });
});

// ---------------------------------------------------------------------------
// Autocorrelation
// ---------------------------------------------------------------------------

describe('autocorrelation', () => {
  it('returns null for insufficient data', () => {
    const rets: (number | null)[] = [0.1, 0.2, 0.3];
    expect(autocorrelation(rets, 2, 10, 1)).toBeNull();
  });

  it('returns close to -1 for perfectly alternating returns', () => {
    // Perfectly alternating: +1, -1, +1, -1, ...
    const rets: (number | null)[] = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const ac = autocorrelation(rets, 59, 50, 1);
    expect(ac).not.toBeNull();
    expect(assertDefined(ac)).toBeLessThan(-0.9); // Should be very negative
  });

  it('INVARIANT: does not use future returns', () => {
    const rets1: (number | null)[] = Array.from({ length: 25 }, (_, i) => i * 0.01);
    rets1.push(999); // future outlier at index 25
    const rets2 = [...rets1];
    rets2[25] = -999;
    // AC at i=24, window=20, lag=1 should not depend on rets[25]
    expect(autocorrelation(rets1, 24, 20, 1)).toBeCloseTo(assertDefined(autocorrelation(rets2, 24, 20, 1)), 10);
  });
});

// ---------------------------------------------------------------------------
// Pearson Correlation
// ---------------------------------------------------------------------------

describe('pearsonCorrelation', () => {
  it('returns 1 for perfectly positively correlated series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1, 10);
  });

  it('returns -1 for perfectly negatively correlated series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1, 10);
  });

  it('returns null for length mismatch', () => {
    expect(pearsonCorrelation([1, 2], [1, 2, 3])).toBeNull();
  });

  it('returns null for constant series (zero variance)', () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Descriptive Statistics
// ---------------------------------------------------------------------------

describe('mean', () => {
  it('computes correct mean', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    expect(mean([0])).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0);
  });
});

describe('stddev', () => {
  it('returns 0 for single value (ddof=1, n-1=0)', () => {
    expect(stddev([5])).toBe(0);
  });

  it('computes population std correctly (ddof=0)', () => {
    // Classic dataset: population std = 2 exactly
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9], 0)).toBeCloseTo(2, 10);
  });

  it('computes sample std correctly (ddof=1)', () => {
    // Same dataset with Bessel correction: std = sqrt(32/7) ≈ 2.138
    const expected = Math.sqrt(32 / 7);
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9], 1)).toBeCloseTo(expected, 10);
  });
});

describe('median', () => {
  it('returns middle value for odd-length array', () => {
    expect(median([3, 1, 4, 1, 5])).toBe(3);
  });

  it('returns average of middle two for even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('skewness', () => {
  it('returns null for small arrays', () => {
    expect(skewness([1, 2])).toBeNull();
  });

  it('returns near-zero for symmetric distribution', () => {
    const sym = [-3, -2, -1, 0, 1, 2, 3];
    const sk = skewness(sym);
    expect(sk).not.toBeNull();
    expect(Math.abs(assertDefined(sk))).toBeLessThan(0.01);
  });

  it('returns positive for right-skewed distribution', () => {
    const rightSkewed = [1, 1, 1, 1, 1, 1, 1, 1, 1, 100];
    const sk = skewness(rightSkewed);
    expect(sk).not.toBeNull();
    expect(assertDefined(sk)).toBeGreaterThan(0);
  });
});

describe('kurtosis', () => {
  it('returns null for small arrays', () => {
    expect(kurtosis([1, 2, 3])).toBeNull();
  });

  it('returns large positive value for fat-tailed distribution', () => {
    const fatTail = Array.from({ length: 100 }, () => 0).concat([100, -100]);
    const k = kurtosis(fatTail);
    expect(k).not.toBeNull();
    expect(assertDefined(k)).toBeGreaterThan(5);
  });
});
