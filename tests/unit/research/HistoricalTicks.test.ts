import { describe, expect, it, vi } from 'vitest';
import { historicalTicks, requestHistoricalTicks } from '../../../src/research/HistoricalTicks.js';
describe('public history ingestion', () => {
  it('preserves timestamps, prices and gaps without filling or sorting', () => {
    expect(historicalTicks('OTC_SPC', { history: { prices: [100, 102], times: [1, 10] } }, 10)).toEqual([{ symbol: 'OTC_SPC', price: 100, epoch: 1 }, { symbol: 'OTC_SPC', price: 102, epoch: 10 }]);
  });
  it.each([
    { prices: [1], times: [1, 2] }, { prices: [0], times: [1] }, { prices: [NaN], times: [1] },
    { prices: [1], times: [11] }, { prices: [1], times: [1.5] },
    { prices: [1, 2], times: [2, 1] }, { prices: [1, 2], times: [1, 1] },
  ])('rejects malformed or ambiguous history before persistence', history => {
    expect(() => historicalTicks('OTC_SPC', { history }, 10)).toThrow();
  });
  it('backs off only on rate limits and stops after three attempts', async () => {
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const request = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('[RateLimit]')).mockResolvedValue(5);
    expect(await requestHistoricalTicks(request, wait)).toBe(5);
    expect(wait).toHaveBeenCalledWith(30000);
    request.mockReset().mockRejectedValue(new Error('[RateLimit]'));
    await expect(requestHistoricalTicks(request, wait)).rejects.toThrow('RateLimit');
    expect(request).toHaveBeenCalledTimes(3);
    request.mockReset().mockRejectedValue(new Error('Invalid symbol'));
    await expect(requestHistoricalTicks(request, wait)).rejects.toThrow('Invalid symbol');
    expect(request).toHaveBeenCalledTimes(1);
  });

});
