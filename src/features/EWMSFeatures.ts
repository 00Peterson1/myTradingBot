import { rollingStd } from './indicators/indicators.js';

export function ewms(prices: readonly number[], n: number): { fast: number | null, slow: number | null, momentum: number | null, acceleration: number | null } {
  const getEwm = (alpha: number, minPeriods: number, endIndex: number) => {
    if (endIndex < minPeriods - 1) return null;
    let val = prices[endIndex - minPeriods + 1]!;
    for (let i = endIndex - minPeriods + 2; i <= endIndex; i++) {
      val = alpha * prices[i]! + (1 - alpha) * val;
    }
    return val;
  };
  
  const calcMom = (endIndex: number) => {
    const fast = getEwm(0.2, 5, endIndex);
    const slow = getEwm(0.05, 20, endIndex);
    const std = rollingStd(prices, endIndex, 20);
    if (fast === null || slow === null || std === null || std === 0) return { fast, slow, momentum: null };
    return { fast, slow, momentum: (fast - slow) / std };
  };

  const curr = calcMom(n);
  const prev = calcMom(n - 1);
  
  const acceleration = (curr.momentum !== null && prev.momentum !== null) ? curr.momentum - prev.momentum : null;
  
  return {
    fast: curr.fast,
    slow: curr.slow,
    momentum: curr.momentum,
    acceleration
  };
}
