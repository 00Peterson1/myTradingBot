import { describe, expect, it } from 'vitest';
import { StrategyStream } from '../../../src/pipeline/StrategyStream.js';
import { MomentumStrategy } from '../../../src/strategies/momentum/MomentumStrategy.js';
import { makeSignal, type Strategy } from '../../../src/strategies/base/Strategy.js';
import { FeatureEngine } from '../../../src/features/FeatureEngine.js';
import { BacktestEngine } from '../../../src/backtest/BacktestEngine.js';
import type { Tick, TickFeatures } from '../../../src/types/tick.js';

function ticks(count = 260): Tick[] {
  return Array.from({ length: count }, (_, i) => ({ symbol: 'TEST', epoch: i,
    timestamp: new Date(i * 1000), price: 100 + Math.sin(i / 10) + i / 100 }));
}
function momentum(): MomentumStrategy {
  return new MomentumStrategy({ lookback: 20, threshold: 0.001, momentumKey: 'mom20' });
}
describe('shared strategy event processing', () => {
  it('produces identical features and signal IDs for batch replay and incremental delivery', () => {
    const replay = new StrategyStream('TEST', [momentum()]);
    const streamed = new StrategyStream('TEST', [momentum()]);
    const events = ticks();
    const expected = events.map(event => replay.process(event));
    const actual: ReturnType<StrategyStream['process']>[] = [];
    for (const event of events) actual.push(streamed.process(event));
    expect(actual).toEqual(expected);
    expect(actual.slice(0, 49).every(result => result.signals.length === 0)).toBe(true);
    expect(actual[49]?.signals).toHaveLength(1);
  });
  it('passes exactly the preceding context and distinguishes equal-time event ordinals', () => {
    const contexts: number[][] = [];
    const strategy: Strategy = { name: 'context', description: 'test',
      generateSignal: (current, history): ReturnType<typeof makeSignal> => {
        contexts.push(history.map(item => item.price));
        return makeSignal('context', current, 'NONE', 0);
      } };
    const stream = new StrategyStream('TEST', [strategy], 2, 0);
    const outputs = [1, 2, 3, 4].map(price => stream.process({ symbol: 'TEST', epoch: 0, timestamp: new Date(0), price }));
    expect(contexts).toEqual([[], [1], [1, 2], [2, 3]]);
    expect(new Set(outputs.map(output => output.signals[0]?.id)).size).toBe(4);
  });
  it('rejects invalid events before changing feature state', () => {
    const engine = new FeatureEngine('TEST');
    engine.process({ symbol: 'TEST', epoch: 2, timestamp: new Date(2000), price: 100 });
    for (const event of [
      { symbol: 'WRONG', epoch: 3, timestamp: new Date(3000), price: 100 },
      { symbol: 'TEST', epoch: 1, timestamp: new Date(1000), price: 100 },
      { symbol: 'TEST', epoch: 3, timestamp: new Date(3000), price: NaN },
      { symbol: 'TEST', epoch: 3, timestamp: new Date(4000), price: 100 },
    ]) expect(() => engine.process(event)).toThrow();
    expect(engine.getTickCount()).toBe(1);
    expect(engine.getPriceHistory()).toEqual([100]);
    engine.reset();
    expect(engine.process({ symbol: 'TEST', epoch: 0, timestamp: new Date(0), price: 99 }).tickCount).toBe(1);
  });
  it('feeds backtest strategies the same cold-start features/history as raw delivery in each period', async () => {
    const events = ticks(180);
    const observed: { current: TickFeatures; history: readonly TickFeatures[] }[] = [];
    const factory = (): Strategy => ({ name: 'capture', description: 'test',
      generateSignal: (current, history): ReturnType<typeof makeSignal> => {
        observed.push({ current, history });
        return makeSignal('capture', current, 'NONE', 0);
      } });
    const fullFeatures = new FeatureEngine('TEST');
    // Deliberately corrupt supplied indicator values; the backtest must recompute them.
    const rows = events.map(event => ({ ...fullFeatures.process(event), mom20: 999 }));
    const backtest = new BacktestEngine({ strategyFactory: factory, strategyName: 'capture', symbol: 'TEST',
      payoutMultiplier: 0.85, feePerTrade: 0, minConfidence: 0.5, contextWindow: 200 });
    await backtest.run(rows, new Date(0), new Date(59000), new Date(60000), new Date(119000), new Date(120000), new Date(179000));
    const expected = [...observed];
    observed.length = 0;
    for (let period = 0; period < 3; period++) {
      const stream = new StrategyStream('TEST', [factory()]);
      events.slice(period * 60, (period + 1) * 60).forEach(event => { stream.process(event); });
    }
    expect(observed).toEqual(expected);
    expect(observed).toHaveLength(33);
  });
});


describe('market-stream continuity policy', () => {
  it('halts after a disconnect and requires a fresh stream to warm up again', () => {
    const stream = new StrategyStream('TEST', [momentum()], 200, 2);
    const events = ticks(3);
    events.forEach(event => { stream.process(event); });
    stream.suspend('disconnect fixture');
    expect(() => stream.process({ symbol: 'TEST', epoch: 3, timestamp: new Date(3000), price: 101 })).toThrow('disconnect fixture');
    const fresh = new StrategyStream('TEST', [momentum()], 200, 2);
    expect(fresh.process({ symbol: 'TEST', epoch: 3, timestamp: new Date(3000), price: 101 }).signals).toEqual([]);
  });
  it('accepts the exact gap boundary and permanently blocks larger gaps', () => {
    const stream = new StrategyStream('TEST', [momentum()], 200, 0, 2000);
    stream.process({ symbol: 'TEST', epoch: 0, timestamp: new Date(0), price: 100 });
    stream.process({ symbol: 'TEST', epoch: 2, timestamp: new Date(2000), price: 101 });
    expect(() => stream.process({ symbol: 'TEST', epoch: 5, timestamp: new Date(5000), price: 102 })).toThrow('Tick gap');
    expect(stream.getBlockedReason()).toContain('Tick gap');
    expect(() => stream.process({ symbol: 'TEST', epoch: 6, timestamp: new Date(6000), price: 103 })).toThrow('Tick gap');
  });
  it('isolates interleaved symbols and their interruption state', () => {
    const first = new StrategyStream('TEST', [momentum()], 200, 0);
    const second = new StrategyStream('OTHER', [momentum()], 200, 0);
    const reference = new StrategyStream('OTHER', [momentum()], 200, 0);
    for (const event of ticks(20)) {
      first.process(event);
      expect(second.process({ ...event, symbol: 'OTHER' })).toEqual(reference.process({ ...event, symbol: 'OTHER' }));
    }
    first.suspend('TEST interrupted');
    expect(second.getBlockedReason()).toBeNull();
    expect(second.process({ symbol: 'OTHER', epoch: 20, timestamp: new Date(20000), price: 101 }).signals).toHaveLength(1);
  });
});
