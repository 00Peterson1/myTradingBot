#!/usr/bin/env node
import { MarketCatalogue } from '../markets/MarketCatalogue.js';
import { getTickCount } from '../data/repository/TickRepository.js';
import { getDb } from '../data/database/sqlite.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { parseArgs } from 'util';

async function main() {
  const { values } = parseArgs({
    options: {
      cat: { type: 'string' },
      open: { type: 'boolean' },
      'min-ticks': { type: 'string' },
    },
    strict: false,
  });

  const categoryFilter = values.cat as string | undefined;
  const onlyOpen = values.open as boolean | undefined;
  const minTicks = values['min-ticks'] ? parseInt(values['min-ticks'] as string, 10) : 0;

  getDb();

  let markets = MarketCatalogue.getAll();

  if (markets.length === 0) {
    console.log('No markets found in database. Discovering from API...');
    const client = new DerivClient();
    await client.connectPublic();
    markets = await MarketCatalogue.discoverAll(client);
    await client.disconnect();
  }

  if (categoryFilter) {
    markets = markets.filter(m => m.marketCategory.toLowerCase() === categoryFilter.toLowerCase());
  }

  if (onlyOpen) {
    markets = markets.filter(m => m.exchangeIsOpen);
  }

  const results = [];
  for (const m of markets) {
    const ticks = getTickCount(m.symbol);
    if (ticks >= minTicks) {
      results.push({ market: m, ticks });
    }
  }

  results.sort((a, b) => b.ticks - a.ticks);

  console.log('╔═════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log(`║  ALL MARKETS (${results.length} symbols found)                                                          ║`.padEnd(90, ' ') + '║');
  console.log('╠═════════════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║ Category    Symbol         Name                    Ticks   Open  Score                  ║');
  console.log('╠═════════════════════════════════════════════════════════════════════════════════════════╣');

  for (const r of results) {
    const cat = r.market.marketCategory.padEnd(11, ' ').slice(0, 11);
    const sym = r.market.symbol.padEnd(14, ' ').slice(0, 14);
    const name = r.market.displayName.padEnd(23, ' ').slice(0, 23);
    const ticksStr = r.ticks.toLocaleString().padStart(8, ' ');
    const open = r.market.exchangeIsOpen ? '✓' : '✗';
    const openStr = open.padEnd(5, ' ');
    const score = r.market.researchScore.toString().padStart(3, ' ');
    
    console.log(`║ ${cat} ${sym} ${name} ${ticksStr}  ${openStr} ${score}                    ║`);
  }

  console.log('╚═════════════════════════════════════════════════════════════════════════════════════════╝');
  console.log('Tip: Run `npm run research:daemon` to collect more data.');
}

main().catch(console.error);
