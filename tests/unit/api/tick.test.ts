import { describe, expect, it } from 'vitest';
import { DerivTickSchema } from '../../../src/api/deriv/DerivTypes.js';

describe('Deriv streamed tick validation', () => {
  const tick = { epoch: 1789490000, quote: 9624.39, pip_size: 2, symbol: '1HZ10V' };
  it('accepts the provider string subscription identifier and optional omission', () => {
    const message = { ...tick, id: 'c84a793b-8a87-7999-ce10-9b22f7ceead3' };
    expect(DerivTickSchema.parse(message)).toEqual(message);
    expect(DerivTickSchema.parse(tick)).toEqual(tick);
  });
  it('still rejects invalid market observations', () => {
    for (const invalid of [{ quote: NaN }, { quote: 0 }, { epoch: -1 }, { epoch: 1.5 }, { symbol: null }]) {
      expect(DerivTickSchema.safeParse({ ...tick, ...invalid }).success).toBe(false);
    }
  });
});
