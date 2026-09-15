import { createHash } from 'node:crypto';
import { FeatureEngine } from '../features/FeatureEngine.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import { signalSchema, type Signal } from '../types/signal.js';
import type { Tick, TickFeatures } from '../types/tick.js';

export const DEFAULT_CONTEXT_WINDOW = 200;
export const DEFAULT_WARMUP_TICKS = 50;
export const DEFAULT_MAX_TICK_GAP_MS = 60_000;

/** Shared causal processing for raw replay and provider ticks. New stream means cold start. */
export class StrategyStream {
  private readonly features: FeatureEngine;
  private lastTimestamp: number | null = null;
  private blockedReason: string | null = null;
  private readonly history: TickFeatures[] = [];

  constructor(readonly symbol: string, private readonly strategies: readonly Strategy[],
    private readonly contextWindow = DEFAULT_CONTEXT_WINDOW,
    private readonly warmupTicks = DEFAULT_WARMUP_TICKS,
    private readonly maxTickGapMs = DEFAULT_MAX_TICK_GAP_MS) {
    if (!Number.isInteger(contextWindow) || contextWindow < 1) throw new Error('Invalid context window');
    if (!Number.isInteger(warmupTicks) || warmupTicks < 0) throw new Error('Invalid warm-up ticks');
    if (!Number.isFinite(maxTickGapMs) || maxTickGapMs <= 0) throw new Error('Invalid maximum tick gap');
    this.features = new FeatureEngine(symbol);
  }

  /** A reconnect cannot restore missed events or safely reset arbitrary strategy state. */
  suspend(reason: string): void { this.blockedReason = reason || 'Market stream interrupted'; }

  getBlockedReason(): string | null { return this.blockedReason; }

  process(tick: Tick): { features: TickFeatures; signals: Signal[] } {
    if (this.blockedReason) throw new Error(this.blockedReason);
    const current = this.features.process(tick);
    const timestamp = tick.timestamp.getTime();
    if (tick.symbol === this.symbol && this.lastTimestamp !== null && timestamp - this.lastTimestamp > this.maxTickGapMs) {
      this.suspend('Tick gap exceeds the configured policy; restart with fresh strategy state');
      throw new Error(this.blockedReason ?? 'Stream blocked');
    }
    this.lastTimestamp = timestamp;
    const signals = current.tickCount >= this.warmupTicks ? this.strategies.map((strategy, index): Signal => {
      const signal = strategy.generateSignal(current, [...this.history]);
      signalSchema.parse(signal);
      if (signal.symbol !== current.symbol || signal.timestamp.getTime() !== current.timestamp.getTime() || signal.price !== current.price) {
        throw new Error('Strategy signal does not match its market event');
      }
      // Event ordinal distinguishes repeated quotes without inventing a provider event ID.
      const id = createHash('sha256').update(JSON.stringify([
        this.symbol, current.tickCount, current.timestamp.toISOString(), current.price,
        index, signal.strategy, signal.strategyVersion, signal.hypothesisId,
      ])).digest('hex');
      return { ...signal, id };
    }) : [];
    this.history.push(current);
    if (this.history.length > this.contextWindow) this.history.shift();
    return { features: current, signals };
  }
}
