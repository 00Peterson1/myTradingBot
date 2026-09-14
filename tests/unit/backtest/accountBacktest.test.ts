import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BacktestEngine } from '../../../src/backtest/BacktestEngine.js';
import { FeatureEngine } from '../../../src/features/FeatureEngine.js';
import { makeSignal, type Strategy } from '../../../src/strategies/base/Strategy.js';
import { resetEnvForTesting } from '../../../src/config/env.js';
import type { TickFeatures } from '../../../src/types/tick.js';

function strategy(): Strategy {
  return { name: 'always-rise', description: 'test', generateSignal: (current): ReturnType<typeof makeSignal> => makeSignal('always-rise', current, 'BUY', 1) };
}
function rows(): TickFeatures[] {
  const features = new FeatureEngine('TEST');
  return Array.from({ length: 30 }, (_, i) => features.process({ symbol: 'TEST', price: 100 + i, epoch: i, timestamp: new Date(i * 1000) }));
}
function engine(factory = strategy, maxTradesPerHour = 100): BacktestEngine {
  return new BacktestEngine({ strategyFactory: factory, strategyName: 'always-rise', symbol: 'TEST',
    payoutMultiplier: 0.85, feePerTrade: 0, minConfidence: 0.5, contextWindow: 2,
    initialCapital: 1000, contractDuration: 2, maxOpenTrades: 1, maxTradesPerHour, entryDelayTicks: 1 });
}
function run(backtest: BacktestEngine): ReturnType<BacktestEngine['run']> {
  return backtest.run(rows(), new Date(0), new Date(9000), new Date(10000), new Date(19000), new Date(20000), new Date(29000));
}
beforeEach(() => {
  vi.stubEnv('STAKE_AMOUNT', '1');
  resetEnvForTesting();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvForTesting(); });
describe('backtest account and period integration', () => {
  it('delays entry and observes maximum open positions until settlement', async () => {
    const result = await run(engine());
    expect(result.trainMetrics.totalTrades).toBe(4);
    expect(result.validateMetrics.totalTrades).toBe(4);
    expect(result.testMetrics.totalTrades).toBe(4);
    expect(result.observations[0]).toMatchObject({ timestamp: new Date(1000), entryPrice: 101, exitPrice: 103, stake: 1, profit: 0.85 });
  });
  it('applies the durable hourly purchase limit using historical time', async () => {
    const result = await run(engine(strategy, 1));
    expect(result.trainMetrics.totalTrades).toBe(1);
    expect(result.validateMetrics.totalTrades).toBe(1);
    expect(result.testMetrics.totalTrades).toBe(1);
  });
  it('rejects reused strategy state and overlapping evaluation periods', async () => {
    const shared = strategy();
    await expect(run(engine(() => shared))).rejects.toThrow('fresh instance');
    await expect(engine().run(rows(), new Date(0), new Date(10000), new Date(10000), new Date(19000), new Date(20000), new Date(29000))).rejects.toThrow('disjoint');
  });
});
