import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/data/database/migrations.js';
import { DerivClient } from '../../../src/api/deriv/DerivClient.js';
import { ActiveSymbolSchema } from '../../../src/api/deriv/DerivTypes.js';
import { MarketCatalogue } from '../../../src/markets/MarketCatalogue.js';
let db: Database.Database;
vi.mock('../../../src/data/database/sqlite.js', () => ({ getDb: (): Database.Database => db }));
beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
afterEach(() => { db.close(); vi.restoreAllMocks(); });
describe('market discovery integrity', () => {
  it('uses market metadata and preserves research evidence on rediscovery', async () => {
    const client = new DerivClient();
    vi.spyOn(client, 'getActiveSymbols').mockResolvedValue([
      ActiveSymbolSchema.parse({ symbol: 'frxXAUUSD', display_name: 'Gold', market: 'commodities', submarket: 'metals', exchange_is_open: true }),
      ActiveSymbolSchema.parse({ symbol: 'US500', display_name: 'US 500', market: 'indices', submarket: 'americas', exchange_is_open: 1 }),
    ]);
    const first = await MarketCatalogue.discoverAll(client);
    expect(first.map(info => info.marketCategory)).toEqual(['metals', 'stock_indices']);
    expect(first[0]?.researchScore).toBe(0);
    db.prepare("UPDATE market_profiles SET research_score=88,last_profiled_at='2020-01-01' WHERE symbol='frxXAUUSD'").run();
    await MarketCatalogue.discoverAll(client);
    expect(db.prepare("SELECT research_score,last_profiled_at FROM market_profiles WHERE symbol='frxXAUUSD'").get()).toEqual({ research_score: 88, last_profiled_at: '2020-01-01' });
  });
});
