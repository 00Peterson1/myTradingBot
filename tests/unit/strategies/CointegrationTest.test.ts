import { describe, expect, it } from 'vitest';
import { cointegrationTest } from '../../../src/strategies/pairs/CointegrationTest.js';
import { SpreadTracker } from '../../../src/strategies/pairs/SpreadTracker.js';

describe('pair residual diagnostics', () => {
  it('does not report threshold buckets as calibrated significance', () => {
    const b = Array.from({ length: 100 }, (_, i) => 10 + i / 100);
    const a = b.map((value, i) => 3 + 2 * value + 0.01 * Math.sin(i));
    const result = cointegrationTest(a, b);
    expect(result.betaHedgeRatio).toBeCloseTo(2, 2);
    expect(result.pValue).toBeNull();
    expect(result.isCointegrated).toBe(false);
  });
  it('rejects misaligned and nonfinite observations, handles constant inputs', () => {
    expect(() => cointegrationTest([1], [])).toThrow('aligned');
    expect(() => cointegrationTest([NaN], [1])).toThrow('finite');
    const result = cointegrationTest(Array(60).fill(2) as number[], Array(60).fill(1) as number[]);
    expect(result.pValue).toBeNull();
    expect(Object.values(result).filter(v => typeof v === 'number').every(Number.isFinite)).toBe(true);
  });
  it('invalidates restored legacy significance', () => {
    const tracker = new SpreadTracker('A', 'B', 100, { pairId: 'A-B', symbolA: 'A', symbolB: 'B', betaHedgeRatio: 1, spreadMean: 0, spreadStd: 1, cointegrationP: 0.01, lastZScore: 3, windowSize: 100, updatedAt: new Date() });
    expect(tracker.state.cointegrationP).toBeNull();
  });
});
