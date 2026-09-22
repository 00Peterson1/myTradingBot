import { describe, expect, it } from 'vitest';
import { marketAliases, matchesMarketSearch } from '../../../src/markets/MarketNames.js';
import { realMarketCoverage } from '../../../src/markets/RealMarketCoverage.js';
import type { MarketInfo } from '../../../src/markets/MarketCatalogue.js';
const sp: MarketInfo = { symbol: 'OTC_SPC', displayName: 'US 500', market: 'indices', submarket: 'americas_OTC', marketCategory: 'stock_indices', exchangeIsOpen: false, tradabilityScore: 0, researchScore: 0 };
describe('provider symbol names', () => {
  it('finds S&P 500 without changing its executable provider identifier', () => {
    for (const name of ['S&P500', 'S&P 500', 'SP500', 'US 500', 'OTC_SPC']) expect(matchesMarketSearch(sp, name)).toBe(true);
    const row = realMarketCoverage([sp], () => 0).symbols[0];
    expect(row?.symbol).toBe('OTC_SPC');
    expect(row?.displayName).toBe('US 500');
    expect(row?.aliases).toContain('S&P 500');
    expect(row?.researchCandidates).toHaveLength(6);
  });
  it('preserves all supplied names and does not confuse ETFs or synthetic 500 products with the index', () => {
    expect(matchesMarketSearch(sp, 'SPY')).toBe(false);
    expect(matchesMarketSearch(sp, '!!!')).toBe(false);
    expect(marketAliases({ ...sp, symbol: 'BOOM500', displayName: 'Boom 500', marketCategory: 'boom' })).toEqual([]);
    expect(matchesMarketSearch({ ...sp, symbol: 'NEW', displayName: 'New Provider Instrument' }, 'provider instrument')).toBe(true);
  });
});
