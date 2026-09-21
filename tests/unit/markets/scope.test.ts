import Database from 'better-sqlite3';
import { classifyMarket } from '../../../src/config/markets.js';
import { describe, expect, it } from 'vitest';
import { marketAllowed, selectMarkets, storedMarketAllowed } from '../../../src/markets/MarketScope.js';
const market = (symbol: string, marketCategory: string, type: string, exchangeIsOpen = true): { symbol: string; marketCategory: string; market: string; submarket: string; exchangeIsOpen: boolean } =>
  ({ symbol, marketCategory, market: type, submarket: '', exchangeIsOpen });
describe('real-market scope', () => {
  it('does not mistake the xAUD substring in forex symbols for the XAU metal code', () => {
    expect(classifyMarket('frxAUDUSD', { market: 'forex' })).toBe('forex');
    expect(classifyMarket('frxAUDCAD', { market: 'forex' })).toBe('forex');
    expect(classifyMarket('frxXAUUSD', { market: 'forex' })).toBe('metals');
    expect(classifyMarket('frxXAGUSD', { market: 'forex' })).toBe('metals');
  });
  it('excludes every synthetic family and unknowns while retaining distinct real asset classes', () => {
    for (const symbol of ['1HZ10V', 'R_100', 'BOOM500', 'CRASH500', 'JD10', 'RDB100', 'DEX600UP', 'STPRNG']) expect(marketAllowed(symbol, 'REAL')).toBe(false);
    expect(marketAllowed('UNKNOWN', 'REAL')).toBe(false);
    for (const category of ['forex', 'metals', 'commodities', 'crypto', 'stock_indices', 'stocks']) expect(marketAllowed('provider_symbol', 'REAL', { marketCategory: category })).toBe(true);
    expect(marketAllowed('frxUSDfake', 'REAL', { market: 'synthetic_index' })).toBe(false);
  });
  it('combines scope, explicit watchlists and open status without falling back to synthetics', () => {
    const rows = [market('frxEURUSD', 'forex', 'forex'), market('frxXAUUSD', 'metals', 'commodities', false), market('cryBTCUSD', 'crypto', 'cryptocurrency'), market('1HZ10V', 'volatility', 'synthetic_index')];
    expect(selectMarkets(rows, 'REAL', ['ALL'], true).map(row => row.symbol)).toEqual(['frxEURUSD', 'cryBTCUSD']);
    expect(selectMarkets(rows, 'REAL', ['1HZ10V'])).toEqual([]);
    expect(selectMarkets(rows, 'SYNTHETIC').map(row => row.symbol)).toEqual(['1HZ10V']);
    expect(selectMarkets(rows, 'REAL', ['frxXAUUSD']).map(row => row.symbol)).toEqual(['frxXAUUSD']);
  });
  it('uses saved provider metadata for historical index symbols', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE symbols(symbol TEXT, market TEXT, submarket TEXT, display_name TEXT, instrument_type TEXT); INSERT INTO symbols VALUES ('OTC_INDEX','indices','','Index','stock_indices')");
      expect(storedMarketAllowed(db, 'OTC_INDEX', 'REAL')).toBe(true);
      expect(storedMarketAllowed(db, '1HZ10V', 'REAL')).toBe(false);
    } finally { db.close(); }
  });
});
