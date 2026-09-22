import { handleHelp } from './help.js';
handleHelp('cfd:import', 'Import canonical bid/ask CSV. --csv quotes.csv --metadata metadata.json --out dataset.json. Requires explicit dated conversion, leverage and financing; never connects to a broker.');
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { importCfdCsv, writeNewJson } from '../cfd/history/CfdCsvImport.js';
import { print } from '../monitoring/print.js';
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { csv: { type: 'string' }, metadata: { type: 'string' }, out: { type: 'string' } }, strict: true });
  if (!values.csv || !values.metadata || !values.out) throw new Error('--csv, --metadata and --out are required');
  const imported = await importCfdCsv(values.csv, JSON.parse(readFileSync(values.metadata, 'utf8')) as unknown);
  // Include the original byte hash in persisted source provenance, not only terminal output.
  const dataset = { ...imported.dataset, source: `${imported.dataset.source}; CSV SHA256=${imported.sourceSha256}` };
  await writeNewJson(values.out, dataset);
  print(JSON.stringify({ output: values.out, sourceSha256: imported.sourceSha256, quotes: dataset.quotes.length, demoEligible: false, liveEligible: false }, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'CFD import failed'); process.exitCode = 1; });
