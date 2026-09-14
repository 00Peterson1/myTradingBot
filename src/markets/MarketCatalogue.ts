import { z } from 'zod';
import { assertDefined } from '../utils/assertDefined.js';
import { getDb } from '../data/database/sqlite.js';
import type { DerivClient } from '../api/deriv/DerivClient.js';
import type { ActiveSymbol } from '../api/deriv/DerivTypes.js';

export interface MarketInfo {
  symbol: string;
  displayName: string;
  market: string;
  submarket: string;
  marketCategory: string; // synthetic | forex | crypto | stocks | commodities
  exchangeIsOpen: boolean;
  spot?: number;
  tradabilityScore: number;
  researchScore: number;
  lastProfiledAt?: Date;
}

const marketRowSchema = z.object({
  symbol: z.string(), display_name: z.string(), market: z.string(), submarket: z.string(),
  market_category: z.string(), exchange_is_open: z.number(),
  tradability_score: z.number(), research_score: z.number(), spot: z.number().nullish(),
  last_profiled_at: z.string().nullish(),
});

export const MarketCatalogue = {
  async discoverAll(client: DerivClient): Promise<MarketInfo[]> {
    const activeSymbols = await client.getActiveSymbols();
    const marketInfos: MarketInfo[] = [];

    const db = getDb();
    const upsertStmt = db.prepare(`
      INSERT INTO market_profiles (symbol, market_category, exchange_is_open, spot, tradability_score, research_score, last_profiled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        market_category = excluded.market_category,
        exchange_is_open = excluded.exchange_is_open,
        spot = excluded.spot,
        tradability_score = excluded.tradability_score,
        research_score = excluded.research_score,
        last_profiled_at = excluded.last_profiled_at,
        last_seen_at = datetime('now')
    `);
    const upsertSymbolStmt = db.prepare(`
      INSERT INTO symbols (symbol, display_name, market, submarket, instrument_type, is_active, last_seen_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET
        display_name = excluded.display_name,
        market = excluded.market,
        submarket = excluded.submarket,
        instrument_type = excluded.instrument_type,
        is_active = 1,
        last_seen_at = datetime('now')
    `);

    const transaction = db.transaction((infos: MarketInfo[], activeSyms: ActiveSymbol[]) => {
      for (let i = 0; i < infos.length; i++) {
        const info = assertDefined(infos[i]);
        const sym = assertDefined(activeSyms[i]);
        
        upsertSymbolStmt.run(
          sym.symbol,
          sym.display_name,
          sym.market,
          sym.submarket,
          info.marketCategory
        );

        upsertStmt.run(
          info.symbol,
          info.marketCategory,
          info.exchangeIsOpen ? 1 : 0,
          info.spot ?? null,
          info.tradabilityScore,
          info.researchScore,
          info.lastProfiledAt ? info.lastProfiledAt.toISOString() : null
        );
      }
    });

    for (const sym of activeSymbols) {
      if (!sym.symbol) continue;

      let category = 'stocks';
      const sLower = sym.symbol.toLowerCase();
      const mLower = sym.market ? sym.market.toLowerCase() : '';

      if (
        sym.symbol.startsWith('1HZ') ||
        sym.symbol.startsWith('BOOM') ||
        sym.symbol.startsWith('CRASH') ||
        sym.symbol.startsWith('stpRNG') ||
        sym.symbol.startsWith('JD') ||
        mLower.includes('synthetic')
      ) {
        category = 'synthetic';
      } else if (
        sym.symbol.startsWith('frx') ||
        mLower.includes('forex') ||
        /^(eur|gbp|usd|aud|nzd|jpy|chf|cad){2}$/i.test(sym.symbol)
      ) {
        category = 'forex';
      } else if (
        sym.symbol.startsWith('cry') ||
        mLower.includes('crypto') ||
        sLower.includes('btc') ||
        sLower.includes('eth') ||
        sLower.includes('ltc') ||
        sLower.includes('xrp')
      ) {
        category = 'crypto';
      } else if (
        sLower.includes('xau') ||
        sLower.includes('xag') ||
        sLower.includes('oil') ||
        sLower.includes('bco') ||
        sLower.includes('brent') ||
        sLower.includes('wti') ||
        mLower.includes('commodit')
      ) {
        category = 'commodities';
      }

      // We don't have exchange_is_open in the legacy ActiveSymbol wrapper directly unless it is exposed,
      // but let's assume 'exchange_is_open' is available in the original object or set it to true for now if missing.
      const isOpen = (sym.exchange_is_open === 1 || sym.exchange_is_open === true) && !sym.is_trading_suspended;
      const spot = sym.spot;

      const info: MarketInfo = {
        symbol: sym.symbol,
        displayName: sym.display_name || sym.symbol,
        market: sym.market || '',
        submarket: sym.submarket || '',
        marketCategory: category,
        exchangeIsOpen: isOpen,
        tradabilityScore: 50,
        researchScore: 50,
      };
      if (spot !== undefined) info.spot = spot;
      info.lastProfiledAt = new Date();
      
      marketInfos.push(info);
    }

    transaction(marketInfos, activeSymbols);

    return marketInfos.sort((a, b) => a.symbol.localeCompare(b.symbol));
  },

  getByCategory(category: string): MarketInfo[] {
    const rows = getDb().prepare(`
      SELECT mp.*, s.display_name, s.market, s.submarket
      FROM market_profiles mp
      JOIN symbols s ON mp.symbol = s.symbol
      WHERE mp.market_category = ?
      ORDER BY mp.symbol ASC
    `).all(category);
    return rows.map(row => this.mapRowToMarketInfo(row));
  },

  getAll(): MarketInfo[] {
    const rows = getDb().prepare(`
      SELECT mp.*, s.display_name, s.market, s.submarket
      FROM market_profiles mp
      JOIN symbols s ON mp.symbol = s.symbol
      ORDER BY mp.symbol ASC
    `).all();
    return rows.map(row => this.mapRowToMarketInfo(row));
  },

  getOpen(): MarketInfo[] {
    const rows = getDb().prepare(`
      SELECT mp.*, s.display_name, s.market, s.submarket
      FROM market_profiles mp
      JOIN symbols s ON mp.symbol = s.symbol
      WHERE mp.exchange_is_open = 1
      ORDER BY mp.symbol ASC
    `).all();
    return rows.map(row => this.mapRowToMarketInfo(row));
  },

  refreshPeriodically(client: DerivClient, intervalMs: number): NodeJS.Timeout {
    return setInterval(() => {
      this.discoverAll(client).catch((err: unknown) => {
        console.error('[MarketCatalogue] Failed to discover markets:', err);
      });
    }, intervalMs);
  },

  mapRowToMarketInfo(input: unknown): MarketInfo {
    const row = marketRowSchema.parse(input);
    const info: MarketInfo = {
      symbol: row.symbol,
      displayName: row.display_name,
      market: row.market,
      submarket: row.submarket,
      marketCategory: row.market_category,
      exchangeIsOpen: row.exchange_is_open === 1,
      tradabilityScore: row.tradability_score,
      researchScore: row.research_score,
    };
    if (row.spot !== undefined && row.spot !== null) info.spot = row.spot;
    if (row.last_profiled_at) info.lastProfiledAt = new Date(row.last_profiled_at);
    return info;
  }
};
