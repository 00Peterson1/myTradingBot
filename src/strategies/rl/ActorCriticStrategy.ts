import { Strategy, makeSignal } from '../base/Strategy.js';
import type { TickFeatures } from '../../types/tick.js';
import type { Signal } from '../../types/signal.js';

export class ActorCriticStrategy implements Strategy {
  readonly name = 'ActorCritic';
  readonly description = 'Linear function approximation actor-critic';

  private readonly learningRate = 0.01;
  private readonly gamma = 0.95;

  private weightsActor = {
    BUY: new Array(6).fill(0),
    SELL: new Array(6).fill(0),
    HOLD: new Array(6).fill(0),
  };
  private weightsCritic = new Array(6).fill(0);

  private previousFeatureVec: number[] | null = null;
  private previousAction: 'BUY' | 'SELL' | 'HOLD' | null = null;

  private getFeatureVec(f: TickFeatures): number[] {
    const clamp = (val: number | null) => {
      if (val === null) return 0;
      return Math.max(-1, Math.min(1, val));
    };

    return [
      clamp(f.mom20 ? f.mom20 * 100 : 0),
      clamp(f.volAdjMom20),
      clamp(f.zScore20 ? f.zScore20 / 3 : 0),
      clamp(f.rsi14 ? (f.rsi14 - 50) / 50 : 0),
      clamp(f.macdHistogram),
      clamp(f.bollingerPct ? (f.bollingerPct - 0.5) * 2 : 0)
    ];
  }

  private dotProduct(a: number[], b: number[]): number {
    return a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
  }

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    const featureVec = this.getFeatureVec(current);
    const vState = this.dotProduct(this.weightsCritic, featureVec);

    if (this.previousFeatureVec && this.previousAction && current.logReturn1 !== null) {
      const reward = current.logReturn1 / Math.max(current.rollingStd20 ?? 1e-6, 1e-6);
      const delta = reward + this.gamma * vState - this.dotProduct(this.weightsCritic, this.previousFeatureVec);

      for (let i = 0; i < 6; i++) {
        this.weightsCritic[i] += this.learningRate * delta * (this.previousFeatureVec[i] ?? 0);
        this.weightsActor[this.previousAction][i] += this.learningRate * delta * (this.previousFeatureVec[i] ?? 0);
      }
    }

    const actions = ['BUY', 'SELL', 'HOLD'] as const;
    const scores = actions.map(a => this.dotProduct(this.weightsActor[a], featureVec));
    const maxScore = Math.max(...scores);
    const exps = scores.map(s => Math.exp(s - maxScore));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(e => e / sumExps);

    let rand = Math.random();
    let chosenIndex = 0;
    for (let i = 0; i < probs.length; i++) {
      rand -= (probs[i] ?? 0);
      if (rand <= 0) {
        chosenIndex = i;
        break;
      }
    }
    const chosenAction = actions[chosenIndex] as 'BUY' | 'SELL' | 'HOLD';
    const confidence = Math.max(...probs);

    this.previousFeatureVec = featureVec;
    this.previousAction = chosenAction;

    const direction = chosenAction === 'HOLD' ? 'NONE' : chosenAction;
    return makeSignal(this.name, current, direction, confidence, {
      probs: Object.fromEntries(actions.map((a, i) => [a, probs[i]]))
    });
  }
}
