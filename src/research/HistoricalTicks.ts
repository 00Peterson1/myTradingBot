import { TickHistoryResponseSchema } from '../api/deriv/DerivTypes.js';
import type { TickInsert } from '../data/repository/TickRepository.js';

/** Reject malformed/ambiguous batches before writing; never synthesize missing prices. */
export function historicalTicks(symbol: string, response: unknown, nowEpoch: number): TickInsert[] {
  const { history } = TickHistoryResponseSchema.parse(response);
  if (!symbol.trim() || !Number.isSafeInteger(nowEpoch) || nowEpoch < 0) throw new Error('Invalid history identity/time');
  if (history.prices.length !== history.times.length) throw new Error('Historical prices and timestamps are misaligned');
  return history.times.map((epoch, index) => {
    const price = history.prices[index];
    if (price === undefined || !Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(epoch) || epoch < 0 || epoch > nowEpoch) throw new Error('Invalid historical price or timestamp');
    if (index > 0 && epoch <= (history.times[index - 1] ?? epoch)) throw new Error('Historical timestamps must be strictly chronological');
    return { symbol, epoch, price };
  });
}

/** Only rate-limit failures are retryable here; malformed data is never retried or repaired. */
export async function requestHistoricalTicks<T>(request: () => Promise<T>, wait: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('[RateLimit]') || attempt >= 2) throw error;
      await wait(30000);
    }
  }
}
