import type { Strategy } from '../base/Strategy.js';
import type { Signal } from '../../types/signal.js';
import type { TickFeatures } from '../../types/tick.js';
import { makeSignal } from '../base/Strategy.js';

/**
 * Strategy E — Regime-Aware Strategy
 *
 * Detects volatility regime (low / medium / high) and only generates
 * signals when historical performance in that regime was positive.
 *
 * Volatility regime is determined by realized volatility relative to
 * its own rolling distribution.
 *
 * This is a meta-strategy wrapper: it wraps an inner strategy and
 * applies a regime filter — only passing signals through in regimes
 * where the inner strategy historically performed well.
 *
 * EMPIRICAL CAUTION:
 * Regime detection introduces additional parameters, increasing
 * overfitting risk. Walk-forward validation is MANDATORY before
 * considering this strategy for live trading.
 * The regime boundaries (vol quantiles) must not be optimized
 * on the test set.
 */
export type VolatilityRegime = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

export interface RegimeStrategyParams {
  /** Inner strategy to filter */
  innerStrategy: Strategy;
  /** Regimes in which the inner strategy is allowed to trade */
  allowedRegimes: VolatilityRegime[];
  /** Low vol threshold (percentile of realized vol distribution) */
  lowVolThreshold: number; // e.g. 0.33 = bottom third
  /** High vol threshold (percentile) */
  highVolThreshold: number; // e.g. 0.67 = top third
}

export class RegimeStrategy implements Strategy {
  readonly name: string;
  readonly description: string;

  constructor(private readonly params: RegimeStrategyParams) {
    this.name = `Regime(inner=${params.innerStrategy.name},allowed=${params.allowedRegimes.join(',')})`;
    this.description =
      `Regime filter: passes signals from ${params.innerStrategy.name} ` +
      `only in regimes: ${params.allowedRegimes.join(', ')}`;
  }

  generateSignal(current: TickFeatures, history: readonly TickFeatures[]): Signal {
    const regime = this.classifyRegime(current, history);

    const innerSignal = this.params.innerStrategy.generateSignal(current, history);

    if (regime === 'UNKNOWN') {
      return makeSignal(this.name, current, 'NONE', 0, {
        reason: 'unknown_regime',
        innerDirection: innerSignal.direction,
      });
    }

    if (!this.params.allowedRegimes.includes(regime)) {
      return makeSignal(this.name, current, 'NONE', 0, {
        reason: 'regime_filtered',
        regime,
        allowedRegimes: this.params.allowedRegimes,
        innerDirection: innerSignal.direction,
      });
    }

    // Pass through the inner signal with regime context
    return {
      ...innerSignal,
      id: crypto.randomUUID(),
      strategy: this.name,
      metadata: {
        ...innerSignal.metadata,
        regime,
        allowedRegimes: this.params.allowedRegimes,
        innerStrategy: this.params.innerStrategy.name,
      },
    };
  }

  private classifyRegime(
    current: TickFeatures,
    history: readonly TickFeatures[],
  ): VolatilityRegime {
    const vol = current.realizedVol20;
    if (vol === null) return 'UNKNOWN';

    // Collect historical realized vols
    const historicalVols = history
      .map((f) => f.realizedVol20)
      .filter((v): v is number => v !== null);

    if (historicalVols.length < 20) return 'UNKNOWN';

    const sorted = [...historicalVols].sort((a, b) => a - b);
    const lowBound = sorted[Math.floor(sorted.length * this.params.lowVolThreshold)] ?? 0;
    const highBound = sorted[Math.floor(sorted.length * this.params.highVolThreshold)] ?? Infinity;

    if (vol <= lowBound) return 'LOW';
    if (vol >= highBound) return 'HIGH';
    return 'MEDIUM';
  }
}
