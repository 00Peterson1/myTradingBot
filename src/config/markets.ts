/** Categories describe instruments; option contract families are selected separately. */
export type MarketType =
  | 'volatility' | 'boom' | 'crash' | 'step' | 'jump' | 'range_break' | 'dex'
  | 'synthetic' | 'forex' | 'metals' | 'commodities' | 'crypto'
  | 'stock_indices' | 'stocks' | 'unknown';

export interface MarketMetadata {
  market?: string;
  submarket?: string;
  display_name?: string;
  marketCategory?: string;
  symbol_type?: string;
}

export interface MarketDefinition {
  symbol: string;
  displayName: string;
  category: MarketType;
  /** Decimal places, derived from the API quote increment; absent when unknown. */
  pipSize?: number;
  description: string;
}

const discovered = new Map<string, MarketDefinition>();
const syntheticCategories = new Set<MarketType>([
  'volatility', 'boom', 'crash', 'step', 'jump', 'range_break', 'dex', 'synthetic',
]);

export function isSyntheticCategory(category: string): boolean {
  return syntheticCategories.has(category as MarketType);
}

/** Metadata wins over symbol guesses. Unrecognised instruments stay unclassified. */
export function classifyMarket(symbol: string, metadata: MarketMetadata = {}): MarketType {
  const market = (metadata.market ?? '').toLowerCase();
  const submarket = (metadata.submarket ?? '').toLowerCase();
  const kind = (metadata.symbol_type ?? '').toLowerCase();
  const label = (metadata.display_name ?? '').toLowerCase();
  const key = symbol.toLowerCase();
  const details = `${submarket} ${label}`;

  const syntheticType = (): MarketType => {
    if (/\bboom\b|boom_indices/.test(details) || key.startsWith('boom')) return 'boom';
    if (/\bcrash\b|crash_indices/.test(details) || key.startsWith('crash')) return 'crash';
    if (/range[ _-]?break/.test(details) || /^rdb(100|200)/.test(key)) return 'range_break';
    if (/\bdex\b|dex_indices/.test(details) || key.startsWith('dex')) return 'dex';
    if (details.includes('step') || key.startsWith('stprng')) return 'step';
    if (details.includes('jump') || /^jd\d/.test(key)) return 'jump';
    if (/volatil|random_index/.test(details) || /^(1hz|r_\d)/.test(key)) return 'volatility';
    return 'synthetic';
  };

  if (/synthetic|derived/.test(market)) return syntheticType();
  // Gold and silver often use the same frx prefix as currencies.
  if (`${market} ${submarket}`.includes('metal') || /(?:xau|xag|xpt|xpd)/.test(key)) return 'metals';
  if (/commodit|energy|energies/.test(`${market} ${submarket}`)) return 'commodities';
  if (`${market} ${kind}`.includes('crypto')) return 'crypto';
  if (/indices|stock_index/.test(`${market} ${submarket} ${kind}`)) return 'stock_indices';
  if (/stock|equities/.test(`${market} ${kind}`)) return 'stocks';
  if (`${market} ${kind}`.includes('forex')) return 'forex';

  if (metadata.marketCategory && metadata.marketCategory !== 'unknown') {
    const known = metadata.marketCategory as MarketType;
    if (known === 'synthetic') return syntheticType();
    if (['volatility', 'boom', 'crash', 'step', 'jump', 'range_break', 'dex', 'forex',
      'metals', 'commodities', 'crypto', 'stock_indices', 'stocks'].includes(known)) return known;
  }
  // A previously unseen API market must not be disguised by a familiar prefix.
  if (market) return 'unknown';
  if (/^(1hz|r_\d|boom|crash|stprng|jd\d|rdb(?:100|200)|dex)/.test(key)) return syntheticType();
  if (/oil|brent|wti/.test(key)) return 'commodities';
  if (key.startsWith('cry')) return 'crypto';
  if (key.startsWith('frx')) return 'forex';
  return discovered.get(symbol)?.category ?? 'unknown';
}

export function categoryMatches(category: string, filter: string): boolean {
  const requested = filter.trim().toLowerCase().replace(/[- ]/g, '_');
  if (requested === 'all') return true;
  if (requested === 'synthetic' || requested === 'synthetics' || requested === 'derived') {
    return isSyntheticCategory(category);
  }
  if (requested === 'commodities') return category === 'metals' || category === 'commodities';
  if (requested === 'indices') return category === 'stock_indices';
  if (requested === 'boom_crash') return category === 'boom' || category === 'crash';
  return category === requested;
}

/** active_symbols pip/pip_size are price increments, not tick pip_size decimal counts. */
export function decimalPlacesForPip(increment: number | undefined): number | undefined {
  if (increment === undefined || !Number.isFinite(increment) || increment <= 0) return undefined;
  for (let digits = 0; digits <= 12; digits++) {
    const scaled = increment * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-9 && Math.round(scaled) > 0) return digits;
  }
  return undefined;
}

export function registerMarketDefinition(definition: MarketDefinition): void {
  discovered.set(definition.symbol, { ...definition });
}

export function getMarketDefinition(symbol: string): MarketDefinition {
  return discovered.get(symbol) ?? {
    symbol, displayName: symbol, category: classifyMarket(symbol),
    description: 'Not yet discovered from the API',
  };
}
