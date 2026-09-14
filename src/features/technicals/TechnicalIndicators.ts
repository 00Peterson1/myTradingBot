import { assertDefined } from '../../utils/assertDefined.js';
import { ema, rollingMean, rollingStd, rollingHigh, rollingLow } from '../indicators/indicators.js';

export function rsi(prices: readonly number[], n: number, period = 14): number | null {
  if (n < period || n >= prices.length) return null;

  let sumGain = 0;
  let sumLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = assertDefined(prices[i]) - assertDefined(prices[i - 1]);
    if (diff > 0) sumGain += diff;
    else sumLoss -= diff;
  }

  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  for (let i = period + 1; i <= n; i++) {
    const diff = assertDefined(prices[i]) - assertDefined(prices[i - 1]);
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export { ema };

export function macd(prices: readonly number[], n: number): { line: number | null, signal: number | null, histogram: number | null } {
  if (n < 25) return { line: null, signal: null, histogram: null };

  const lineArr: number[] = [];
  for (let i = 25; i <= n; i++) {
    const e12 = ema(prices, i, 12);
    const e26 = ema(prices, i, 26);
    if (e12 !== null && e26 !== null) {
      lineArr.push(e12 - e26);
    }
  }

  if (lineArr.length === 0) return { line: null, signal: null, histogram: null };
  const line = lineArr[lineArr.length - 1] ?? null;

  if (lineArr.length < 9) return { line, signal: null, histogram: null };

  let signalEma = 0;
  for (let i = 0; i < 9; i++) {
    signalEma += assertDefined(lineArr[i]);
  }
  signalEma /= 9;

  const alpha = 2 / 10;
  for (let i = 9; i < lineArr.length; i++) {
    signalEma = alpha * assertDefined(lineArr[i]) + (1 - alpha) * signalEma;
  }

  return {
    line,
    signal: signalEma,
    histogram: line !== null ? line - signalEma : null
  };
}

export function bollingerBands(prices: readonly number[], n: number, period = 20, stdDev = 2): { upper: number | null, lower: number | null, pct: number | null, width: number | null } {
  const mean = rollingMean(prices, n, period);
  const std = rollingStd(prices, n, period);
  if (mean === null || std === null) return { upper: null, lower: null, pct: null, width: null };

  const upper = mean + stdDev * std;
  const lower = mean - stdDev * std;
  const p = prices[n];
  const pct = upper === lower || p === undefined ? null : (p - lower) / (upper - lower);
  const width = mean === 0 ? null : (upper - lower) / mean;

  return { upper, lower, pct, width };
}

function rma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const res: number[] = [];
  let current = 0;
  for (let i = 0; i < period; i++) current += assertDefined(values[i]);
  current /= period;
  res.push(current);
  
  const alpha = 1 / period;
  for (let i = period; i < values.length; i++) {
    current = alpha * assertDefined(values[i]) + (1 - alpha) * current;
    res.push(current);
  }
  return res;
}

export function atr(prices: readonly number[], n: number, period = 14): number | null {
  if (n < period) return null;
  const trs: number[] = [];
  for (let i = 1; i <= n; i++) {
    trs.push(Math.abs(assertDefined(prices[i]) - assertDefined(prices[i - 1])));
  }
  const smoothed = rma(trs, period);
  if (smoothed.length === 0) return null;
  return smoothed[smoothed.length - 1] ?? null;
}

export function adx(prices: readonly number[], n: number, period = 14): { adx: number | null, diPlus: number | null, diMinus: number | null } {
  if (n < period * 2) return { adx: null, diPlus: null, diMinus: null };
  
  const trs: number[] = [];
  const upMoves: number[] = [];
  const downMoves: number[] = [];
  
  for (let i = 1; i <= n; i++) {
    const diff = assertDefined(prices[i]) - assertDefined(prices[i - 1]);
    trs.push(Math.abs(diff));
    upMoves.push(diff > 0 ? diff : 0);
    downMoves.push(diff < 0 ? -diff : 0);
  }
  
  const smoothedTr = rma(trs, period);
  const smoothedUp = rma(upMoves, period);
  const smoothedDown = rma(downMoves, period);
  
  if (smoothedTr.length === 0) return { adx: null, diPlus: null, diMinus: null };
  
  const dxs: number[] = [];
  let diPlus = null;
  let diMinus = null;
  
  for (let i = 0; i < smoothedTr.length; i++) {
    const tr = assertDefined(smoothedTr[i]);
    const up = assertDefined(smoothedUp[i]);
    const down = assertDefined(smoothedDown[i]);
    
    if (tr === 0) {
      dxs.push(0);
      if (i === smoothedTr.length - 1) {
        diPlus = 0;
        diMinus = 0;
      }
    } else {
      const p = 100 * up / tr;
      const m = 100 * down / tr;
      const dx = (p + m === 0) ? 0 : 100 * Math.abs(p - m) / (p + m);
      dxs.push(dx);
      if (i === smoothedTr.length - 1) {
        diPlus = p;
        diMinus = m;
      }
    }
  }
  
  const adxArr = rma(dxs, period);
  if (adxArr.length === 0) return { adx: null, diPlus, diMinus };
  
  return { adx: adxArr[adxArr.length - 1] ?? null, diPlus, diMinus };
}

export function stochastic(prices: readonly number[], n: number, kPeriod = 14, dPeriod = 3): { k: number | null, d: number | null } {
  if (n < kPeriod - 1) return { k: null, d: null };
  
  const kArr: number[] = [];
  for (let i = kPeriod - 1; i <= n; i++) {
    const slice = prices.slice(i - kPeriod + 1, i + 1);
    const low = Math.min(...slice);
    const high = Math.max(...slice);
    if (high === low) {
      kArr.push(50);
    } else {
      kArr.push((assertDefined(prices[i]) - low) / (high - low) * 100);
    }
  }
  
  const k = kArr[kArr.length - 1] ?? null;
  if (kArr.length < dPeriod) return { k, d: null };
  
  let dSum = 0;
  for (let i = kArr.length - dPeriod; i < kArr.length; i++) {
    dSum += assertDefined(kArr[i]);
  }
  
  return { k, d: dSum / dPeriod };
}

export function cci(prices: readonly number[], n: number, period = 20): number | null {
  const sma = rollingMean(prices, n, period);
  if (sma === null) return null;
  
  let madSum = 0;
  for (let i = n - period + 1; i <= n; i++) {
    madSum += Math.abs(assertDefined(prices[i]) - sma);
  }
  const mad = madSum / period;
  if (mad === 0) return 0;
  
  return (assertDefined(prices[n]) - sma) / (0.015 * mad);
}

export function williamsR(prices: readonly number[], n: number, period = 14): number | null {
  const high = rollingHigh(prices, n, period);
  const low = rollingLow(prices, n, period);
  if (high === null || low === null || high === low) return null;
  
  return (high - assertDefined(prices[n])) / (high - low) * -100;
}

export function ichimoku(prices: readonly number[], n: number): { tenkan: number | null, kijun: number | null, senkouA: number | null, senkouB: number | null } {
  const high9 = rollingHigh(prices, n, 9);
  const low9 = rollingLow(prices, n, 9);
  const tenkan = (high9 !== null && low9 !== null) ? (high9 + low9) / 2 : null;
  
  const high26 = rollingHigh(prices, n, 26);
  const low26 = rollingLow(prices, n, 26);
  const kijun = (high26 !== null && low26 !== null) ? (high26 + low26) / 2 : null;
  
  const senkouA = (tenkan !== null && kijun !== null) ? (tenkan + kijun) / 2 : null;
  
  const high52 = rollingHigh(prices, n, 52);
  const low52 = rollingLow(prices, n, 52);
  const senkouB = (high52 !== null && low52 !== null) ? (high52 + low52) / 2 : null;
  
  return { tenkan, kijun, senkouA, senkouB };
}
