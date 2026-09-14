import { assertDefined } from '../../utils/assertDefined.js';
/**
 * Digit Analyzer for Deriv Synthetic Indices.
 * Extracts last digits from prices and computes rolling statistics & digit frequencies.
 */

export interface DigitStats {
  lastDigit: number;
  evenCount: number;
  oddCount: number;
  evenRatio: number;
  oddRatio: number;
  overCounts: number[]; // Index 0..9: count of digits strictly > barrier index
  underCounts: number[]; // Index 0..9: count of digits strictly < barrier index
  digitFrequencies: number[]; // Index 0..9: frequency of each digit
  sampleSize: number;
  evenPValue: number; // Binomial test p-value for even/odd deviation from 0.5
}

/**
 * Extracts the last integer digit of a floating point price string/number.
 * Example: 1234.567 -> last digit is 7.
 * Example: 8234.10 -> last digit is 0.
 */
export function extractLastDigit(price: number, pipSize = 2): number {
  const formatted = price.toFixed(pipSize);
  const lastChar = formatted.slice(-1);
  const digit = parseInt(lastChar, 10);
  return isNaN(digit) ? 0 : digit;
}

export class DigitAnalyzer {
  private window: number[];

  constructor(private readonly maxWindowSize = 50) {
    this.window = [];
  }

  /**
   * Pushes a new price tick into the analyzer.
   */
  push(price: number, pipSize = 2): number {
    const digit = extractLastDigit(price, pipSize);
    this.window.push(digit);
    if (this.window.length > this.maxWindowSize) {
      this.window.shift();
    }
    return digit;
  }

  /**
   * Computes comprehensive digit statistics over the current rolling window.
   */
  getStats(): DigitStats | null {
    if (this.window.length < 10) return null;

    const sampleSize = this.window.length;
    const lastDigit = assertDefined(this.window[this.window.length - 1]);

    let evenCount = 0;
    let oddCount = 0;
    const digitFrequencies = new Array<number>(10).fill(0);

    for (const d of this.window) {
      digitFrequencies[d] = assertDefined(digitFrequencies[d]) + 1;
      if (d % 2 === 0) {
        evenCount++;
      } else {
        oddCount++;
      }
    }

    const evenRatio = evenCount / sampleSize;
    const oddRatio = oddCount / sampleSize;

    // Over/Under counts for barriers 0..9
    const overCounts = new Array<number>(10).fill(0);
    const underCounts = new Array<number>(10).fill(0);

    for (let barrier = 0; barrier <= 9; barrier++) {
      for (const d of this.window) {
        if (d > barrier) overCounts[barrier] = assertDefined(overCounts[barrier]) + 1;
        if (d < barrier) underCounts[barrier] = assertDefined(underCounts[barrier]) + 1;
      }
    }

    // Normal approximation for Binomial Test (H0: p = 0.5)
    // Z = (k - n*p) / sqrt(n * p * (1-p)) = (evenCount - 0.5*n) / sqrt(0.25 * n)
    const zScore = Math.abs(evenCount - 0.5 * sampleSize) / Math.sqrt(0.25 * sampleSize);
    // Two-tailed p-value approximation via erf
    const evenPValue = Math.max(0.0001, 2 * (1 - normalCDF(zScore)));

    return {
      lastDigit,
      evenCount,
      oddCount,
      evenRatio,
      oddRatio,
      overCounts,
      underCounts,
      digitFrequencies,
      sampleSize,
      evenPValue,
    };
  }

  clear(): void {
    this.window = [];
  }
}

/**
 * Normal cumulative distribution function (CDF).
 */
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const prob =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - prob : prob;
}
