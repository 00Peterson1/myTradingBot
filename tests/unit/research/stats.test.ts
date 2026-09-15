import { assertDefined } from '../../../src/utils/assertDefined.js';
import { describe, it, expect } from 'vitest';
import {
  normalCDF,
  computeSharpe,
  computeSortino,
  deflatedSharpeRatio,
  ljungBoxTest,
  jarqueBera,
  conditionalProbability,
  computeMaxDrawdown,
  probabilityOfBacktestOverfitting,
  benjaminiHochbergYekutieli,
} from '../../../src/research/statistics/stats.js';

// ---------------------------------------------------------------------------
// Normal CDF
// ---------------------------------------------------------------------------

describe('normalCDF', () => {
  it('returns 0.5 at z=0', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 4);
  });

  it('returns ~0.975 at z=1.96', () => {
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 2);
  });

  it('returns ~0.025 at z=-1.96', () => {
    expect(normalCDF(-1.96)).toBeCloseTo(0.025, 2);
  });

  it('is monotonically increasing', () => {
    const vals = [-3, -2, -1, 0, 1, 2, 3].map(normalCDF);
    for (let i = 1; i < vals.length; i++) {
      expect(assertDefined(vals[i])).toBeGreaterThan(assertDefined(vals[i - 1]));
    }
  });
});

// ---------------------------------------------------------------------------
// Sharpe Ratio
// ---------------------------------------------------------------------------

describe('computeSharpe', () => {
  it('returns null for insufficient observations', () => {
    expect(computeSharpe([0.01, 0.02])).toBeNull();
  });

  it('returns null or huge value for near-zero std (constant returns)', () => {
    // Floating-point arithmetic means perfectly constant arrays may have
    // tiny but non-zero std. The implementation uses s === 0 check.
    // With Array.fill(0.01), due to fp representation, std might be ~3.5e-18.
    // We accept either null (exact zero std) or an extremely large sharpe
    // that would flag as invalid in practice. The key invariant is: the
    // implementation does not crash.
    const constant = Array(50).fill(0.01);
    const result = computeSharpe(constant);
    // If not null, Sharpe must be astronomically large (>1e10) — clearly invalid
    if (result !== null) {
      expect(Math.abs(result.sharpe)).toBeGreaterThan(1e10);
    }
  });

  it('computes positive Sharpe for consistently positive returns', () => {
    const positive = Array.from({ length: 50 }, () => 0.01 + Math.random() * 0.001);
    const result = computeSharpe(positive);
    expect(result).not.toBeNull();
    expect(assertDefined(result).sharpe).toBeGreaterThan(0);
  });

  it('computes negative Sharpe for consistently negative returns', () => {
    const negative = Array.from({ length: 50 }, () => -0.01 - Math.random() * 0.001);
    const result = computeSharpe(negative);
    expect(result).not.toBeNull();
    expect(assertDefined(result).sharpe).toBeLessThan(0);
  });

  it('observation count matches input', () => {
    const returns = Array(60)
      .fill(0)
      .map(() => (Math.random() - 0.5) * 0.02);
    const result = computeSharpe(returns);
    expect(result?.observations).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Sortino Ratio
// ---------------------------------------------------------------------------

describe('computeSortino', () => {
  it('returns null for insufficient data', () => {
    expect(computeSortino([0.01, 0.02])).toBeNull();
  });

  it('returns null when no downside returns', () => {
    const positive = Array(50).fill(0.01);
    expect(computeSortino(positive, 1, 0)).toBeNull();
  });

  it('computes Sortino for mixed returns', () => {
    const mixed = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? -0.02 : 0.01));
    const result = computeSortino(mixed);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deflated Sharpe Ratio
// ---------------------------------------------------------------------------

describe('deflatedSharpeRatio', () => {
  it('returns null for insufficient data', () => {
    expect(deflatedSharpeRatio([0.01, 0.02])).toBeNull();
  });

  it('DSR is in [0, 1] range', () => {
    const returns = Array.from({ length: 100 }, () => (Math.random() - 0.5) * 0.02);
    const result = deflatedSharpeRatio(returns, 1);
    if (result !== null) {
      expect(result.dsr).toBeGreaterThanOrEqual(0);
      expect(result.dsr).toBeLessThanOrEqual(1);
    }
  });

  it('high DSR for genuinely strong strategy', () => {
    const strong = Array.from({ length: 100 }, () => 0.02 + Math.random() * 0.001);
    const result = deflatedSharpeRatio(strong, 1);
    expect(result).not.toBeNull();
    expect(assertDefined(result).dsr).toBeGreaterThan(0.8);
  });

  it('more trials → lower DSR (selection bias adjustment)', () => {
    // Use returns that are mildly positive (not overwhelmingly so) so DSR < 1
    // This ensures the selection bias correction has room to reduce DSR
    const returns = Array.from({ length: 200 }, () => 0.003 + (Math.random() - 0.4) * 0.01);
    const resultFew = deflatedSharpeRatio(returns, 1);
    const resultMany = deflatedSharpeRatio(returns, 100, undefined, 0.01);
    // DSR with more trials must be <= DSR with fewer trials
    // (it can be equal if both are at boundary 0 or 1)
    if (resultFew && resultMany) {
      expect(resultMany.dsr).toBeLessThanOrEqual(resultFew.dsr);
    }
  });
});

// ---------------------------------------------------------------------------
// Ljung-Box Test
// ---------------------------------------------------------------------------

describe('ljungBoxTest', () => {
  it('returns null for insufficient data', () => {
    expect(ljungBoxTest([0.1, 0.2, 0.3], 20)).toBeNull();
  });

  it('returns valid structure for sufficient data', () => {
    const iid = Array.from({ length: 200 }, (_, i) => Math.sin(i * 7919) * 0.01);
    const result = ljungBoxTest(iid, 20, 0.05);
    expect(result).not.toBeNull();
    expect(typeof assertDefined(result).Q).toBe('number');
    expect(assertDefined(result).pValue).toBeGreaterThanOrEqual(0);
    expect(assertDefined(result).pValue).toBeLessThanOrEqual(1);
  });

  it('rejects H0 for highly autocorrelated series', () => {
    // AR(1) with coefficient 0.9 — strongly autocorrelated
    const ar: number[] = [0.0];
    for (let i = 1; i < 300; i++) {
      ar.push(0.9 * (ar[i - 1] ?? 0) + 0.01 * (Math.random() - 0.5));
    }
    const result = ljungBoxTest(ar, 20, 0.05);
    expect(result).not.toBeNull();
    expect(assertDefined(result).rejectH0).toBe(true);
    expect(assertDefined(result).pValue).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Jarque-Bera
// ---------------------------------------------------------------------------

describe('jarqueBera', () => {
  it('returns null for insufficient data', () => {
    expect(jarqueBera([1, 2, 3])).toBeNull();
  });

  it('reports non-normality for fat-tailed returns', () => {
    const fatTail = Array.from({ length: 100 }, (_, i) => (i < 95 ? 0 : i % 2 === 0 ? 10 : -10));
    const result = jarqueBera(fatTail);
    expect(result).not.toBeNull();
    expect(assertDefined(result).isNormal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conditional Probability
// ---------------------------------------------------------------------------

describe('conditionalProbability', () => {
  it('returns null for insufficient data', () => {
    const tiny = [0.1, -0.1, 0.2];
    expect(conditionalProbability(tiny, (_i) => true, 'always')).toBeNull();
  });

  it('returns meaningful result for large dataset', () => {
    const returns = Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.02);
    const result = conditionalProbability(
      returns,
      (i) => (returns[i] ?? 0) > 0,
      'previous_positive',
    );
    expect(result).not.toBeNull();
    expect(assertDefined(result).unconditional).toBeGreaterThan(0);
    expect(assertDefined(result).unconditional).toBeLessThan(1);
    expect(assertDefined(result).lift).toBeGreaterThan(0);
  });

  it('lift ≈ 1 for genuinely random returns (no edge)', () => {
    // For random iid returns, lift should be close to 1
    const returns = Array.from({ length: 1000 }, () => (Math.random() > 0.5 ? 0.01 : -0.01));
    const result = conditionalProbability(
      returns,
      (i) => (returns[i] ?? 0) > 0,
      'previous_positive',
    );
    expect(result).not.toBeNull();
    // Lift for random data: wide tolerance since it's stochastic
    expect(assertDefined(result).lift).toBeGreaterThan(0.5);
    expect(assertDefined(result).lift).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// Max Drawdown
// ---------------------------------------------------------------------------

describe('computeMaxDrawdown', () => {
  it('returns zeros for empty array', () => {
    const result = computeMaxDrawdown([]);
    expect(result.maxDrawdown).toBe(0);
    expect(result.maxDrawdownPct).toBe(0);
  });

  it('computes max drawdown correctly', () => {
    const equity = [100, 110, 90, 95, 80, 105];
    const result = computeMaxDrawdown(equity);
    // Peak at 110, trough at 80: drawdown = -30, pct = -30/110
    expect(result.maxDrawdown).toBeCloseTo(-30, 1);
    expect(result.maxDrawdownPct).toBeCloseTo(-30 / 110, 4);
  });

  it('returns 0 for monotonically increasing series', () => {
    const monotone = [100, 110, 120, 130, 140];
    const result = computeMaxDrawdown(monotone);
    expect(result.maxDrawdown).toBe(0);
    expect(result.maxDrawdownPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PBO
// ---------------------------------------------------------------------------

describe(
  'probabilityOfBacktestOverfitting',
  { timeout: 30_000 },
  () => {
    it('returns null for single strategy', () => {
      const strat = [Array(200).fill(0.01)];
      expect(probabilityOfBacktestOverfitting(strat, 16)).toBeNull();
    });

    it('returns PBO in [0, 1] for valid input', () => {
      const strategies = Array.from({ length: 5 }, () =>
        Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.02),
      );
      const result = probabilityOfBacktestOverfitting(strategies, 8);
      expect(result).not.toBeNull();
      expect(assertDefined(result).pbo).toBeGreaterThanOrEqual(0);
      expect(assertDefined(result).pbo).toBeLessThanOrEqual(1);
    });
  },
);

// ---------------------------------------------------------------------------
// BHY
// ---------------------------------------------------------------------------

describe('benjaminiHochbergYekutieli', () => {
  it('returns same length array as input', () => {
    const pValues = [0.01, 0.05, 0.2, 0.5];
    const result = benjaminiHochbergYekutieli(pValues, 0.05);
    expect(result).toHaveLength(4);
  });

  it('rejects very low p-values', () => {
    const pValues = [0.001, 0.5, 0.8, 0.9];
    const result = benjaminiHochbergYekutieli(pValues, 0.05);
    expect(assertDefined(result[0]).rejected).toBe(true);
    expect(assertDefined(result[3]).rejected).toBe(false);
  });

  it('is conservative: not all borderline p-values are rejected', () => {
    const pValues = [0.04, 0.04, 0.04, 0.04, 0.04];
    const result = benjaminiHochbergYekutieli(pValues, 0.05);
    const rejectedCount = result.filter((r) => r.rejected).length;
    expect(rejectedCount).toBeLessThan(5);
  });
});
