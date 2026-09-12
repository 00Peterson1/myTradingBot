import type { Strategy } from '../base/Strategy.js';
import type { Signal } from '../../types/signal.js';
import type { TickFeatures } from '../../types/tick.js';
import { makeSignal } from '../base/Strategy.js';

/**
 * Strategy A — Time-Series Momentum
 *
 * Based on: Moskowitz, Ooi & Pedersen (2012),
 * "Time Series Momentum", Journal of Financial Economics.
 *
 * Signal: Sign of log return over lookback period.
 * R_t(k) = ln(P_t / P_{t-k})
 *
 * BUY  if R_t(k) > threshold (past positive return → long)
 * SELL if R_t(k) < -threshold (past negative return → short)
 * NONE if |R_t(k)| < threshold (no clear trend)
 *
 * NOTE: On Deriv binary options, "SELL" = PUT contract.
 *
 * EMPIRICAL CAUTION:
 * Whether momentum works on Synthetic Indices is NOT assumed here.
 * This strategy is a hypothesis to be tested, not a proven edge.
 * The statistical validity must be established via backtesting and
 * walk-forward validation before any live trading consideration.
 */
export interface MomentumStrategyParams {
  /** Lookback window for momentum calculation (periods) */
  lookback: number;
  /** Minimum absolute momentum to generate a signal (noise filter) */
  threshold: number;
  /** Which momentum feature to use: 'mom5'|'mom10'|'mom20'|'mom50'|'mom100' */
  momentumKey: 'mom5' | 'mom10' | 'mom20' | 'mom50' | 'mom100';
}

export class MomentumStrategy implements Strategy {
  readonly name: string;
  readonly description: string;

  constructor(private readonly params: MomentumStrategyParams) {
    this.name = `Momentum(lookback=${params.lookback},threshold=${params.threshold})`;
    this.description =
      `Time-series momentum: BUY if R(${params.lookback}) > ${params.threshold}, ` +
      `SELL if R(${params.lookback}) < -${params.threshold}`;
  }

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    const mom = current[this.params.momentumKey];

    if (mom === null || mom === undefined) {
      return makeSignal(this.name, current, 'NONE', 0, {
        reason: 'insufficient_history',
        lookback: this.params.lookback,
      });
    }

    if (mom > this.params.threshold) {
      const confidence = Math.min(1, Math.abs(mom) / (this.params.threshold * 3));
      return makeSignal(this.name, current, 'BUY', confidence, {
        momentum: mom,
        threshold: this.params.threshold,
        lookback: this.params.lookback,
      });
    }

    if (mom < -this.params.threshold) {
      const confidence = Math.min(1, Math.abs(mom) / (this.params.threshold * 3));
      return makeSignal(this.name, current, 'SELL', confidence, {
        momentum: mom,
        threshold: this.params.threshold,
        lookback: this.params.lookback,
      });
    }

    return makeSignal(this.name, current, 'NONE', 0, {
      momentum: mom,
      reason: 'below_threshold',
    });
  }
}
