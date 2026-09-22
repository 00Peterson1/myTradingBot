import { handleHelp } from './help.js';
handleHelp('collect:history', 'Collect recent public ticks for all discovered real symbols, including closed markets. --symbols SYMBOL,... --count 1..5000. No orders; not CFD bid/ask data.');
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { MarketCatalogue } from '../markets/MarketCatalogue.js';
import { selectMarkets } from '../markets/MarketScope.js';
import { historicalTicks, requestHistoricalTicks } from '../research/HistoricalTicks.js';
import { bulkInsertTicks } from '../data/repository/TickRepository.js';
import { closeDb } from '../data/database/sqlite.js';
import { print } from '../monitoring/print.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { symbols: { type: 'string' }, count: { type: 'string', default: '5000' } }, strict: true });
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error('--count must be an integer from 1 to 5000');
  const requested = values.symbols?.split(',').map(value => value.trim()) ?? ['ALL'];
  if (requested.some(value => !value)) throw new Error('Empty symbol in --symbols');
  const client = new DerivClient();
  let failures = 0;
  try {
    await client.connectPublic();
    const catalogue = await MarketCatalogue.discoverAll(client);
    const markets = selectMarkets(catalogue, 'REAL', requested);
    if (!requested.some(value => value.toUpperCase() === 'ALL')) {
      const missing = requested.filter(symbol => !markets.some(market => market.symbol === symbol));
      if (missing.length) throw new Error(`Requested symbols are not in the real-market catalogue: ${missing.join(', ')}`);
    }
    if (!markets.length) throw new Error('No real symbols available from public discovery');
    for (const market of markets) {
      try {
        await delay(3500); // Pace history requests; provider may impose a stricter dynamic limit.
        const response = await requestHistoricalTicks(() => client.getTickHistory(market.symbol, count), async ms => {
          console.error(`Rate-limited while collecting ${market.symbol}; waiting ${String(ms / 1000)} seconds.`);
          await delay(ms);
        });
        const rows = historicalTicks(market.symbol, response, Math.floor(Date.now() / 1000));
        if (!rows.length) throw new Error('Provider returned no history');
        const inserted = bulkInsertTicks(rows);
        print(JSON.stringify({ symbol: market.symbol, displayName: market.displayName, status: 'COLLECTED', received: rows.length, inserted, fromEpoch: rows[0]?.epoch, toEpoch: rows.at(-1)?.epoch }));
      } catch (error) {
        failures++;
        print(JSON.stringify({ symbol: market.symbol, status: 'FAILED', reason: error instanceof Error ? error.message : 'History collection failed' }));
      }
    }
    print(JSON.stringify({ symbols: markets.length, failures, note: 'Recent public price ticks only; not complete historical coverage or CFD execution data' }));
    if (failures) process.exitCode = 1;
  } finally { await client.disconnect(); closeDb(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Historical collection failed'); process.exitCode = 1; });
