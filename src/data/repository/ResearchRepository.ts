/**
 * Saves a completed research result to the market_profiles table.
 * Called by research.ts after analysing each symbol.
 * SymbolRanker reads this table on startup to auto-rank symbols.
 */

import { getDb } from '../database/sqlite.js';
import { detectMarketType, strategiesForMarketType } from '../../execution/SymbolRanker.js';

export interface ResearchResult {
  symbol: string;
  displayName: string;
  tickCount: number;
  mean: number;
  stdDev: number;
  skewness: number;
  kurtosis: number;
  sharpe: number | null;
  isAutocorrelated: boolean;
  autocorrPValue: number | null;
  isNormal: boolean;
  jbPValue: number | null;
  hasEdge: boolean;
  edgeLift: number | null;
  edgePValue: number | null;
  score: number;
}

export function saveResearchResult(result: ResearchResult): void {
  const db = getDb();
  const marketType = detectMarketType(result.symbol);
  const strategies = strategiesForMarketType(marketType);

  db.prepare(`
    INSERT INTO market_profiles (
      symbol, market_type, market_category,
      is_autocorrelated, is_normal, has_edge,
      std_dev, sharpe, score, tick_count,
      skewness, kurtosis,
      ljungbox_pvalue, jb_pvalue,
      momentum_lift, momentum_pvalue,
      recommended_strategies,
      last_profiled_at, last_seen_at
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(symbol) DO UPDATE SET
      market_type           = excluded.market_type,
      market_category       = excluded.market_category,
      is_autocorrelated     = excluded.is_autocorrelated,
      is_normal             = excluded.is_normal,
      has_edge              = excluded.has_edge,
      std_dev               = excluded.std_dev,
      sharpe                = excluded.sharpe,
      score                 = excluded.score,
      tick_count            = excluded.tick_count,
      skewness              = excluded.skewness,
      kurtosis              = excluded.kurtosis,
      ljungbox_pvalue       = excluded.ljungbox_pvalue,
      jb_pvalue             = excluded.jb_pvalue,
      momentum_lift         = excluded.momentum_lift,
      momentum_pvalue       = excluded.momentum_pvalue,
      recommended_strategies= excluded.recommended_strategies,
      last_profiled_at      = datetime('now'),
      last_seen_at          = datetime('now')
  `).run(
    result.symbol,
    marketType,
    marketType,                           // market_category mirrors market_type for synthetics
    result.isAutocorrelated ? 1 : 0,
    result.isNormal ? 1 : 0,
    result.hasEdge ? 1 : 0,
    result.stdDev,
    result.sharpe,
    result.score,
    result.tickCount,
    result.skewness,
    result.kurtosis,
    result.autocorrPValue,
    result.jbPValue,
    result.edgeLift,
    result.edgePValue,
    JSON.stringify(strategies),
  );
}
