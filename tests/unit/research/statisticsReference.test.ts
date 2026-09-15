import { describe, expect, it } from 'vitest';
import { deflatedSharpeRatio, benjaminiHochbergYekutieli } from '../../../src/research/statistics/stats.js';
const returns = Array.from({ length: 100 }, (_, i) => [-0.02, 0.01, 0.03, -0.01, 0.02][i % 5] ?? 0);
describe('statistical reference regressions', () => {
  it('uses zero reference for one trial and does not certify losing returns', () => {
    const result = deflatedSharpeRatio(Array.from({ length: 100 }, (_, i) => i % 2 ? -0.01 : -0.02), 1);
    expect(result?.sharpeRef).toBe(0);
    expect(result?.dsr).toBeLessThan(0.001);
    expect(result?.pValue).toBeGreaterThan(0.999);
  });
  it('requires trial dispersion or an explicit reference for multiple trials', () => {
    expect(deflatedSharpeRatio(returns, 100)).toBeNull();
    expect(deflatedSharpeRatio(returns, 100, 0.2)).not.toBeNull();
    expect(() => deflatedSharpeRatio(returns, 0)).toThrow();
    expect(() => deflatedSharpeRatio(returns, 100, undefined, -1)).toThrow();
    expect(deflatedSharpeRatio([...returns, NaN], 1)).toBeNull();
  });
  it('matches an independently calculated Python NormalDist reference', () => {
    // Bailey/Lopez de Prado equation with sample SD and bias-corrected sample moments.
    // Python statistics.NormalDist supplies independent inverse/CDF approximations.
    const result = deflatedSharpeRatio(returns, 100, undefined, 0.01);
    expect(result?.sharpeObs).toBeCloseTo(0.32187676393736575, 10);
    expect(result?.sharpeRef).toBeCloseTo(0.2530602893201142, 7);
    expect(result?.dsr).toBeCloseTo(0.7465483907934306, 6);
  });
  it('uses reverse cumulative minima for BY adjusted p-values in original order', () => {
    const result = benjaminiHochbergYekutieli([0.5, 0.02, 0.021], 0.06);
    expect(result[0]?.corrected).toBeCloseTo(11 / 12, 10);
    expect(result[1]?.corrected).toBeCloseTo(0.05775, 10);
    expect(result[2]?.corrected).toBeCloseTo(0.05775, 10);
    expect(result.map(value => value.rejected)).toEqual([false, true, true]);
    expect(benjaminiHochbergYekutieli([])).toEqual([]);
    expect(() => benjaminiHochbergYekutieli([NaN])).toThrow();
    expect(() => benjaminiHochbergYekutieli([1.1])).toThrow();
  });
});
