/**
 * Matches / Differs Strategy for Deriv Synthetic Indices.
 *
 * Evaluates digit recurrence frequencies over a rolling window.
 * Differs contracts (`DIGITDIFF`) have a high baseline win probability (~90%)
 * when targeting digits that appear with low frequency in the current regime.
 */

import type { Strategy } from '../base/Strategy.js';
import { makeSignal } from '../base/Strategy.js';
import { DigitAnalyzer } from '../../features/digit/DigitAnalyzer.js';
import type { TickFeatures } from '../../types/tick.js';
import type { Signal } from '../../types/signal.js';

export interface MatchesDiffersConfig {
  windowSize?: number;
  mode?: 'DIFFERS' | 'MATCHES';
}

export class MatchesDiffersStrategy implements Strategy {
  readonly name = 'digit-matches-differs';
  readonly description = 'Generates DIGITDIFF or DIGITMATCH signals based on digit recurrence statistics.';
  private readonly analyzer: DigitAnalyzer;
  private readonly windowSize: number;
  private readonly mode: 'DIFFERS' | 'MATCHES';

  constructor(config: MatchesDiffersConfig = {}) {
    this.windowSize = config.windowSize ?? 40;
    this.mode = config.mode ?? 'DIFFERS';
    this.analyzer = new DigitAnalyzer(this.windowSize);
  }

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    this.analyzer.push(current.price);
    const stats = this.analyzer.getStats();

    if (!stats || stats.sampleSize < 20) {
      return makeSignal(this.name, current, 'NONE', 0);
    }

    const freqs = stats.digitFrequencies;

    if (this.mode === 'DIFFERS') {
      let minDigit = 0;
      let minFreq = freqs[0]!;
      for (let d = 1; d <= 9; d++) {
        if (freqs[d]! < minFreq) {
          minFreq = freqs[d]!;
          minDigit = d;
        }
      }

      if (minFreq <= 1) {
        const confidence = 0.90;
        return makeSignal(
          this.name,
          current,
          'BUY',
          confidence,
          { contractType: 'DIGITDIFF', barrier: minDigit, digitStats: stats },
        );
      }
    } else {
      let maxDigit = 0;
      let maxFreq = freqs[0]!;
      for (let d = 1; d <= 9; d++) {
        if (freqs[d]! > maxFreq) {
          maxFreq = freqs[d]!;
          maxDigit = d;
        }
      }

      const ratio = maxFreq / stats.sampleSize;
      if (ratio >= 0.25) {
        return makeSignal(
          this.name,
          current,
          'BUY',
          ratio,
          { contractType: 'DIGITMATCH', barrier: maxDigit, digitStats: stats },
        );
      }
    }

    return makeSignal(this.name, current, 'NONE', 0);
  }
}
