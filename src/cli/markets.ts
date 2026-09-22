#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('markets', 'Discover/list instruments. --cat CATEGORY --search NAME_OR_SYMBOL --open --min-ticks COUNT --refresh --coverage (JSON research coverage) --all (otherwise uses MARKET_SCOPE)');
import { matchesMarketSearch } from '../markets/MarketNames.js';
import { realMarketCoverage } from '../markets/RealMarketCoverage.js';
import { getEnv } from '../config/env.js';
import { selectMarkets } from '../markets/MarketScope.js';
import { categoryMatches } from '../config/markets.js';
import { print } from '../monitoring/print.js';
import { MarketCatalogue } from '../markets/MarketCatalogue.js';
import { getTickCount } from '../data/repository/TickRepository.js';
import { getDb } from '../data/database/sqlite.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { parseArgs } from 'util';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cat: { type: 'string' },
      search: { type: 'string' },
      coverage: { type: 'boolean' },
      all: { type: 'boolean' },
      refresh: { type: 'boolean' },
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

  if (markets.length === 0 || values.refresh) {
    if (!values.coverage) print('Refreshing public instrument catalogue...');
    const client = new DerivClient();
    try { await client.connectPublic(); markets = await MarketCatalogue.discoverAll(client); } finally { await client.disconnect(); }
  }

  if (typeof values.search === 'string') {
    const query = values.search;
    markets = markets.filter(market => matchesMarketSearch(market, query));
  }

  if (values.coverage) {
    const report = realMarketCoverage(markets, getTickCount);
    if (typeof values.search === 'string') for (const category of report.categories) {
      if (!category.symbols) category.status = 'NO_MATCH_IN_SEARCH';
    }
    print(JSON.stringify(report, null, 2));
    return;
  }

  markets = selectMarkets(markets, values.all ? 'ALL' : getEnv().MARKET_SCOPE);
  if (categoryFilter) {
    markets = markets.filter(m => categoryMatches(m.marketCategory, categoryFilter));
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

  print('╔═════════════════════════════════════════════════════════════════════════════════════════╗');
  print(`║  SELECTED MARKETS (${String(results.length)} symbols found)                                                          ║`.padEnd(90, ' ') + '║');
  print('╠═════════════════════════════════════════════════════════════════════════════════════════╣');
  print('║ Category    Symbol         Name                    Ticks   Open  Score                  ║');
  print('╠═════════════════════════════════════════════════════════════════════════════════════════╣');

  for (const r of results) {
    const cat = r.market.marketCategory.padEnd(11, ' ').slice(0, 11);
    const sym = r.market.symbol.padEnd(14, ' ').slice(0, 14);
    const name = r.market.displayName.padEnd(23, ' ').slice(0, 23);
    const ticksStr = r.ticks.toLocaleString().padStart(8, ' ');
    const open = r.market.exchangeIsOpen ? '✓' : '✗';
    const openStr = open.padEnd(5, ' ');
    const score = r.market.researchScore.toString().padStart(3, ' ');
    
    print(`║ ${cat} ${sym} ${name} ${ticksStr}  ${openStr} ${score}                    ║`);
  }

  print('╚═════════════════════════════════════════════════════════════════════════════════════════╝');
  print('Tip: Run `npm run research:daemon` to collect more data.');
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Market discovery failed'); process.exitCode = 1; });
