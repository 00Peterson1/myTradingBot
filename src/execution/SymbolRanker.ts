import { classifyMarket, type MarketType } from '../config/markets.js';
export type { MarketType } from '../config/markets.js';
/**
 * SymbolRanker
 *
 * Reads the SQLite research database and ranks symbols by their
 * statistical properties — automatically choosing which symbols
 * are best to trade and which strategies to apply to each.
 *
 * Market-type-specific strategy selection:
 *
 *   Volatility (1HZ10V–250V)  → All strategies. Pure GBM, look for autocorrelation.
 *   Boom (BOOM300N–1000)      → Mean-reversion after spike, wavelet (spike detection).
 *   Crash (CRASH300N–1000)    → Same as Boom, inverted.
 *   Step (stpRNG)             → Mean-reversion only (step reversals).
 *   Jump (JD10–100)           → Vol-adj momentum (jump clustering).
 */

import { createLogger } from '../monitoring/Logger.js';

const log = createLogger('SymbolRanker');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StrategyName =
  | 'momentum'
  | 'vol-adj-momentum'
  | 'mean-reversion'
  | 'breakout'
  | 'wavelet'
  | 'ewms'
  | 'digit-even-odd'
  | 'digit-over-under'
  | 'digit-matches-differs';

export interface SymbolProfile {
  symbol: string;
  marketType: MarketType;
  score: number;           // 0–100 tradability score from research
  isAutocorrelated: boolean;
  isNormal: boolean;
  hasEdge: boolean;
  stdDev: number;
  sharpe: number | null;
  recommendedStrategies: StrategyName[];
  reason: string;          // Why this symbol was ranked here
}

// ---------------------------------------------------------------------------
// Market type detection
// ---------------------------------------------------------------------------

export function detectMarketType(symbol: string): MarketType { return classifyMarket(symbol); }

/**
 * Returns the appropriate strategies for a given market type.
 * Based on statistical properties of each market class.
 */
export function strategiesForMarketType(type: MarketType): StrategyName[] {
  switch (type) {
    case 'volatility':
      // Pure GBM — run full suite, vote filters noise
      return ['momentum', 'vol-adj-momentum', 'mean-reversion', 'breakout', 'wavelet', 'ewms'];

    case 'boom':
      // Upward spikes every ~N ticks → look for pre-spike momentum and post-spike mean-reversion
      return ['wavelet', 'mean-reversion', 'vol-adj-momentum', 'ewms'];

    case 'crash':
      // Downward spikes — same logic as boom, mirrored
      return ['wavelet', 'mean-reversion', 'vol-adj-momentum', 'ewms'];

    case 'step':
      // Fixed 0.1-pip steps — only direction matters, mean-reversion on runs
      return ['mean-reversion', 'ewms'];

    case 'jump':
      // Brownian + random jumps — vol-adjusted strategies handle jump risk
      return ['vol-adj-momentum', 'wavelet', 'ewms'];

    case 'forex':
      // Forex pairs exhibit strong trend persistence and macro momentum
      return ['momentum', 'vol-adj-momentum', 'breakout', 'ewms'];

    case 'metals':
    case 'commodities':
      // Commodities (Gold/Silver) show strong volatility breakouts
      return ['momentum', 'vol-adj-momentum', 'breakout', 'wavelet'];

    case 'crypto':
      // Crypto pairs display high volatility and strong trend momentum
      return ['momentum', 'vol-adj-momentum', 'breakout', 'ewms'];

    case 'stock_indices':
      // Stock indices exhibit long-term drift + short-term mean reversion
      return ['momentum', 'mean-reversion', 'breakout', 'ewms'];

    case 'unknown':
    default:
      return ['momentum', 'wavelet', 'ewms'];
  }
}

// ---------------------------------------------------------------------------
// SymbolRanker
// ---------------------------------------------------------------------------

export class SymbolRanker {
  private profiles: SymbolProfile[] = [];

  /**
   * Loads symbol profiles from the research database.
   * Falls back to hardcoded defaults if DB is unavailable.
   */
  async load(symbols: string[]): Promise<void> {
    const dbProfiles: SymbolProfile[] = [];

    try {
      const { getDb } = await import('../data/database/sqlite.js');
      const db = getDb();

      // Try to read from market_profiles table (written by research.ts)
      const rows = db
        .prepare<[], {
          symbol: string;
          market_category: string;
          is_autocorrelated: number;
          is_normal: number;
          has_edge: number;
          std_dev: number | null;
          sharpe: number | null;
          score: number;
        }>(`
          SELECT
            mp.symbol, mp.market_category,
            COALESCE(mp.is_autocorrelated, 0) as is_autocorrelated,
            COALESCE(mp.is_normal, 1)         as is_normal,
            COALESCE(mp.has_edge, 0)          as has_edge,
            mp.std_dev,
            mp.sharpe,
            COALESCE(mp.score, 0)             as score
          FROM market_profiles mp
          ORDER BY mp.score DESC
        `)
        .all();

      for (const row of rows) {
        if (!symbols.includes(row.symbol)) continue;
        const marketType = classifyMarket(row.symbol, { marketCategory: row.market_category });
        dbProfiles.push({
          symbol: row.symbol,
          marketType,
          score: row.score,
          isAutocorrelated: Boolean(row.is_autocorrelated),
          isNormal: Boolean(row.is_normal),
          hasEdge: Boolean(row.has_edge),
          stdDev: row.std_dev ?? 0,
          sharpe: row.sharpe,
          recommendedStrategies: this.pickStrategies(row, marketType),
          reason: this.buildReason(row),
        });
      }

      if (dbProfiles.length > 0) {
        log.info({ count: dbProfiles.length }, 'Loaded symbol profiles from research DB');
      }
    } catch {
      log.warn('Could not read from research DB — using defaults based on market type');
    }

    // Fill in any symbols not in DB with type-based defaults
    const inDb = new Set(dbProfiles.map((p) => p.symbol));
    for (const symbol of symbols) {
      if (inDb.has(symbol)) continue;
      const marketType = detectMarketType(symbol);
      dbProfiles.push({
        symbol,
        marketType,
        score: 30, // neutral default
        isAutocorrelated: false,
        isNormal: true,
        hasEdge: false,
        stdDev: 0,
        sharpe: null,
        recommendedStrategies: strategiesForMarketType(marketType),
        reason: `No research data — using defaults for ${marketType} market type`,
      });
    }

    // Sort: highest score first (Volatility indices prioritized for Rise/Fall options)
    this.profiles = dbProfiles.sort((a, b) => {
      // For Rise/Fall options, volatility markets have higher availability on Deriv
      const aSupported = a.marketType === 'volatility' ? 1 : 0;
      const bSupported = b.marketType === 'volatility' ? 1 : 0;
      if (aSupported !== bSupported) return bSupported - aSupported;
      return b.score - a.score;
    });
    this.logRanking();
  }

  /**
   * Returns all ranked profiles, best first.
   */
  getAll(): SymbolProfile[] {
    return [...this.profiles];
  }

  /**
   * Returns the top N symbols by research score.
   */
  getTop(n: number): SymbolProfile[] {
    return this.profiles.slice(0, n);
  }

  /**
   * Returns the profile for a specific symbol.
   */
  getProfile(symbol: string): SymbolProfile | undefined {
    return this.profiles.find((p) => p.symbol === symbol);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private pickStrategies(
    row: { is_autocorrelated: number; has_edge: number; is_normal: number },
    marketType: MarketType,
  ): StrategyName[] {
    const base = strategiesForMarketType(marketType);

    // If autocorrelated, prioritise mean-reversion
    if (row.is_autocorrelated) {
      return [
        'mean-reversion',
        ...base.filter((s) => s !== 'mean-reversion'),
      ] as StrategyName[];
    }

    // If momentum edge detected, prioritise momentum
    if (row.has_edge) {
      return [
        'momentum',
        'vol-adj-momentum',
        ...base.filter((s) => s !== 'momentum' && s !== 'vol-adj-momentum'),
      ] as StrategyName[];
    }

    // Non-normal → prefer vol-adjusted and wavelet
    if (!row.is_normal) {
      return [
        'vol-adj-momentum',
        'wavelet',
        ...base.filter((s) => s !== 'vol-adj-momentum' && s !== 'wavelet'),
      ] as StrategyName[];
    }

    return base;
  }

  private buildReason(row: {
    is_autocorrelated: number;
    has_edge: number;
    is_normal: number;
    score: number;
  }): string {
    const parts: string[] = [];
    if (row.is_autocorrelated) parts.push('serial dependence detected');
    if (row.has_edge) parts.push('momentum edge found');
    if (!row.is_normal) parts.push('fat tails / non-normal');
    if (parts.length === 0) parts.push('random walk — low edge');
    return parts.join(', ');
  }

  private logRanking(): void {
    log.info('Symbol ranking (best → worst):');
    for (const p of this.profiles) {
      log.info(
        {
          symbol: p.symbol,
          type: p.marketType,
          score: p.score,
          strategies: p.recommendedStrategies,
          reason: p.reason,
        },
        `  ${p.symbol}`,
      );
    }
  }
}
