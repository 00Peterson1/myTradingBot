import type { Strategy} from '../base/Strategy.js';
import { makeSignal } from '../base/Strategy.js';
import type { TickFeatures } from '../../types/tick.js';
import type { Signal } from '../../types/signal.js';

export class WaveletStrategy implements Strategy {
  readonly name = 'Wavelet(HaarDWT)';
  readonly description = 'Haar wavelet trading strategy';

  generateSignal(current: TickFeatures, history: readonly TickFeatures[]): Signal {
    const trend = current.waveletTrend;
    const detail1 = current.waveletDetail1;
    const noise = current.waveletNoiseRatio;

    if (trend === null || detail1 === null || noise === null) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'null_features' });
    }

    if (noise > 2.0) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'too_noisy' });
    }

    const recentTrends = history.slice(-5).map(h => h.waveletTrend).filter((t): t is number => t !== null);
    if (recentTrends.length === 0) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'no_history' });
    }

    const meanTrend = recentTrends.reduce((a, b) => a + b, 0) / recentTrends.length;
    const trendChange = trend - meanTrend;
    const trendDirection = Math.sign(trendChange);

    let direction: Signal['direction'] = 'NONE';
    if (trendDirection > 0 && detail1 < 0) {
      direction = 'BUY';
    } else if (trendDirection < 0 && detail1 > 0) {
      direction = 'SELL';
    }

    const confidence = Math.min(1.0, (1.0 / (noise + 0.1)) * Math.abs(trendChange));

    return makeSignal(this.name, current, direction, confidence, { noise, detail1, trendChange });
  }
}
