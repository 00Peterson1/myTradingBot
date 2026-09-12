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

  // -------------------------------------------------------------------------
  // Technical Analysis Indicators
  // -------------------------------------------------------------------------

  /** Relative Strength Index (14-period) — 0–100, >70 overbought, <30 oversold */
  readonly rsi14: number | null;

  /** MACD line (ema12 − ema26) */
  readonly macdLine: number | null;
  /** MACD signal line (9-period EMA of MACD line) */
  readonly macdSignal: number | null;
  /** MACD histogram (macdLine − macdSignal) */
  readonly macdHistogram: number | null;

  /** Bollinger Band upper (mean20 + 2×std20) */
  readonly bollingerUpper: number | null;
  /** Bollinger Band lower (mean20 − 2×std20) */
  readonly bollingerLower: number | null;
  /** Bollinger %B — position within bands: 0=lower, 0.5=middle, 1=upper */
  readonly bollingerPct: number | null;
  /** Bollinger Band width as fraction of midline price */
  readonly bollingerWidth: number | null;

  /** Average True Range (14-period) — measures volatility */
  readonly atr14: number | null;

  /** Average Directional Index (14-period) — 0–100 trend strength */
  readonly adx14: number | null;
  /** Plus Directional Indicator +DI */
  readonly diPlus14: number | null;
  /** Minus Directional Indicator −DI */
  readonly diMinus14: number | null;

  /** Stochastic %K (14-period) — 0–100 */
  readonly stochasticK: number | null;
  /** Stochastic %D (3-period SMA of %K) */
  readonly stochasticD: number | null;

  /** Commodity Channel Index (20-period) */
  readonly cci20: number | null;

  /** Williams %R (14-period) — −100 to 0 */
  readonly williamsR14: number | null;

  /** Ichimoku Tenkan-sen (9-period mid) */
  readonly ichimokuTenkan: number | null;
  /** Ichimoku Kijun-sen (26-period mid) */
  readonly ichimokuKijun: number | null;
  /** Ichimoku Senkou Span A ((tenkan+kijun)/2, projected 26 forward) */
  readonly ichimokuSenkouA: number | null;
  /** Ichimoku Senkou Span B (52-period mid, projected 26 forward) */
  readonly ichimokuSenkouB: number | null;

  // -------------------------------------------------------------------------
  // Wavelet Features (Haar DWT decomposition)
  // -------------------------------------------------------------------------

  /** Level-1 detail coefficient — high-frequency noise */
  readonly waveletDetail1: number | null;
  /** Level-2 detail coefficient — medium-frequency component */
  readonly waveletDetail2: number | null;
  /** Level-2 approximation coefficient — underlying trend */
  readonly waveletTrend: number | null;
  /** Noise-to-signal ratio (|detail1| / |trend|) — low = trade, high = noisy */
  readonly waveletNoiseRatio: number | null;

  // -------------------------------------------------------------------------
  // EWMS Features (Exponential Weighted Moving Statistics — LSTM approximation)
  // -------------------------------------------------------------------------

  /** Fast EWMS (α=0.2) — reacts quickly to price changes */
  readonly ewmsFast: number | null;
  /** Slow EWMS (α=0.05) — long-memory trend estimate */
  readonly ewmsSlow: number | null;
  /** EWMS momentum signal: (ewmsFast − ewmsSlow) / σ_price */
  readonly ewmsMomentum: number | null;
  /** EWMS acceleration: change in ewmsMomentum from prior tick */
  readonly ewmsAcceleration: number | null;
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
