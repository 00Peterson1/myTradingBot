/**
 * Even / Odd Strategy for Deriv Synthetic Indices.
 *
 * Generates DIGITEVEN or DIGITODD signals when the rolling digit window shows a
 * statistically significant bias or mean-reversion tendency towards even or odd digits.
 */

import type { Strategy } from '../base/Strategy.js';
import { makeSignal } from '../base/Strategy.js';
import { DigitAnalyzer } from '../../features/digit/DigitAnalyzer.js';
import type { TickFeatures } from '../../types/tick.js';
import type { Signal } from '../../types/signal.js';

export interface EvenOddConfig {
  windowSize?: number; // Rolling window size (default 30 ticks)
  evenThreshold?: number; // Ratio threshold to trigger EVEN signal
  minConfidence?: number;
}

export class EvenOddStrategy implements Strategy {
  readonly name = 'digit-even-odd';
  readonly description = 'Generates DIGITEVEN or DIGITODD signals based on rolling digit parity imbalance.';
  private readonly analyzer: DigitAnalyzer;
  private readonly windowSize: number;
  private readonly evenThreshold: number;
  private readonly minConfidence: number;

  constructor(config: EvenOddConfig = {}) {
    this.windowSize = config.windowSize ?? 30;
    this.evenThreshold = config.evenThreshold ?? 0.65;
    this.minConfidence = config.minConfidence ?? 0.55;
    this.analyzer = new DigitAnalyzer(this.windowSize);
  }

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    this.analyzer.push(current.price);
    const stats = this.analyzer.getStats();

    if (!stats || stats.sampleSize < 15) {
      return makeSignal(this.name, current, 'NONE', 0);
    }

    const evenRatio = stats.evenRatio;

    if (evenRatio >= this.evenThreshold) {
      // High even ratio -> predict ODD mean-reversion
      const confidence = Math.min(0.95, evenRatio);
      if (confidence >= this.minConfidence) {
        return makeSignal(
          this.name,
          current,
          'SELL', // Map DIGITODD to SELL direction in unified signal pipeline
          confidence,
          { contractType: 'DIGITODD', digitStats: stats, note: `EvenRatio=${(evenRatio * 100).toFixed(1)}% -> DIGITODD` },
        );
      }
    } else if (evenRatio <= 1 - this.evenThreshold) {
      // Low even ratio -> predict EVEN mean-reversion
      const oddRatio = 1 - evenRatio;
      const confidence = Math.min(0.95, oddRatio);
      if (confidence >= this.minConfidence) {
        return makeSignal(
          this.name,
          current,
          'BUY', // Map DIGITEVEN to BUY direction in unified signal pipeline
          confidence,
          { contractType: 'DIGITEVEN', digitStats: stats, note: `OddRatio=${(oddRatio * 100).toFixed(1)}% -> DIGITEVEN` },
        );
      }
    }

    return makeSignal(this.name, current, 'NONE', 0);
  }
}
