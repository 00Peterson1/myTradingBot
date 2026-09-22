import { z } from 'zod';
import { cfdInstrumentSchema } from './types.js';
import { contentHash } from '../research/experiments/ExperimentRegistry.js';

export const cfdDatasetSchema = z.object({
  version: z.literal(1), source: z.string().min(1), kind: z.enum(['BROKER_BID_ASK', 'EXTERNAL_BID_ASK', 'FIXTURE']),
  accountCurrency: z.string().regex(/^[A-Z]{3}$/), instrument: cfdInstrumentSchema,
  costSource: z.string().min(1),
  quotes: z.array(z.object({ timeMs: z.number().int().nonnegative().max(8640000000000000), bid: z.number().finite().positive(), ask: z.number().finite().positive(),
    profitCurrencyToAccount: z.number().finite().positive(), leverage: z.number().finite().min(1),
    longFinancingPerLot: z.number().finite(), shortFinancingPerLot: z.number().finite(),
  }).strict()).min(2),
}).strict().superRefine((data, ctx) => {
  for (let i = 0; i < data.quotes.length; i++) {
    const row = data.quotes[i];
    if (!row) continue;
    if (row.ask < row.bid) ctx.addIssue({ code: 'custom', message: 'Crossed bid/ask', path: ['quotes', i] });
    if (i && row.timeMs <= (data.quotes[i - 1]?.timeMs ?? row.timeMs)) ctx.addIssue({ code: 'custom', message: 'Quotes must be strictly chronological', path: ['quotes', i] });
    if (data.instrument.profitCurrency === data.accountCurrency && row.profitCurrencyToAccount !== 1) ctx.addIssue({ code: 'custom', message: 'Same-currency conversion must equal one', path: ['quotes', i] });
  }
});
export type CfdDataset = z.infer<typeof cfdDatasetSchema>;
export function cfdDatasetIdentity(input: unknown): { dataset: CfdDataset; id: string; days: number; maxGapMs: number } {
  const dataset = cfdDatasetSchema.parse(input), first = dataset.quotes[0], last = dataset.quotes.at(-1);
  if (!first || !last) throw new Error('Empty CFD dataset');
  let maxGapMs = 0;
  for (let i = 1; i < dataset.quotes.length; i++) maxGapMs = Math.max(maxGapMs, (dataset.quotes[i]?.timeMs ?? 0) - (dataset.quotes[i - 1]?.timeMs ?? 0));
  return { dataset, id: contentHash(dataset), days: (last.timeMs - first.timeMs) / 86400000, maxGapMs };
}
