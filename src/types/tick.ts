/**
 * Core tick type — the fundamental unit of market data.
 * Every price observation from Deriv is stored as a Tick.
 */
export interface Tick {
  readonly id?: bigint;
  readonly symbol: string;
  readonly epoch: number; // Unix timestamp seconds (from Deriv)
  readonly timestamp: Date; // Derived JS Date
  readonly price: number;
  readonly tickId?: number; // Deriv-provided tick ID if available
}

/**
 * Feature-enriched tick produced by the FeatureEngine.
 *
 * All features are CAUSAL — computed using only data up to and including
 * the current tick. No future data is ever used.
 *
 * null = insufficient history for that feature at the current tick.
 */
export interface TickFeatures {
  // Identity
  readonly timestamp: Date;
  readonly symbol: string;
  readonly price: number;
  readonly tickCount: number; // Total ticks processed by this FeatureEngine instance

  // Returns
  readonly logReturn1: number | null; // ln(P_t / P_{t-1})
  readonly simpleReturn1: number | null; // (P_t - P_{t-1}) / P_{t-1}

  // Momentum at multiple horizons (log return over k periods)
  readonly mom5: number | null;
  readonly mom10: number | null;
  readonly mom20: number | null;
  readonly mom50: number | null;
  readonly mom100: number | null;

  // Rolling statistics
  readonly rollingMean20: number | null;
  readonly rollingMean50: number | null;
  readonly rollingStd20: number | null;
  readonly rollingStd50: number | null;

  // Realized volatility (RMS of log returns)
  readonly realizedVol20: number | null;
  readonly realizedVol50: number | null;

  // Z-scores (price deviation from mean in units of std)
  readonly zScore20: number | null;
  readonly zScore50: number | null;

  // Volatility-adjusted momentum (momentum / realized vol)
  readonly volAdjMom20: number | null;
  readonly volAdjMom50: number | null;

  // Rolling high/low (breakout detection)
  readonly rollingHigh20: number | null;
  readonly rollingHigh50: number | null;
  readonly rollingLow20: number | null;
  readonly rollingLow50: number | null;

  // Drawdown from rolling high (negative = below high)
  readonly drawdownPct20: number | null;
  readonly drawdownPct50: number | null;

  // Autocorrelation of log returns, lag 1 (range [-1, 1])
  readonly ac1_20: number | null; // Estimated from 20-period window
  readonly ac1_50: number | null; // Estimated from 50-period window

  // Exponential moving averages
  readonly ema20: number | null;
  readonly ema50: number | null;
  readonly emaCrossover: number | null; // +1 = ema20>ema50, -1 = ema20<ema50, 0 = equal
}

/**
 * Raw tick as received from Deriv WebSocket.
 * Not yet validated or stored.
 */
export interface RawTick {
  readonly symbol: string;
  readonly epoch: number;
  readonly quote: number;
  readonly id?: number;
  readonly pip_size?: number;
}
