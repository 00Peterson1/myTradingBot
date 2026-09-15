import { describe, expect, it } from 'vitest';
import { probabilityOfBacktestOverfitting as pbo } from '../../../src/research/statistics/stats.js';
describe('CSCV reference cases', () => {
  it('uses complementary assignments and detects a reversed winner', () => {
    const result = pbo([[3, 4, -2, -1], [-2, -1, 3, 4]], 2);
    expect(result).toMatchObject({ pbo: 1, combinations: 2, partitions: 2 });
    expect(result?.logits[0]).toBeCloseTo(-Math.log(2), 12);
    expect(result?.logits[1]).toBeCloseTo(-Math.log(2), 12);
  });
  it('detects a persistent winner without claiming trading validity', () => {
    const result = pbo([[3, 4, 3, 4], [-2, -1, -2, -1]], 2);
    expect(result?.pbo).toBe(0);
    expect(result?.logits[0]).toBeCloseTo(Math.log(2), 12);
    const fourBlocks = pbo([[3, 4, 3, 4, 3, 4, 3, 4], [-2, -1, -2, -1, -2, -1, -2, -1]], 4);
    expect(fourBlocks).toMatchObject({ pbo: 0, combinations: 6 });
    expect(fourBlocks?.logits).toHaveLength(6);
  });
  it('includes a selected median ranking in the nonpositive-logit count', () => {
    const result = pbo([[5, 6, 2, 3], [2, 3, 5, 6], [-2, -1, -2, -1]], 2);
    expect(result?.logits).toEqual([0, 0]);
    expect(result?.pbo).toBe(1);
  });
  it('rejects malformed partitions and never pads missing observations', () => {
    for (const blocks of [0, 3, 2.5, 18, NaN]) expect(() => pbo([[1, 2], [2, 3]], blocks)).toThrow();
    expect(() => pbo([[1, 2, 3, 4], [1, 2]], 2)).toThrow('aligned');
    expect(() => pbo([[1, 2, 3, 4], [1, 2, NaN, 4]], 2)).toThrow('finite');
    expect(() => pbo([[1, 2, 3, 4, 5], [2, 3, 4, 5, 6]], 2)).toThrow('equal blocks');
  });
  it('returns unavailable for ties or undefined Sharpe rather than optimistic scores', () => {
    expect(pbo([[1, 2, 1, 2], [1, 2, 1, 2]], 2)).toBeNull();
    expect(pbo([[1, 1, 1, 1], [2, 3, 2, 3]], 2)).toBeNull();
    expect(pbo([[1, 2], [2, 3]], 2)).toBeNull();
  });
});
