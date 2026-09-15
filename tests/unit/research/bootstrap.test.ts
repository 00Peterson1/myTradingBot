import { describe, expect, it } from 'vitest';
import { blockBootstrapMean, DEFAULT_BOOTSTRAP_POLICY } from '../../../src/research/statistics/bootstrap.js';
describe('segmented circular block bootstrap', () => {
  it('reproduces fixed-seed results and preserves constant means', () => {
    expect(blockBootstrapMean([Array<number>(40).fill(2)])).toEqual([2, 2]);
    const data = Array.from({ length: 100 }, (_, i) => Math.sin(i / 10));
    expect(blockBootstrapMean([data])).toEqual(blockBootstrapMean([data]));
  });
  it('keeps fold boundaries and requires enough observations in every fold', () => {
    expect(blockBootstrapMean([Array<number>(20).fill(1), Array<number>(20).fill(-1)])).toEqual([0, 0]);
    expect(blockBootstrapMean([Array<number>(100).fill(1), [2]])).toBeNull();
    expect(blockBootstrapMean([[1, 2, 3]])).toBeNull();
  });
  it('reflects serial clusters and rejects invalid policies or observations', () => {
    const data = Array.from({ length: 100 }, (_, i) => Math.floor(i / 10) % 2 ? 1 : -1);
    const blocks = blockBootstrapMean([data]);
    const independent = blockBootstrapMean([data], { ...DEFAULT_BOOTSTRAP_POLICY, blockLength: 1 });
    if (!blocks || !independent) throw new Error('Missing CI');
    expect(blocks[1] - blocks[0]).toBeGreaterThan(independent[1] - independent[0]);
    expect(() => blockBootstrapMean([[NaN]])).toThrow();
    expect(() => blockBootstrapMean([data], { ...DEFAULT_BOOTSTRAP_POLICY, seed: -1 })).toThrow();
  });
});
