import { describe, expect, it } from 'vitest';
import { normalizeContractState } from '../../../src/api/deriv/DerivTypes.js';

const identity = { contract_id: 123, contract_type: 'CALL', currency: 'USD' };
describe('provider contract settlement boundary', () => {
  it('does not turn expiry or a missing profit into settlement', () => {
    expect(normalizeContractState({ ...identity, status: 'open', is_expired: 1, is_sold: 0 }))
      .toMatchObject({ isSettled: false, profit: null, payout: null });
  });
  it('normalizes decimal strings and actual terminal status', () => {
    expect(normalizeContractState({ ...identity, status: 'won', is_sold: 1,
      buy_price: '1.00', profit: '0.85', sell_price: '1.85', exit_spot: '123.456', exit_spot_time: 1000 }))
      .toMatchObject({ isSettled: true, buyPrice: 1, profit: 0.85, payout: 1.85, exitPrice: 123.456, exitTime: new Date(1000000) });
  });
  it('rejects incomplete terminal data and malformed numeric strings', () => {
    expect(() => normalizeContractState({ ...identity, status: 'won', is_sold: 1 })).toThrow('missing settlement amounts');
    expect(() => normalizeContractState({ ...identity, profit: '' })).toThrow();
  });
});
