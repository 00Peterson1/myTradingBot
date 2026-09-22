import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, link, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { cfdInstrumentSchema } from '../types.js';
import { cfdDatasetIdentity, type CfdDataset } from '../CfdDataset.js';
import { inspectCfdData } from '../CfdDataQuality.js';

export const cfdImportMetadataSchema = z.object({ version: z.literal(1), source: z.string().min(1),
  kind: z.enum(['BROKER_BID_ASK', 'EXTERNAL_BID_ASK', 'FIXTURE']), accountCurrency: z.string().regex(/^[A-Z]{3}$/),
  instrument: cfdInstrumentSchema, costSource: z.string().min(1),
}).strict();
export const CFD_CSV_HEADER = 'timeMs,bid,ask,profitCurrencyToAccount,leverage,longFinancingPerLot,shortFinancingPerLot';
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Numeric canonical CSV; no timezone inference, price synthesis, reordering or silent row drops. */
export async function importCfdCsv(inputPath: string, metadataInput: unknown): Promise<{ dataset: CfdDataset; sourceSha256: string; quality: ReturnType<typeof inspectCfdData> }> {
  const metadata = cfdImportMetadataSchema.parse(metadataInput), hash = createHash('sha256');
  const stream = createReadStream(inputPath);
  stream.on('data', chunk => { hash.update(chunk); });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  // readline does not forward input errors to its async iterator on every supported Node version.
  stream.on('error', error => { lines.emit('error', error); });
  const quotes: CfdDataset['quotes'] = [];
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (lineNumber === 1) { if (line !== CFD_CSV_HEADER) throw new Error(`Expected CSV header: ${CFD_CSV_HEADER}`); continue; }
      const values = line.split(',');
      if (values.length !== 7 || values.some(value => !decimal.test(value))) throw new Error(`Invalid numeric CSV row ${String(lineNumber)}`);
      const [timeMs, bid, ask, profitCurrencyToAccount, leverage, longFinancingPerLot, shortFinancingPerLot] = values.map(Number);
      const candidate = { timeMs, bid, ask, profitCurrencyToAccount, leverage, longFinancingPerLot, shortFinancingPerLot };
      // Reuse the dataset contract for each incoming pair to bound malformed input detection latency.
      const pair = quotes.length ? [quotes[quotes.length - 1], candidate] : [candidate, { ...candidate, timeMs: (timeMs ?? NaN) + 1 }];
      try { cfdDatasetIdentity({ ...metadata, quotes: pair }); } catch { throw new Error(`Invalid quote/cost/chronology at CSV row ${String(lineNumber)}`); }
      quotes.push(candidate as CfdDataset['quotes'][number]);
    }
  } finally { lines.close(); stream.destroy(); }
  const { dataset } = cfdDatasetIdentity({ ...metadata, quotes });
  return { dataset, sourceSha256: hash.digest('hex'), quality: inspectCfdData(dataset, 60000) };
}

/** Publish complete files without overwriting prior evidence; clean up on failure. */
export async function writeNewJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
    await file.close();
    await link(temporary, path);
  } finally { await file.close(); await unlink(temporary); }
}
