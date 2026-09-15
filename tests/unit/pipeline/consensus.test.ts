import { describe, expect, it } from 'vitest';
import { VotingEngine } from '../../../src/execution/VotingEngine.js';
import { ConsensusStrategy } from '../../../src/pipeline/ConsensusStrategy.js';
import { FeatureEngine } from '../../../src/features/FeatureEngine.js';
import { makeSignal, type Strategy } from '../../../src/strategies/base/Strategy.js';
const current = new FeatureEngine('TEST').process({ symbol: 'TEST', price: 100, epoch: 0, timestamp: new Date(0) });
const buy = makeSignal('buy', current, 'BUY', 0.8);
const sell = makeSignal('sell', current, 'SELL', 0.8);
describe('shared consensus boundary', () => {
  it('rejects stale events, invalid confidence and conflicting contract specifications', () => {
    const voting = new VotingEngine();
    for (const other of [
      { ...buy, confidence: NaN },
      { ...buy, timestamp: new Date(1000) },
      { ...buy, price: 101 },
      { ...buy, metadata: { contractType: 'DIGITEVEN' } },
    ]) expect(voting.vote('TEST', [buy, other]).hasConsensus).toBe(false);
    expect(() => voting.toSignal(current, [{ ...buy, timestamp: new Date(1000) }])).toThrow('current event');
  });
  it('preserves deterministic consensus identity, abstains on ties and validates config updates atomically', () => {
    const voting = new VotingEngine();
    expect(voting.toSignal(current, [buy])).toEqual(voting.toSignal(current, [buy]));
    expect(voting.toSignal(current, [buy, sell]).direction).toBe('NONE');
    expect(() => { voting.updateConfig({ minVoteFraction: NaN }); }).toThrow();
    expect(voting.getConfig().minVoteFraction).toBe(0.6);
  });
  it('evaluates a replay ensemble with the same contract and confidence as the runner vote', () => {
    const strategies: Strategy[] = [buy, buy, sell].map((signal, index) => ({ name: String(index), description: 'fixture', generateSignal: (): typeof signal => signal }));
    const ensemble = new ConsensusStrategy(strategies);
    expect(ensemble.generateSignal(current, [])).toEqual(new VotingEngine().toSignal(current, [buy, buy, sell]));
    expect(new ConsensusStrategy([{ ...strategies[0], name: 'learner', description: 'fixture', generateSignal: (): typeof buy => buy, isOnlineLearner: true }]).isOnlineLearner).toBe(true);
  });
});
