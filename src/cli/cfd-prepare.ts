import { handleHelp } from './help.js';
handleHelp('cfd:prepare', 'Prepare an explicitly hypothetical cost scenario from observed external quotes. --quotes quotes.csv --metadata metadata.json --assumptions assumptions.json --out dataset.json. Output is never validation-eligible.');
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { prepareCfdScenario } from '../cfd/history/CfdScenario.js';
import { writeNewJson } from '../cfd/history/CfdCsvImport.js';
import { inspectCfdData } from '../cfd/CfdDataQuality.js';
import { print } from '../monitoring/print.js';
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { quotes: { type: 'string' }, metadata: { type: 'string' }, assumptions: { type: 'string' }, out: { type: 'string' } }, strict: true });
  if (!values.quotes || !values.metadata || !values.assumptions || !values.out) throw new Error('--quotes, --metadata, --assumptions and --out are required');
  const dataset = prepareCfdScenario(values.quotes, JSON.parse(readFileSync(values.metadata, 'utf8')) as unknown, JSON.parse(readFileSync(values.assumptions, 'utf8')) as unknown);
  await writeNewJson(values.out, dataset);
  print(JSON.stringify({ output: values.out, quality: inspectCfdData(dataset, 120000), demoEligible: false, liveEligible: false }, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Scenario preparation failed'); process.exitCode = 1; });
