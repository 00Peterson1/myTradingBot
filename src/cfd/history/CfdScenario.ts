import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { cfdImportMetadataSchema } from './CfdCsvImport.js';
import { cfdDatasetIdentity, type CfdDataset } from '../CfdDataset.js';

export const cfdScenarioSchema = z.object({ description: z.string().min(1), leverage: z.number().finite().min(1),
  annualLongFinancingFraction: z.number().finite().min(0).max(1), annualShortFinancingFraction: z.number().finite().min(0).max(1),
}).strict();
/** Actual external quotes with explicitly hypothetical costs. Never eligible validation evidence. */
export function prepareCfdScenario(csvPath: string, metadataInput: unknown, assumptionInput: unknown): CfdDataset {
  const metadata = cfdImportMetadataSchema.parse(metadataInput), assumptions = cfdScenarioSchema.parse(assumptionInput);
  if (metadata.kind !== 'EXTERNAL_BID_ASK') throw new Error('Scenario preparation requires an external quote source declaration');
  if (metadata.accountCurrency !== metadata.instrument.profitCurrency) throw new Error('Scenario requires observed account-currency conversion; cross-currency inference is unsupported');
  const bytes = readFileSync(csvPath), lines = bytes.toString('utf8').trimEnd().split(/\r?\n/);
  if (lines.shift() !== 'timeMs,bid,ask') throw new Error('Expected raw quote CSV header timeMs,bid,ask');
  let priorDay: number | null = null;
  const quotes = lines.map((line, index) => {
    const values = line.split(',');
    if (values.length !== 3 || values.some(value => !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))) throw new Error(`Invalid quote CSV row ${String(index + 2)}`);
    const timeMs = Number(values[0]), bid = Number(values[1]), ask = Number(values[2]);
    const day = Math.floor(timeMs / 86400000), elapsedDays = priorDay === null ? 0 : day - priorDay;
    priorDay = day;
    const notional = ((bid + ask) / 2) * metadata.instrument.contractSize;
    return { timeMs, bid, ask, profitCurrencyToAccount: 1, leverage: assumptions.leverage,
      longFinancingPerLot: -notional * assumptions.annualLongFinancingFraction * elapsedDays / 365,
      shortFinancingPerLot: -notional * assumptions.annualShortFinancingFraction * elapsedDays / 365 };
  });
  return cfdDatasetIdentity({ ...metadata, kind: 'SCENARIO_BID_ASK', source: `${metadata.source}; raw CSV SHA256=${createHash('sha256').update(bytes).digest('hex')}`,
    costSource: `HYPOTHETICAL SCENARIO ONLY: ${JSON.stringify(assumptions)}; charges at first observed quote of each UTC day, including elapsed weekend days. Not the broker swap calendar.`, quotes }).dataset;
}
