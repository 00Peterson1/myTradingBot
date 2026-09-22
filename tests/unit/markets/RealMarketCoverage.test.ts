import { describe, expect, it } from 'vitest';
import { realMarketCoverage, researchFactoriesForMarket, realMarketPlans } from '../../../src/markets/RealMarketCoverage.js';
import { strategiesForMarketType } from '../../../src/execution/SymbolRanker.js';
import type { MarketInfo } from '../../../src/markets/MarketCatalogue.js';
function market(symbol: string, category: string, open = true): MarketInfo {
  return { symbol, displayName: symbol, market: category, submarket: category, marketCategory: category, exchangeIsOpen: open, tradabilityScore: 0, researchScore: 0 };
}
describe('real symbol research coverage', () => {
  it('covers arbitrary provider symbols in all six real categories without a hard-coded watchlist', () => {
    const markets = Object.keys(realMarketPlans).flatMap(category => [market(`NEW_${category}_1`, category), market(`NEW_${category}_2`, category, false)]);
    const report = realMarketCoverage(markets, () => 0);
    expect(report.symbols).toHaveLength(12);
    expect(report.categories.every(row => row.symbols === 2)).toBe(true);
    for (const row of report.symbols) {
      expect(row.researchCandidates.length).toBeGreaterThanOrEqual(4);
      expect(row.requirements.length).toBeGreaterThan(0);
      expect(row.cfdExecution).toContain('Unverified');
      expect(row.optionsExecution).toContain('Requires');
    }
    expect(strategiesForMarketType('stocks')).toEqual(['momentum', 'mean-reversion']);
    expect(strategiesForMarketType('crypto')).toEqual(['vol-adj-momentum', 'breakout']);
    expect(report.symbols.filter(row => !row.exchangeOpen)).toHaveLength(6);
  });
  it('uses distinct category hypotheses and fresh strategy instances', () => {
    const forex = researchFactoriesForMarket('EURUSD', { market: 'forex' });
    const crypto = researchFactoriesForMarket('BTCUSD', { market: 'crypto' });
    expect(forex.map(row => row.name)).not.toEqual(crypto.map(row => row.name));
    expect(forex[0]?.factory()).not.toBe(forex[0]?.factory());
    expect(researchFactoriesForMarket('R_100', { market: 'synthetic_index' })).toEqual([]);
  });
  it('reports absent categories and unknown metadata instead of inventing symbol support', () => {
    const report = realMarketCoverage([market('EURUSD', 'forex'), market('UNCLASSIFIED', 'new_market'), market('R_100', 'synthetic_index')], () => 100);
    expect(report.symbols.map(row => row.symbol)).toEqual(['EURUSD']);
    expect(report.unclassified).toEqual(['UNCLASSIFIED']);
    expect(report.categories.filter(row => row.status === 'NOT_RETURNED_BY_OPTIONS_FEED')).toHaveLength(5);
  });
});
