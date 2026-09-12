import type { Strategy } from '../base/Strategy.js';
import type { Signal } from '../../types/signal.js';
import type { TickFeatures } from '../../types/tick.js';
import { makeSignal } from '../base/Strategy.js';

/**
 * Strategy C — Mean Reversion
 *
 * Signal: Z = (P_t - μ_t) / σ_t
 * where μ_t is rolling mean, σ_t is rolling std.
 *
 * If price is far above mean (high Z): expect reversion → SELL
 * If price is far below mean (low Z): expect reversion → BUY
 *
 * This is the opposite of momentum: it bets on return to mean.
 *
 * EMPIRICAL CAUTION:
 * Mean reversion is more common in range-bound markets.
 * In trending markets, mean reversion strategies lose catastrophically.
 * This strategy is ONLY applicable to instruments that empirically
 * exhibit negative autocorrelation (tested separately).
 * Do not trade this strategy unless negative AC(1) is confirmed.
 */
export interface MeanReversionParams {
  zScoreKey: 'zScore20' | 'zScore50';
  entryThreshold: number; // Enter when |Z| > entryThreshold
  exitThreshold: number; // Mean reversion "complete" when |Z| < exitThreshold
}

export class MeanReversionStrategy implements Strategy {
  readonly name: string;
  readonly description: string;

  constructor(private readonly params: MeanReversionParams) {
    this.name = `MeanReversion(key=${params.zScoreKey},entry=${params.entryThreshold})`;
    this.description =
      `Mean reversion on Z-score: BUY if Z < -${params.entryThreshold}, ` +
      `SELL if Z > ${params.entryThreshold}`;
  }

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    const z = current[this.params.zScoreKey];

    if (z === null || z === undefined) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'insufficient_history' });
    }

    // Price far below mean → expect upward reversion → BUY
    if (z < -this.params.entryThreshold) {
      const confidence = Math.min(
        1,
        (Math.abs(z) - this.params.entryThreshold) / this.params.entryThreshold,
      );
      return makeSignal(this.name, current, 'BUY', confidence, {
        zScore: z,
        entryThreshold: this.params.entryThreshold,
        interpretation: 'price_below_mean_expect_reversion_up',
      });
    }

    // Price far above mean → expect downward reversion → SELL
    if (z > this.params.entryThreshold) {
      const confidence = Math.min(1, (z - this.params.entryThreshold) / this.params.entryThreshold);
      return makeSignal(this.name, current, 'SELL', confidence, {
        zScore: z,
        entryThreshold: this.params.entryThreshold,
        interpretation: 'price_above_mean_expect_reversion_down',
      });
    }

    return makeSignal(this.name, current, 'NONE', 0, { zScore: z, reason: 'within_band' });
  }
}
