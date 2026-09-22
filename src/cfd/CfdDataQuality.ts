import { cfdDatasetIdentity, type CfdDataset } from './CfdDataset.js';

/** Diagnostics never fill gaps or infer market sessions from missing quotes. */
export function inspectCfdData(input: CfdDataset, maxGapMs: number): {
  datasetId: string; symbol: string; kind: CfdDataset['kind']; quotes: number; days: number;
  activeUtcDays: number; maxGapMs: number; discontinuities: number; longestContinuousQuotes: number;
  spreadFraction: { median: number; p95: number; maximum: number }; financingEvents: number;
} {
  if (!Number.isSafeInteger(maxGapMs) || maxGapMs <= 0) throw new Error('Invalid continuity threshold');
  const { dataset, id, days, maxGapMs: largestGap } = cfdDatasetIdentity(input);
  const activeDays = new Set<number>(), spreads: number[] = [];
  let discontinuities = 0, run = 0, longest = 0, financingEvents = 0;
  for (let i = 0; i < dataset.quotes.length; i++) {
    const row = dataset.quotes[i];
    if (!row) throw new Error('Missing quote');
    if (i && row.timeMs - (dataset.quotes[i - 1]?.timeMs ?? row.timeMs) > maxGapMs) { discontinuities++; run = 0; }
    longest = Math.max(longest, ++run);
    activeDays.add(Math.floor(row.timeMs / 86400000));
    spreads.push((row.ask - row.bid) / row.bid);
    if (row.longFinancingPerLot !== 0 || row.shortFinancingPerLot !== 0) financingEvents++;
  }
  spreads.sort((a, b) => a - b);
  const quantile = (p: number): number => spreads[Math.ceil((spreads.length - 1) * p)] ?? 0;
  return { datasetId: id, symbol: dataset.instrument.symbol, kind: dataset.kind, quotes: dataset.quotes.length, days,
    activeUtcDays: activeDays.size, maxGapMs: largestGap, discontinuities, longestContinuousQuotes: longest,
    spreadFraction: { median: quantile(0.5), p95: quantile(0.95), maximum: quantile(1) }, financingEvents };
}
