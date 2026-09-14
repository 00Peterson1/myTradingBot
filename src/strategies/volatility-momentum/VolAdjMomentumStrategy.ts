import type { Strategy } from '../base/Strategy.js';
import type { Signal } from '../../types/signal.js';
import type { TickFeatures } from '../../types/tick.js';
import { makeSignal } from '../base/Strategy.js';

/**
 * Strategy B — Volatility-Adjusted Momentum
 *
 * Based on: Barroso & Santa-Clara (2015),
 * "Momentum Has Its Moments", Journal of Financial Economics.
 * Also: Moreira & Muir (2017), "Volatility-Managed Portfolios"
 *
 * Signal: Z_t = R_t(k) / σ_t
 * where σ_t is realized volatility over the vol window.
 *
 * The intuition: scale momentum by volatility to get a signal
 * that is more comparable across different volatility regimes.
 *
 * BUY  if Z_t > z_threshold
 * SELL if Z_t < -z_threshold
 * NONE otherwise
 *
 * EMPIRICAL CAUTION:
 * Volatility scaling has theoretical appeal but must be empirically
 * validated on synthetic indices specifically. Do not assume it works.
 */
export interface VolAdjMomentumParams {
  momentumKey: 'volAdjMom20' | 'volAdjMom50';
  zThreshold: number; // Signal generated when |Z| > zThreshold
}

export class VolAdjMomentumStrategy implements Strategy {
  readonly name: string;
  readonly description: string;

  constructor(private readonly params: VolAdjMomentumParams) {
    this.name = `VolAdjMomentum(key=${params.momentumKey},z=${String(params.zThreshold)})`;
    this.description = `Volatility-adjusted momentum: BUY if Z > ${String(params.zThreshold)}, SELL if Z < -${String(params.zThreshold)}`;
  }

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    const z = current[this.params.momentumKey];

    if (z === null) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'insufficient_history' });
    }

    if (z > this.params.zThreshold) {
      const confidence = Math.min(1, (z - this.params.zThreshold) / this.params.zThreshold);
      return makeSignal(this.name, current, 'BUY', confidence, {
        zScore: z,
        zThreshold: this.params.zThreshold,
      });
    }

    if (z < -this.params.zThreshold) {
      const confidence = Math.min(
        1,
        (Math.abs(z) - this.params.zThreshold) / this.params.zThreshold,
      );
      return makeSignal(this.name, current, 'SELL', confidence, {
        zScore: z,
        zThreshold: this.params.zThreshold,
      });
    }

    return makeSignal(this.name, current, 'NONE', 0, { zScore: z, reason: 'below_threshold' });
  }
}
