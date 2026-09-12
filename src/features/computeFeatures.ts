import {
  logReturn,
  simpleReturn,
  momentum,
  rollingMean,
  rollingStd,
  realizedVolatility,
  zScore,
  rollingHigh,
  rollingLow,
  drawdownFromHigh,
  autocorrelation,
  ema,
} from './indicators/indicators.js';
import { rsi, macd, bollingerBands, atr, adx, stochastic, cci, williamsR, ichimoku } from './technicals/TechnicalIndicators.js';
import { haarDWT } from './WaveletFeatures.js';
import { ewms } from './EWMSFeatures.js';
import type { Tick, TickFeatures } from '../types/tick.js';

/**
 * computeFeatures — Pure function.
 *
 * Given a raw tick and the current price buffer (including current tick
 * at the last position), computes ALL TickFeatures.
 *
 * CAUSAL CONTRACT:
 *   - priceBuffer[priceBuffer.length - 1] === tick.price (current tick)
 *   - All indicators use indices 0..n-1 (current = n-1, no future data)
 *   - This function NEVER reads from a database or WebSocket
 *   - This function is PURE: no side effects
 */
export function computeFeatures(
  tick: Tick,
  priceBuffer: readonly number[],
  tickCount: number,
): TickFeatures {
  const prices = priceBuffer as number[];
  const n = prices.length - 1; // Index of current tick in buffer

  // ---------------------------------------------------------------------------
  // Returns
  // ---------------------------------------------------------------------------
  const logRet1 = logReturn(prices, n);
  const simRet1 = simpleReturn(prices, n);

  // Log return array for volatility/autocorrelation calculations
  const logReturns: (number | null)[] = prices.map((_, i) => logReturn(prices, i));

  // ---------------------------------------------------------------------------
  // Momentum (log returns over k periods)
  // ---------------------------------------------------------------------------
  const mom5 = momentum(prices, n, 5);
  const mom10 = momentum(prices, n, 10);
  const mom20 = momentum(prices, n, 20);
  const mom50 = momentum(prices, n, 50);
  const mom100 = momentum(prices, n, 100);

  // ---------------------------------------------------------------------------
  // Rolling statistics
  // ---------------------------------------------------------------------------
  const rollingMean20 = rollingMean(prices, n, 20);
  const rollingMean50 = rollingMean(prices, n, 50);
  const rollingStd20 = rollingStd(prices, n, 20);
  const rollingStd50 = rollingStd(prices, n, 50);

  // ---------------------------------------------------------------------------
  // Realized volatility (of log returns)
  // ---------------------------------------------------------------------------
  const realizedVol20 = realizedVolatility(logReturns, n, 20);
  const realizedVol50 = realizedVolatility(logReturns, n, 50);

  // ---------------------------------------------------------------------------
  // Z-scores (price deviation from rolling mean, normalized by std)
  // ---------------------------------------------------------------------------
  const zScore20 = zScore(prices, n, 20);
  const zScore50 = zScore(prices, n, 50);

  // ---------------------------------------------------------------------------
  // Volatility-adjusted momentum (Z-score of momentum)
  // ---------------------------------------------------------------------------
  let volAdjMom20: number | null = null;
  if (mom20 !== null && realizedVol20 !== null && realizedVol20 > 0) {
    volAdjMom20 = mom20 / realizedVol20;
  }

  let volAdjMom50: number | null = null;
  if (mom50 !== null && realizedVol50 !== null && realizedVol50 > 0) {
    volAdjMom50 = mom50 / realizedVol50;
  }

  // ---------------------------------------------------------------------------
  // Rolling high/low and drawdown
  // ---------------------------------------------------------------------------
  const rollingHigh20 = rollingHigh(prices, n, 20);
  const rollingHigh50 = rollingHigh(prices, n, 50);
  const rollingLow20 = rollingLow(prices, n, 20);
  const rollingLow50 = rollingLow(prices, n, 50);
  const drawdownPct20 = drawdownFromHigh(prices, n, 20);
  const drawdownPct50 = drawdownFromHigh(prices, n, 50);

  // ---------------------------------------------------------------------------
  // Autocorrelation (lag-1) of log returns
  // ---------------------------------------------------------------------------
  const ac1_20 = autocorrelation(logReturns, n, 20, 1);
  const ac1_50 = autocorrelation(logReturns, n, 50, 1);

  // ---------------------------------------------------------------------------
  // Exponential Moving Averages
  // ---------------------------------------------------------------------------
  const ema20 = ema(prices, n, 20);
  const ema50 = ema(prices, n, 50);

  // EMA crossover signal: +1 if ema20 > ema50, -1 if ema20 < ema50, 0 otherwise
  let emaCrossover: number | null = null;
  if (ema20 !== null && ema50 !== null) {
    emaCrossover = ema20 > ema50 ? 1 : ema20 < ema50 ? -1 : 0;
  }

  // ---------------------------------------------------------------------------
  // Technical Indicators
  // ---------------------------------------------------------------------------
  const rsi14 = rsi(prices, n, 14);
  const { line: macdLine, signal: macdSignal, histogram: macdHistogram } = macd(prices, n);
  const { upper: bollingerUpper, lower: bollingerLower, pct: bollingerPct, width: bollingerWidth } = bollingerBands(prices, n, 20, 2);
  const atr14 = atr(prices, n, 14);
  const { adx: adx14, diPlus: diPlus14, diMinus: diMinus14 } = adx(prices, n, 14);
  const { k: stochasticK, d: stochasticD } = stochastic(prices, n, 14, 3);
  const cci20 = cci(prices, n, 20);
  const williamsR14 = williamsR(prices, n, 14);
  const { tenkan: ichimokuTenkan, kijun: ichimokuKijun, senkouA: ichimokuSenkouA, senkouB: ichimokuSenkouB } = ichimoku(prices, n);

  // ---------------------------------------------------------------------------
  // Wavelet Features
  // ---------------------------------------------------------------------------
  const { detail1: waveletDetail1, detail2: waveletDetail2, trend: waveletTrend, noiseRatio: waveletNoiseRatio } = haarDWT(prices, n, 2);

  // ---------------------------------------------------------------------------
  // EWMS Features
  // ---------------------------------------------------------------------------
  const { fast: ewmsFast, slow: ewmsSlow, momentum: ewmsMomentum, acceleration: ewmsAcceleration } = ewms(prices, n);

  return {
    // Identity
    timestamp: tick.timestamp,
    symbol: tick.symbol,
    price: tick.price,
    tickCount,

    // Returns
    logReturn1: logRet1,
    simpleReturn1: simRet1,

    // Momentum
    mom5,
    mom10,
    mom20,
    mom50,
    mom100,

    // Rolling stats
    rollingMean20,
    rollingMean50,
    rollingStd20,
    rollingStd50,

    // Volatility
    realizedVol20,
    realizedVol50,

    // Z-scores
    zScore20,
    zScore50,

    // Volatility-adjusted momentum
    volAdjMom20,
    volAdjMom50,

    // Range
    rollingHigh20,
    rollingHigh50,
    rollingLow20,
    rollingLow50,
    drawdownPct20,
    drawdownPct50,

    // Autocorrelation
    ac1_20,
    ac1_50,

    // EMAs
    ema20,
    ema50,
    emaCrossover,

    // New Technicals
    rsi14, macdLine, macdSignal, macdHistogram,
    bollingerUpper, bollingerLower, bollingerPct, bollingerWidth,
    atr14, adx14, diPlus14, diMinus14,
    stochasticK, stochasticD, cci20, williamsR14,
    ichimokuTenkan, ichimokuKijun, ichimokuSenkouA, ichimokuSenkouB,

    // Wavelets
    waveletDetail1, waveletDetail2, waveletTrend, waveletNoiseRatio,

    // EWMS
    ewmsFast, ewmsSlow, ewmsMomentum, ewmsAcceleration
  };
}
