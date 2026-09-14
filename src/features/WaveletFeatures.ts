import { assertDefined } from '../utils/assertDefined.js';
export function haarDWT(prices: readonly number[], n: number, levels = 2): { detail1: number | null, detail2: number | null, trend: number | null, noiseRatio: number | null } {
  const required = Math.pow(2, levels);
  if (n < required - 1) return { detail1: null, detail2: null, trend: null, noiseRatio: null };
  
  const slice = prices.slice(n - required + 1, n + 1); // length 4 for levels=2
  
  if (levels === 2) {
    const p0 = assertDefined(slice[0]), p1 = assertDefined(slice[1]), p2 = assertDefined(slice[2]), p3 = assertDefined(slice[3]);
    const a0 = (p0 + p1) / 2;
    const a1 = (p2 + p3) / 2;
    const d1 = (p2 - p3) / 2;
    
    const trend = (a0 + a1) / 2;
    const detail2 = (a0 - a1) / 2;
    
    const noiseRatio = Math.abs(d1) / (Math.abs(trend) + 1e-10);
    
    return { detail1: d1, detail2, trend, noiseRatio };
  }
  
  return { detail1: null, detail2: null, trend: null, noiseRatio: null };
}
