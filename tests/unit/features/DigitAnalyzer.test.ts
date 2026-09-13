import { describe, it, expect } from 'vitest';
import { extractLastDigit, DigitAnalyzer } from '../../../src/features/digit/DigitAnalyzer.js';

describe('DigitAnalyzer', () => {
  it('extracts last digit correctly', () => {
    expect(extractLastDigit(1234.56, 2)).toBe(6);
    expect(extractLastDigit(8234.10, 2)).toBe(0);
    expect(extractLastDigit(100.99, 2)).toBe(9);
  });

  it('computes rolling digit statistics', () => {
    const analyzer = new DigitAnalyzer(20);

    // Push 10 even prices and 10 odd prices
    for (let i = 0; i < 10; i++) {
      analyzer.push(100.02, 2); // Digit 2 (even)
    }
    for (let i = 0; i < 10; i++) {
      analyzer.push(100.05, 2); // Digit 5 (odd)
    }

    const stats = analyzer.getStats();
    expect(stats).not.toBeNull();
    if (stats) {
      expect(stats.sampleSize).toBe(20);
      expect(stats.evenCount).toBe(10);
      expect(stats.oddCount).toBe(10);
      expect(stats.evenRatio).toBe(0.5);
      expect(stats.oddRatio).toBe(0.5);
      expect(stats.digitFrequencies[2]).toBe(10);
      expect(stats.digitFrequencies[5]).toBe(10);
      expect(stats.overCounts[4]).toBe(10); // Digits > 4 (5 is > 4)
      expect(stats.underCounts[3]).toBe(10); // Digits < 3 (2 is < 3)
    }
  });
});
