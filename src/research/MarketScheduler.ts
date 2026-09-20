import { selectMarkets } from '../markets/MarketScope.js';
import { isSyntheticCategory } from '../config/markets.js';
import { assertDefined } from '../utils/assertDefined.js';
import { getEnv } from '../config/env.js';
import type { MarketInfo } from '../markets/MarketCatalogue.js';
import { getTickCount } from '../data/repository/TickRepository.js';

export class MarketScheduler {
  private lastCollected = new Map<string, number>();

  nextBatch(markets: MarketInfo[]): { fast: string[]; slow: string | null } {
    const env = getEnv();
    
    markets = selectMarkets(markets, env.MARKET_SCOPE, env.COLLECT_SYMBOLS.length ? env.COLLECT_SYMBOLS : env.SYMBOLS);
    // Separate open markets by fast/slow
    const fastCandidates = markets.filter(m => 
      m.exchangeIsOpen && (isSyntheticCategory(m.marketCategory) || m.marketCategory === 'crypto')
    );
    const slowCandidates = markets.filter(m => 
      m.exchangeIsOpen && (!isSyntheticCategory(m.marketCategory) && m.marketCategory !== 'crypto')
    );

    // Sort by least recently collected
    fastCandidates.sort((a, b) => (this.lastCollected.get(a.symbol) ?? 0) - (this.lastCollected.get(b.symbol) ?? 0));
    slowCandidates.sort((a, b) => (this.lastCollected.get(a.symbol) ?? 0) - (this.lastCollected.get(b.symbol) ?? 0));

    const fast = fastCandidates.slice(0, env.DAEMON_PARALLEL_FAST).map(m => m.symbol);
    const slow = slowCandidates.length > 0 ? assertDefined(slowCandidates[0]).symbol : null;

    return { fast, slow };
  }

  markCollected(symbol: string): void {
    this.lastCollected.set(symbol, Date.now());
  }

  getPriority(markets: MarketInfo[]): string[] {
    const env = getEnv();
    const openMarkets = selectMarkets(markets, env.MARKET_SCOPE, env.COLLECT_SYMBOLS.length ? env.COLLECT_SYMBOLS : env.SYMBOLS, true);
    const withCounts = openMarkets.map(m => ({
      symbol: m.symbol,
      count: getTickCount(m.symbol)
    }));
    withCounts.sort((a, b) => a.count - b.count);
    return withCounts.map(w => w.symbol);
  }
}
