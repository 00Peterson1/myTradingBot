import type { Signal } from '../../types/signal.js';
import type { TickFeatures } from '../../types/tick.js';

/**
 * Abstract contract that all strategies must implement.
 *
 * Design principles:
 *   - A strategy receives features and returns a Signal
 *   - It NEVER accesses the database, the Deriv API, or external state
 *   - It NEVER determines position size (that is the RiskEngine's job)
 *   - It NEVER places orders (that is the ExecutionEngine's job)
 *   - Parameters are injected at construction — not read from env at runtime
 *   - All logic must be causal (no future data)
 */
export interface Strategy {
  /** Unique name identifying this strategy + parameter set */
  readonly name: string;

  /** Human-readable description of the strategy logic */
  readonly description: string;

  /**
   * Generates a signal from the current tick features and recent feature history.
   *
   * @param current - Features computed for the current tick
   * @param history - Recent feature history (oldest first), NOT including current
   * @returns A Signal with direction BUY | SELL | NONE
   */
  generateSignal(current: TickFeatures, history: readonly TickFeatures[]): Signal;
}

/**
 * Base utility for creating signals.
 */
export function makeSignal(
  strategyName: string,
  current: TickFeatures,
  direction: Signal['direction'],
  confidence: number,
  metadata: Record<string, unknown> = {},
): Signal {
  return {
    id: crypto.randomUUID(),
    timestamp: current.timestamp,
    symbol: current.symbol,
    price: current.price,
    direction,
    strategy: strategyName,
    confidence: Math.max(0, Math.min(1, confidence)),
    metadata,
  };
}
