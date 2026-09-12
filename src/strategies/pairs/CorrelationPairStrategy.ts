import { makeSignal } from '../base/Strategy.js';
import type { Signal } from '../../types/signal.js';
import type { TickFeatures } from '../../types/tick.js';
import type { SpreadTracker } from './SpreadTracker.js';

export interface PairStrategyConfig {
  symbolA: string;
  symbolB: string;
  spreadWindow: number;
  cointegWindow: number;
  entryZScore: number;
  exitZScore: number;
  maxZScore: number;
}

export class CorrelationPairStrategy {
  readonly name: string;
  readonly description: string;
  readonly symbolA: string;
  readonly symbolB: string;

  constructor(private readonly config: PairStrategyConfig) {
    this.name = `Pair(${config.symbolA}/${config.symbolB})`;
    this.description = `Statistical arbitrage pairs trading between ${config.symbolA} and ${config.symbolB}`;
    this.symbolA = config.symbolA;
    this.symbolB = config.symbolB;
  }

  generatePairSignal(
    featuresA: TickFeatures,
    _featuresB: TickFeatures,
    tracker: SpreadTracker,
  ): Signal {
    const z = tracker.getCurrentZScore();
    const cointegP = tracker.state.cointegrationP;
    const betaHedge = tracker.state.betaHedgeRatio;

    if (z === null) {
      return makeSignal(this.name, featuresA, 'NONE', 0, { reason: 'insufficient_history' });
    }

    if (Math.abs(z) > this.config.maxZScore) {
      return makeSignal(this.name, featuresA, 'NONE', 0, {
        reason: 'SPREAD_EXPLOSION',
        spreadZ: z,
        cointegP,
        betaHedge,
        symbolB: this.symbolB,
        symbolA: this.symbolA
      });
    }

    if (cointegP > 0.1) {
      return makeSignal(this.name, featuresA, 'NONE', 0, {
        reason: 'COINTEGRATION_BROKEN',
        spreadZ: z,
        cointegP,
        betaHedge,
        symbolB: this.symbolB,
        symbolA: this.symbolA
      });
    }

    let direction: 'BUY' | 'SELL' | 'NONE' = 'NONE';
    let confidence = 0;

    if (z > this.config.entryZScore) {
      direction = 'SELL';
      confidence = Math.min(1.0, (z - this.config.entryZScore) / 1.5);
    } else if (z < -this.config.entryZScore) {
      direction = 'BUY';
      confidence = Math.min(1.0, (Math.abs(z) - this.config.entryZScore) / 1.5);
    } else if (Math.abs(z) < this.config.exitZScore) {
      direction = 'NONE';
    }

    return makeSignal(this.name, featuresA, direction, confidence, {
      spreadZ: z,
      cointegP,
      betaHedge,
      symbolB: this.symbolB,
      symbolA: this.symbolA
    });
  }
}
