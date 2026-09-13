/**
 * Over / Under Strategy for Deriv Synthetic Indices.
 *
 * Evaluates digit distributions over a rolling window and issues DIGITOVER or DIGITUNDER
 * signals with barrier selection (0..9).
 */

import type { Strategy } from '../base/Strategy.js';
import { makeSignal } from '../base/Strategy.js';
import { DigitAnalyzer } from '../../features/digit/DigitAnalyzer.js';
import type { TickFeatures } from '../../types/tick.js';
import type { Signal } from '../../types/signal.js';

export interface OverUnderConfig {
  windowSize?: number;
  barrier?: number;
  thresholdRatio?: number;
}

export class OverUnderStrategy implements Strategy {
  readonly name = 'digit-over-under';
  readonly description = 'Generates DIGITOVER or DIGITUNDER signals with target barrier.';
  private readonly analyzer: DigitAnalyzer;
  private readonly windowSize: number;
  private readonly barrier: number;
  private readonly thresholdRatio: number;

  constructor(config: OverUnderConfig = {}) {
    this.windowSize = config.windowSize ?? 30;
    this.barrier = config.barrier ?? 5;
    this.thresholdRatio = config.thresholdRatio ?? 0.60;
    this.analyzer = new DigitAnalyzer(this.windowSize);
  }

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    this.analyzer.push(current.price);
    const stats = this.analyzer.getStats();

    if (!stats || stats.sampleSize < 15) {
      return makeSignal(this.name, current, 'NONE', 0);
    }

    const overCount = stats.overCounts[this.barrier] ?? 0;
    const underCount = stats.underCounts[this.barrier] ?? 0;
    const sampleSize = stats.sampleSize;

    const overRatio = overCount / sampleSize;
    const underRatio = underCount / sampleSize;

    if (overRatio >= this.thresholdRatio) {
      return makeSignal(
        this.name,
        current,
        'BUY',
        overRatio,
        { contractType: 'DIGITOVER', barrier: this.barrier, digitStats: stats },
      );
    }

    if (underRatio >= this.thresholdRatio) {
      return makeSignal(
        this.name,
        current,
        'SELL',
        underRatio,
        { contractType: 'DIGITUNDER', barrier: this.barrier, digitStats: stats },
      );
    }

    return makeSignal(this.name, current, 'NONE', 0);
  }
}
