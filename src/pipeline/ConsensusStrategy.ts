import { VotingEngine, type VotingEngineConfig } from '../execution/VotingEngine.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import type { Signal } from '../types/signal.js';
import type { TickFeatures } from '../types/tick.js';

/** Supply a fresh suite through BacktestConfig.strategyFactory to evaluate the complete vote. */
export class ConsensusStrategy implements Strategy {
  readonly name = 'Consensus';
  readonly description = 'Configured strategy suite evaluated through the shared voting engine';
  readonly isOnlineLearner?: true;
  private readonly voting: VotingEngine;

  constructor(private readonly strategies: readonly Strategy[], config: Partial<VotingEngineConfig> = {}) {
    if (!strategies.length) throw new Error('Consensus requires a nonempty strategy suite');
    this.voting = new VotingEngine(config);
    if (strategies.some(strategy => strategy.isOnlineLearner)) this.isOnlineLearner = true;
  }

  generateSignal(current: TickFeatures, history: readonly TickFeatures[]): Signal {
    return this.voting.toSignal(current, this.strategies.map(strategy => strategy.generateSignal(current, history)));
  }
}
