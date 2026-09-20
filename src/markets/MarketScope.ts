import type Database from 'better-sqlite3';
import { classifyMarket, isSyntheticCategory, type MarketMetadata } from '../config/markets.js';

export type MarketScope = 'REAL' | 'SYNTHETIC' | 'ALL';
const realCategories = new Set(['forex', 'metals', 'commodities', 'crypto', 'stock_indices', 'stocks']);

export function marketAllowed(symbol: string, scope: MarketScope, metadata: MarketMetadata = {}): boolean {
  if (scope === 'ALL') return true;
  const category = classifyMarket(symbol, metadata);
  return scope === 'REAL' ? realCategories.has(category) : isSyntheticCategory(category);
}

export function requestedSymbol(symbol: string, requested: readonly string[]): boolean {
  return requested.length === 0 || requested.some(value => value.toUpperCase() === 'ALL') || requested.includes(symbol);
}

/** One selection rule shared by discovery, surveys and collection. */
export function selectMarkets<T extends { symbol: string; marketCategory: string; market: string; submarket: string; exchangeIsOpen: boolean }>(
  markets: readonly T[], scope: MarketScope, requested: readonly string[] = [], openOnly = false,
): T[] {
  return markets.filter(row => requestedSymbol(row.symbol, requested) && (!openOnly || row.exchangeIsOpen) && marketAllowed(row.symbol, scope, row));
}

/** Historical/eligible instruments need metadata too: index symbols cannot be guessed safely. */
export function storedMarketAllowed(db: Database.Database, symbol: string, scope: MarketScope): boolean {
  if (scope === 'ALL') return true;
  const hasSymbols = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbols'").get();
  const metadata = hasSymbols ? db.prepare('SELECT market,submarket,display_name,instrument_type AS marketCategory FROM symbols WHERE symbol=?').get(symbol) as MarketMetadata | undefined : undefined;
  return marketAllowed(symbol, scope, metadata);
}
