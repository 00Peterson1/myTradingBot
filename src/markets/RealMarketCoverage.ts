import { marketAliases } from './MarketNames.js';
import { classifyMarket, type MarketMetadata } from '../config/markets.js';
import { strategyFactories, type StrategyFactory } from '../strategies/catalogue.js';
import type { MarketInfo } from './MarketCatalogue.js';

/** Research candidates, not validated trading rules. No symbol-specific edge is assumed. */
export const realMarketPlans = {
  forex: { families: ['Momentum', 'VolAdjMomentum', 'MeanReversion'], requirements: ['Trading sessions', 'Economic announcements', 'Rollover and currency conversion'] },
  metals: { families: ['VolAdjMomentum', 'Breakout', 'MeanReversion'], requirements: ['Contract size', 'USD/rate announcements', 'Financing and session gaps'] },
  commodities: { families: ['Momentum', 'VolAdjMomentum', 'Breakout'], requirements: ['Contract/roll adjustments', 'Inventory announcements', 'Financing and session gaps'] },
  crypto: { families: ['VolAdjMomentum', 'Breakout'], requirements: ['Weekend liquidity', 'Spread/slippage stress', 'Financing schedule'] },
  stock_indices: { families: ['Momentum', 'Breakout', 'MeanReversion'], requirements: ['Exchange sessions and gaps', 'Dividend/contract adjustments', 'Index-specific macro events'] },
  stocks: { families: ['Momentum', 'MeanReversion'], requirements: ['Corporate actions', 'Earnings and exchange halts', 'Dividend and short-selling conditions'] },
} as const;
export type RealMarketCategory = keyof typeof realMarketPlans;
export function realMarketCategory(symbol: string, metadata: MarketMetadata): RealMarketCategory | null {
  const category = classifyMarket(symbol, metadata);
  return Object.hasOwn(realMarketPlans, category) ? category as RealMarketCategory : null;
}
export function researchFactoriesForMarket(symbol: string, metadata: MarketMetadata): StrategyFactory[] {
  const category = realMarketCategory(symbol, metadata);
  if (!category) return [];
  const families: readonly string[] = realMarketPlans[category].families;
  return strategyFactories.filter(item => families.includes(item.name.split('(')[0] ?? item.name));
}
export function realMarketCoverage(markets: readonly MarketInfo[], tickCount: (symbol: string) => number): {
  categories: { category: string; symbols: number; status: string }[];
  symbols: { symbol: string; displayName: string; aliases: string[]; providerMarket: string; providerSubmarket: string; category: RealMarketCategory; exchangeOpen: boolean; ticks: number; researchCandidates: string[]; requirements: readonly string[]; optionsExecution: string; cfdExecution: string }[];
  unclassified: string[];
} {
  const symbols = markets.flatMap(market => {
    const category = realMarketCategory(market.symbol, market);
    if (!category) return [];
    return [{ symbol: market.symbol, displayName: market.displayName, aliases: marketAliases(market), providerMarket: market.market, providerSubmarket: market.submarket, category, exchangeOpen: market.exchangeIsOpen, ticks: tickCount(market.symbol),
      researchCandidates: researchFactoriesForMarket(market.symbol, market).map(row => row.name), requirements: realMarketPlans[category].requirements,
      optionsExecution: 'Requires symbol contract capability and validated hypothesis',
      cfdExecution: 'Unverified: requires separate cTrader catalogue, adapter and CFD evidence' }];
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { categories: Object.keys(realMarketPlans).map(category => {
    const count = symbols.filter(row => row.category === category).length;
    return { category, symbols: count, status: count ? 'DISCOVERED' : 'NOT_RETURNED_BY_OPTIONS_FEED' };
  }), symbols, unclassified: markets.filter(row => classifyMarket(row.symbol, row) === 'unknown').map(row => row.symbol).sort() };
}
