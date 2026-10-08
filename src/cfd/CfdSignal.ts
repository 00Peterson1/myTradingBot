import type { CfdBacktestConfig } from './CfdBacktest.js';

/** One causal signal calculation shared by historical replay and the demo runner. */
export function cfdDirection(mids: readonly number[], mid: number, config: Pick<CfdBacktestConfig, 'family' | 'lookback' | 'threshold'>): 'LONG' | 'SHORT' | null {
  if (mids.length < config.lookback || !Number.isFinite(mid) || mid <= 0) return null;
  const history = mids.slice(-config.lookback), oldest = history[0];
  if (oldest === undefined || history.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid causal CFD history');
  const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
  const direction = config.family === 'MOMENTUM' ? (mid - oldest) / oldest : config.family === 'MEAN_REVERSION' ? (mean - mid) / mean
    : mid > Math.max(...history) * (1 + config.threshold) ? 1 : mid < Math.min(...history) * (1 - config.threshold) ? -1 : 0;
  return Math.abs(direction) > config.threshold ? direction > 0 ? 'LONG' : 'SHORT' : null;
}
