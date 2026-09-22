import { handleHelp } from './help.js';
handleHelp('cfd:doctor', 'Check cTrader demo configuration. --connect verifies authorization and reads symbols/positions; never submits orders.');
import 'dotenv/config';
import { print } from '../monitoring/print.js';
import { CTraderDemoConnection, ctraderConfigSchema } from '../cfd/ctrader/DemoConnection.js';

async function main(): Promise<void> {
  const keys = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'CTRADER_ACCESS_TOKEN', 'CTRADER_DEMO_ACCOUNT_ID'] as const;
  const missing = keys.filter(key => !process.env[key]);
  for (const key of keys) print(`${key}: ${process.env[key] ? 'set (redacted)' : 'not configured'}`);
  print('CFD execution: unavailable; offline execution/reconciliation and replay components exist; concrete broker adapter, validation gates and broker verification remain outstanding.');
  if (missing.length) { process.exitCode = 1; return; }
  const parsed = ctraderConfigSchema.safeParse({ clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET, accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: process.env.CTRADER_DEMO_ACCOUNT_ID });
  if (!parsed.success) { print('Invalid cTrader configuration; check the numeric demo account ID.'); process.exitCode = 1; return; }
  if (!process.argv.includes('--connect')) return;
  const connection = new CTraderDemoConnection(parsed.data);
  try { await connection.connect(); print(JSON.stringify(await connection.inspect())); }
  finally { connection.close(); }
}
main().catch(() => { print('cTrader diagnostic failed. Check demo account/application authorization and network access locally.'); process.exitCode = 1; });
