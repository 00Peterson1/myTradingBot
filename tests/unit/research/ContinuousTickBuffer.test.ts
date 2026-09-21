import { describe, expect, it, vi } from 'vitest';
import { ContinuousTickBuffer } from '../../../src/research/ContinuousTickBuffer.js';
describe('continuous tick persistence', () => {
  it('keeps interleaved observations and retains a failed batch for retry', () => {
    const persist = vi.fn().mockImplementationOnce(() => { throw new Error('storage unavailable'); }).mockReturnValue(3);
    const buffer = new ContinuousTickBuffer(persist);
    buffer.setSymbols(['frxEURUSD', 'cryBTCUSD']);
    const rows = [{ symbol: 'frxEURUSD', epoch: 1, price: 1.1 }, { symbol: 'cryBTCUSD', epoch: 1, price: 60000 }, { symbol: 'frxEURUSD', epoch: 2, price: 1.2 }];
    for (const row of rows) buffer.push(row);
    expect(() => buffer.flush()).toThrow('storage unavailable');
    expect(buffer.size).toBe(3);
    expect(buffer.flush()).toBe(3);
    expect(persist.mock.calls[1]?.[0]).toEqual(rows);
    expect(buffer.size).toBe(0);
    expect(buffer.flush()).toBe(0);
    expect(persist).toHaveBeenCalledTimes(2);
  });
  it('rejects synthetic/out-of-scope and malformed observations', () => {
    const buffer = new ContinuousTickBuffer(() => 0);
    buffer.setSymbols(['frxEURUSD']);
    expect(() => { buffer.push({ symbol: '1HZ10V', epoch: 1, price: 100 }); }).toThrow('scope');
    expect(() => { buffer.push({ symbol: 'frxEURUSD', epoch: 1, price: NaN }); }).toThrow('Invalid');
    expect(buffer.size).toBe(0);
  });
});
