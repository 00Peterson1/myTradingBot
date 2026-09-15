import { createLogger } from '../monitoring/Logger.js';
import { computeFeatures } from './computeFeatures.js';
import type { Tick, TickFeatures } from '../types/tick.js';

const log = createLogger('FeatureEngine');

/**
 * FeatureEngine
 *
 * Converts a stream of raw Ticks into TickFeatures.
 *
 * Responsibilities:
 *   - Maintain a rolling price buffer (ring buffer for memory efficiency)
 *   - Compute ALL features causally (only past data)
 *   - Emit TickFeatures events to downstream consumers
 *   - Never write to the database (that's the Repository's job)
 *
 * Design:
 *   - Stateful: holds rolling history
 *   - Deterministic: same input → same output
 *   - Single-symbol: one FeatureEngine per symbol
 *
 * The FeatureEngine is the ONLY place where raw ticks become features.
 * Strategies MUST NOT compute their own features.
 */
export class FeatureEngine {
  private readonly priceBuffer: number[] = [];
  private readonly maxBuffer: number;
  private tickCount = 0;
  private lastTimestamp = -Infinity;

  constructor(
    readonly symbol: string,
    maxBufferSize = 500,
  ) {
    if (!symbol || !Number.isInteger(maxBufferSize) || maxBufferSize < 1) throw new Error('Invalid feature engine configuration');
    this.maxBuffer = maxBufferSize;
    log.info({ symbol, maxBufferSize }, 'FeatureEngine initialized');
  }

  /**
   * Processes a single raw tick and returns enriched features.
   * This is the primary entry point — call for every new tick.
   *
   * @param tick - Raw tick from Deriv WebSocket
   * @returns TickFeatures with all computed indicators
   */
  process(tick: Tick): TickFeatures {
    const timestamp = tick.timestamp.getTime();
    if (tick.symbol !== this.symbol || !Number.isFinite(tick.price) || tick.price <= 0 ||
        !Number.isFinite(timestamp) || !Number.isFinite(tick.epoch) ||
        Math.abs(timestamp - tick.epoch * 1000) > 0.001 || timestamp < this.lastTimestamp) {
      throw new Error('Invalid or out-of-order feature tick');
    }
    this.lastTimestamp = timestamp;
    this.tickCount++;

    // Update rolling buffer BEFORE computing features (causal)
    this.priceBuffer.push(tick.price);
    if (this.priceBuffer.length > this.maxBuffer) {
      this.priceBuffer.shift();
    }

    const features = computeFeatures(tick, this.priceBuffer, this.tickCount);

    log.trace(
      {
        symbol: tick.symbol,
        price: tick.price,
        bufferSize: this.priceBuffer.length,
        hasMom20: features.mom20 !== null,
      },
      'Features computed',
    );

    return features;
  }

  /**
   * Returns the current price history (read-only copy).
   * Useful for strategy context windows.
   */
  getPriceHistory(): readonly number[] {
    return [...this.priceBuffer];
  }

  /**
   * Returns count of ticks processed so far.
   */
  getTickCount(): number {
    return this.tickCount;
  }

  /**
   * Resets the engine state (e.g., after a reconnect or symbol change).
   */
  reset(): void {
    this.priceBuffer.length = 0;
    this.tickCount = 0;
    this.lastTimestamp = -Infinity;
    log.info({ symbol: this.symbol }, 'FeatureEngine reset');
  }
}
