import { describe, it, expect } from 'vitest';
import { EvenOddStrategy } from '../../../src/strategies/digit/EvenOddStrategy.js';
import { OverUnderStrategy } from '../../../src/strategies/digit/OverUnderStrategy.js';
import { MatchesDiffersStrategy } from '../../../src/strategies/digit/MatchesDiffersStrategy.js';
import type { TickFeatures } from '../../../src/types/tick.js';

function mockTickFeatures(price: number): TickFeatures {
  return {
    timestamp: new Date(),
    symbol: '1HZ10V',
    price,
    tickCount: 1,
    logReturn1: 0,
    simpleReturn1: 0,
    mom5: 0,
    mom10: 0,
    mom20: 0,
    mom50: 0,
    mom100: 0,
    rollingMean20: price,
    rollingMean50: price,
    rollingStd20: 1,
    rollingStd50: 1,
    realizedVol20: 0.01,
    realizedVol50: 0.01,
    zScore20: 0,
    zScore50: 0,
    volAdjMom20: 0,
    volAdjMom50: 0,
    rollingHigh20: price + 1,
    rollingHigh50: price + 1,
    rollingLow20: price - 1,
    rollingLow50: price - 1,
    drawdownPct20: 0,
    drawdownPct50: 0,
    ac1_20: 0,
    ac1_50: 0,
    ema20: price,
    ema50: price,
    emaCrossover: 0,
    rsi14: 50,
    macdLine: 0,
    macdSignal: 0,
    macdHistogram: 0,
    bollingerUpper: price + 2,
    bollingerLower: price - 2,
    bollingerPct: 0.5,
    bollingerWidth: 0.04,
    atr14: 1,
    adx14: 20,
    diPlus14: 10,
    diMinus14: 10,
    stochasticK: 50,
    stochasticD: 50,
    cci20: 0,
    williamsR14: -50,
    ichimokuTenkan: price,
    ichimokuKijun: price,
    ichimokuSenkouA: price,
    ichimokuSenkouB: price,
    waveletDetail1: 0,
    waveletDetail2: 0,
    waveletTrend: price,
    waveletNoiseRatio: 0,
    ewmsFast: price,
    ewmsSlow: price,
    ewmsMomentum: 0,
    ewmsAcceleration: 0,
  };
}

describe('Digit Strategies', () => {
  it('EvenOddStrategy emits DIGITEVEN/DIGITODD when parity deviates', () => {
    const strat = new EvenOddStrategy({ windowSize: 20, evenThreshold: 0.65 });

    // Push 20 even price ticks (digit 2)
    for (let i = 0; i < 19; i++) {
      strat.generateSignal(mockTickFeatures(100.02), []);
    }
    const signal = strat.generateSignal(mockTickFeatures(100.02), []);

    expect(signal.direction).toBe('SELL'); // High EVEN ratio triggers DIGITODD (SELL)
    expect(signal.metadata?.contractType).toBe('DIGITODD');
  });

  it('OverUnderStrategy emits DIGITOVER when digits exceed barrier', () => {
    const strat = new OverUnderStrategy({ windowSize: 20, barrier: 5, thresholdRatio: 0.60 });

    // Push 20 prices with digit 8 (over 5)
    for (let i = 0; i < 19; i++) {
      strat.generateSignal(mockTickFeatures(100.08), []);
    }
    const signal = strat.generateSignal(mockTickFeatures(100.08), []);

    expect(signal.direction).toBe('BUY');
    expect(signal.metadata?.contractType).toBe('DIGITOVER');
    expect(signal.metadata?.barrier).toBe(5);
  });

  it('MatchesDiffersStrategy emits DIGITDIFF for low-frequency digits', () => {
    const strat = new MatchesDiffersStrategy({ windowSize: 25, mode: 'DIFFERS' });

    // Push 25 prices with digit 3
    for (let i = 0; i < 24; i++) {
      strat.generateSignal(mockTickFeatures(100.03), []);
    }
    const signal = strat.generateSignal(mockTickFeatures(100.03), []);

    expect(signal.direction).toBe('BUY');
    expect(signal.metadata?.contractType).toBe('DIGITDIFF');
    expect(signal.metadata?.barrier).toBeDefined();
  });
});
