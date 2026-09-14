import { describe, it, expect, vi } from 'vitest';
import { asyncHandler } from '../../../src/utils/asyncHandler.js';

describe('async event bridge', () => {
  it('reports a rejected handler once without returning a promise to EventEmitter', async () => {
    const error = new Error('failed');
    const report = vi.fn();
    const callback = asyncHandler(() => Promise.reject(error), report);
    callback();
    await vi.waitFor(() => { expect(report).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledWith(error); });
  });
});
