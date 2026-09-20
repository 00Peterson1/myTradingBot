import { MomentumStrategy } from './momentum/MomentumStrategy.js';
import { VolAdjMomentumStrategy } from './volatility-momentum/VolAdjMomentumStrategy.js';
import { MeanReversionStrategy } from './mean-reversion/MeanReversionStrategy.js';
import { BreakoutStrategy } from './breakout/BreakoutStrategy.js';
import { WaveletStrategy } from './signal/WaveletStrategy.js';
import { EWMSStrategy } from './signal/EWMSStrategy.js';
import type { Strategy } from './base/Strategy.js';
export interface StrategyFactory { name: string; factory: () => Strategy }

export const strategyFactories: StrategyFactory[] = [
    { name: 'Momentum(lookback=20,threshold=0.001)', factory: () => new MomentumStrategy({ lookback: 20, threshold: 0.001, momentumKey: 'mom20' }) },
    { name: 'Momentum(lookback=50,threshold=0.002)', factory: () => new MomentumStrategy({ lookback: 50, threshold: 0.002, momentumKey: 'mom50' }) },
    { name: 'VolAdjMomentum(zThreshold=1.0)',        factory: () => new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom20', zThreshold: 1.0 }) },
    { name: 'VolAdjMomentum(zThreshold=1.5)',        factory: () => new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom50', zThreshold: 1.5 }) },
    { name: 'MeanReversion(z=1.5,exit=0.5)',         factory: () => new MeanReversionStrategy({ zScoreKey: 'zScore20', entryThreshold: 1.5, exitThreshold: 0.5 }) },
    { name: 'MeanReversion(z=2.0,exit=0.5)',         factory: () => new MeanReversionStrategy({ zScoreKey: 'zScore50', entryThreshold: 2.0, exitThreshold: 0.5 }) },
    { name: 'Breakout(window=20,frac=0.001)',         factory: () => new BreakoutStrategy({ highKey: 'rollingHigh20', lowKey: 'rollingLow20', confirmationFraction: 0.001 }) },
    { name: 'Breakout(window=50,frac=0.002)',         factory: () => new BreakoutStrategy({ highKey: 'rollingHigh50', lowKey: 'rollingLow50', confirmationFraction: 0.002 }) },
    { name: 'Wavelet',                               factory: () => new WaveletStrategy() },
    { name: 'EWMS',                                  factory: () => new EWMSStrategy() },
  ];
