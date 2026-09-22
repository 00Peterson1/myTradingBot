import { handleHelp } from './help.js';
handleHelp('cfd:research', 'Audit every declared real symbol. --plan plan.json --out report.json [--validate]. Paths resolve relative to the plan; missing inputs remain visible and return exit code 2. No broker connection.');
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { researchCfdBatch } from '../cfd/CfdResearchBatch.js';
import { writeNewJson } from '../cfd/history/CfdCsvImport.js';
import { ExperimentRegistry, captureResearchCode } from '../research/experiments/ExperimentRegistry.js';
import { getDb, closeDb } from '../data/database/sqlite.js';
import { print } from '../monitoring/print.js';
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, out: { type: 'string' }, validate: { type: 'boolean' } }, strict: true });
  if (!values.plan || !values.out) throw new Error('--plan and --out are required');
  const registry = new ExperimentRegistry(getDb(), captureResearchCode(fileURLToPath(new URL('../../', import.meta.url))));
  try {
    const report = await researchCfdBatch(JSON.parse(readFileSync(values.plan, 'utf8')) as unknown, dirname(resolve(values.plan)), registry, values.validate ?? false);
    await writeNewJson(values.out, report);
    print(JSON.stringify({ output: values.out, symbols: report.symbols.length, statuses: report.symbols.reduce<Record<string, number>>((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {}), demoEligible: false, liveEligible: false }, null, 2));
    if (report.symbols.some(row => row.reasons.length || row.status === 'INSUFFICIENT_EVIDENCE')) process.exitCode = 2;
  } finally { closeDb(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'CFD research failed'); process.exitCode = 1; });
