import { handleHelp } from './help.js';
handleHelp('cfd:backtest', 'Run bid/ask CFD replay. --data dataset.json --config config.json [--validate]. Does not connect to any broker.');
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cfdDatasetIdentity } from '../cfd/CfdDataset.js';
import { backtestCfd, cfdBacktestConfigSchema } from '../cfd/CfdBacktest.js';
import { validateCfd } from '../cfd/CfdValidation.js';
import { ExperimentRegistry, captureResearchCode } from '../research/experiments/ExperimentRegistry.js';
import { getDb, closeDb } from '../data/database/sqlite.js';
import { print } from '../monitoring/print.js';
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { data: { type: 'string' }, config: { type: 'string' }, validate: { type: 'boolean' } }, strict: true });
  if (!values.data || !values.config) throw new Error('--data and --config are required; Options price ticks cannot substitute for CFD bid/ask');
  const { dataset } = cfdDatasetIdentity(JSON.parse(readFileSync(values.data, 'utf8')) as unknown);
  const config = cfdBacktestConfigSchema.parse(JSON.parse(readFileSync(values.config, 'utf8')) as unknown);
  const registry = new ExperimentRegistry(getDb(), captureResearchCode(fileURLToPath(new URL('../../', import.meta.url))));
  try {
    if (values.validate) { print(JSON.stringify(await validateCfd(dataset, config, registry), null, 2)); return; }
    const attempt = registry.begin(dataset, { product: 'CFD', symbol: dataset.instrument.symbol, config });
    try {
      const result = await backtestCfd(dataset, config);
      registry.finish(attempt.attemptId, 'COMPLETED', result);
      print(JSON.stringify({ ...attempt, ...result }, null, 2));
    } catch (error) { registry.finish(attempt.attemptId, 'FAILED', { error: error instanceof Error ? error.message : 'Replay failed' }); throw error; }
  } finally { closeDb(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'CFD replay failed'); process.exitCode = 1; });
