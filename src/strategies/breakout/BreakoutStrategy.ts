import type { Strategy } from '../base/Strategy.js';
import type { Signal } from '../../types/signal.js';
import type { TickFeatures } from '../../types/tick.js';
import { makeSignal } from '../base/Strategy.js';

/**
 * Strategy D — Breakout
 *
 * Signal: Price breaking above/below rolling high/low.
 *
 * BUY  if price > rollingHigh_{t-1} (breakout above range)
 * SELL if price < rollingLow_{t-1}  (breakout below range)
 *
 * Theoretical basis: Donchian channels, turtle trading systems.
 * Evidence: Faber (2007), "A Quantitative Approach to Tactical Asset Allocation"
 * Evidence: Covel (2007), "Trend Following"
 *
 * EMPIRICAL CAUTION:
 * Breakout strategies work best in trending, low-autocorrelation regimes.
 * On algorithmically generated markets, breakouts may be illusory — the
 * synthetic index generator may not create persistent trends.
 * Validate empirically with out-of-sample tests.
 */
export interface BreakoutStrategyParams {
  highKey: 'rollingHigh20' | 'rollingHigh50';
  lowKey: 'rollingLow20' | 'rollingLow50';
  confirmationFraction: number; // e.g. 0.001 = must break by 0.1% beyond high/low
}

export class BreakoutStrategy implements Strategy {
  readonly name: string;
  readonly description: string;

  constructor(private readonly params: BreakoutStrategyParams) {
    this.name = `Breakout(high=${params.highKey},low=${params.lowKey},confirm=${params.confirmationFraction})`;
    this.description =
      `Breakout: BUY if price > rollingHigh * (1 + ${params.confirmationFraction}), ` +
      `SELL if price < rollingLow * (1 - ${params.confirmationFraction})`;
  }

  generateSignal(current: TickFeatures, history: readonly TickFeatures[]): Signal {
    // Use previous tick's high/low to avoid look-ahead bias
    const prev = history[history.length - 1];
    if (!prev) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'no_history' });
    }

    const prevHigh = prev[this.params.highKey];
    const prevLow = prev[this.params.lowKey];
    const price = current.price;

    if (prevHigh === null || prevHigh === undefined || prevLow === null || prevLow === undefined) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'insufficient_history' });
    }

    const upperBreak = prevHigh * (1 + this.params.confirmationFraction);
    const lowerBreak = prevLow * (1 - this.params.confirmationFraction);

    if (price > upperBreak) {
      const breakMagnitude = (price - prevHigh) / prevHigh;
      const confidence = Math.min(1, breakMagnitude / (this.params.confirmationFraction * 5));
      return makeSignal(this.name, current, 'BUY', confidence, {
        price,
        prevHigh,
        upperBreak,
        breakMagnitude,
      });
    }

    if (price < lowerBreak) {
      const breakMagnitude = (prevLow - price) / prevLow;
      const confidence = Math.min(1, breakMagnitude / (this.params.confirmationFraction * 5));
      return makeSignal(this.name, current, 'SELL', confidence, {
        price,
        prevLow,
        lowerBreak,
        breakMagnitude,
      });
    }

    return makeSignal(this.name, current, 'NONE', 0, {
      price,
      prevHigh,
      prevLow,
      reason: 'within_range',
    });
  }
}
