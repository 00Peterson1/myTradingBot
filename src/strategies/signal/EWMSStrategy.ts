import { Strategy, makeSignal } from '../base/Strategy.js';
import type { TickFeatures } from '../../types/tick.js';
import type { Signal } from '../../types/signal.js';

export class EWMSStrategy implements Strategy {
  readonly name = 'EWMS(momentum)';
  readonly description = 'EWMS momentum strategy (LSTM approximation)';

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    const mom = current.ewmsMomentum;
    const acc = current.ewmsAcceleration;
    const fast = current.ewmsFast;
    const slow = current.ewmsSlow;

    if (mom === null || acc === null || fast === null || slow === null) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'null_features' });
    }

    let direction: Signal['direction'] = 'NONE';
    if (mom > 0.5 && acc > 0) {
      direction = 'BUY';
    } else if (mom < -0.5 && acc < 0) {
      direction = 'SELL';
    }

    const confidence = Math.min(1.0, Math.abs(mom) / 2.0);

    return makeSignal(this.name, current, direction, confidence, { mom, acc });
  }
}
