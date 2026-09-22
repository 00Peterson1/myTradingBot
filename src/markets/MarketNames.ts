import type { MarketInfo } from './MarketCatalogue.js';

/** Search labels only. Never replace a broker's execution symbol with an index/ETF ticker. */
export function marketAliases(market: Pick<MarketInfo, 'symbol' | 'displayName' | 'marketCategory'>): string[] {
  if (market.marketCategory === 'stock_indices' && market.symbol === 'OTC_SPC' && market.displayName === 'US 500') {
    return ['S&P 500', 'S&P500', 'SP500', 'US SP 500'];
  }
  return [];
}
export function matchesMarketSearch(market: MarketInfo, query: string): boolean {
  const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const search = normalize(query);
  if (!search) return false;
  return [market.symbol, market.displayName, ...marketAliases(market)].some(value => normalize(value).includes(search));
}
