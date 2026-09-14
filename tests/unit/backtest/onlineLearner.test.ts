import type { Strategy } from '../../../src/strategies/base/Strategy.js';
import { describe, it, expect, vi } from 'vitest';
import { BacktestEngine } from '../../../src/backtest/BacktestEngine.js';
import { FeatureEngine } from '../../../src/features/FeatureEngine.js';

describe('standard backtest isolation', () => {
  it('rejects declared online learners before scoring or updating them', async () => {
    const generateSignal = vi.fn(() => { throw new Error('must not learn'); });
    const engine = new BacktestEngine({
      strategyFactory: (): Strategy => ({ name: 'learner', description: 'test', isOnlineLearner: true, generateSignal }),
      strategyName: 'learner', symbol: 'TEST', payoutMultiplier: 0.85,
      feePerTrade: 0, minConfidence: 0, contextWindow: 20,
    });
    const features = new FeatureEngine('TEST');
    const rows = [1, 2, 3, 4, 5, 6].map(epoch => features.process({ symbol: 'TEST', price: 100 + epoch, epoch, timestamp: new Date(epoch * 1000) }));
    await expect(engine.run(rows, new Date(1000), new Date(2000), new Date(3000), new Date(4000), new Date(5000), new Date(6000))).rejects.toThrow('Online learners');
    expect(generateSignal).not.toHaveBeenCalled();
  });
});
