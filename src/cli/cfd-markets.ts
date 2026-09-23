import { handleHelp } from './help.js';
handleHelp('cfd:markets', 'Create an account-scoped CFD research plan. --out plan.json (--refresh | --catalogue snapshot.json) [--config-dir directory]. Refresh is read-only demo discovery; never submits orders.');
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CTraderDemoConnection, ctraderConfigSchema } from '../cfd/ctrader/DemoConnection.js';
import { cTraderCatalogueSchema, catalogueResearchEntries, catalogueIdentity } from '../cfd/ctrader/Catalogue.js';
import { cfdResearchPlanSchema } from '../cfd/CfdResearchBatch.js';
import { writeNewJson } from '../cfd/history/CfdCsvImport.js';
import { print } from '../monitoring/print.js';
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, refresh: { type: 'boolean' }, catalogue: { type: 'string' }, 'config-dir': { type: 'string' } }, strict: true });
  if (!values.out || Boolean(values.refresh) === Boolean(values.catalogue)) throw new Error('Supply --out and exactly one of --refresh or --catalogue');
  let catalogue;
  if (values.refresh) {
    const parsed = ctraderConfigSchema.safeParse({ clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET, accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: process.env.CTRADER_DEMO_ACCOUNT_ID });
    if (!parsed.success) throw new Error('cTrader application credentials and demo account ID are required for account catalogue discovery; no Options fallback is available');
    const connection = new CTraderDemoConnection(parsed.data);
    try { await connection.connect(); catalogue = await connection.catalogue(); } finally { connection.close(); }
  } else catalogue = cTraderCatalogueSchema.parse(JSON.parse(readFileSync(values.catalogue ?? '', 'utf8')) as unknown);
  const symbols = catalogueResearchEntries(catalogue).map(row => ({ ...row,
    config: row.catalogueStatus === 'ACTIVE' && row.category !== 'synthetic' && row.category !== 'unknown'
      ? relative(dirname(resolve(values.out ?? '')), resolve(values['config-dir'] ?? 'examples/cfd/research-configs', `${row.category}.json`)) : null }));
  const plan = cfdResearchPlanSchema.parse({ version: 2, universeSource: 'CTRADER_ACCOUNT_CATALOGUE', catalogue, symbols });
  await writeNewJson(values.out, plan);
  print(JSON.stringify({ output: values.out, catalogueId: catalogueIdentity(catalogue), symbols: symbols.length,
    researchCandidates: symbols.filter(row => row.config !== null).length, executionEligible: false }, null, 2));
}
main().catch(() => { console.error('CFD catalogue unavailable or invalid. Check arguments, account authorization and exported catalogue structure locally. No Options symbols were substituted.'); process.exitCode = 1; });
