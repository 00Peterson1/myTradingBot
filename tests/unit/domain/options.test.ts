import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { money, addMoney, majorUnits, optionSpecificationSchema } from '../../../src/types/product.js';
import type { Signal } from '../../../src/types/signal.js';
import { RiskEngine } from '../../../src/risk/RiskEngine.js';
import { resetEnvForTesting } from '../../../src/config/env.js';
import { DerivExecutionEngine } from '../../../src/execution/DerivExecutionEngine.js';
import { DerivClient } from '../../../src/api/deriv/DerivClient.js';
import { VotingEngine } from '../../../src/execution/VotingEngine.js';

function candidate(overrides: Partial<Signal> = {}): Signal {
  return { product: 'OPTIONS', hypothesisId: null, strategyVersion: '1', id: 'signal',
    timestamp: new Date(), symbol: 'TEST', price: 100, strategy: 'test', confidence: 0.8,
    direction: 'BUY', metadata: {}, ...overrides };
}
beforeEach(() => {
  vi.stubEnv('DEMO_TRADING', 'true'); vi.stubEnv('LIVE_TRADING', 'false');
  vi.stubEnv('LIVE_CONFIRMATION', 'false'); vi.stubEnv('STAKE_AMOUNT', '1');
  vi.stubEnv('CONTRACT_DURATION', '5'); vi.stubEnv('CONTRACT_DURATION_UNIT', 't');
  resetEnvForTesting();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvForTesting(); });

describe('product domain invariants', () => {
  it('adds money exactly and refuses cross-currency or excess-precision amounts', () => {
    expect(majorUnits(addMoney(money(0.1, 'USD', 2), money(0.2, 'USD', 2)))).toBe(0.3);
    expect(() => money(1.001, 'USD', 2)).toThrow('precision');
    expect(() => addMoney(money(1, 'USD', 2), money(1, 'EUR', 2))).toThrow('different currencies');
    expect(() => money(Infinity, 'USD', 2)).toThrow('finite');
  });
  it('rejects CFD signals, nonfinite confidence, and inconsistent barriers at risk', () => {
    const risk = new RiskEngine(1000);
    expect(risk.evaluate(candidate({ product: 'CFD' }), 'DEMO')).toMatchObject({ approved: false, reason: 'UNSUPPORTED_PRODUCT' });
    expect(risk.evaluate(candidate({ confidence: NaN }), 'DEMO')).toMatchObject({ approved: false, reason: 'INVALID_SIGNAL' });
    expect(risk.evaluate(candidate({ metadata: { contractType: 'DIGITOVER' } }), 'DEMO')).toMatchObject({ approved: false, reason: 'INVALID_CONTRACT_SPECIFICATION' });
  });
  it('refuses to mix product or symbol votes', () => {
    expect(new VotingEngine().vote('TEST', [candidate({ product: 'CFD' })]).hasConsensus).toBe(false);
    expect(new VotingEngine().vote('OTHER', [candidate()]).hasConsensus).toBe(false);
  });
  it('never substitutes a duration after a rejected proposal', async () => {
    const approval = new RiskEngine(1000).evaluate(candidate(), 'DEMO');
    if (!approval.approved) throw new Error('Fixture should be approved');
    expect(Object.isFrozen(approval.approvedSignal.optionSpecification)).toBe(true);
    const client = new DerivClient();
    const request = vi.spyOn(client, 'requestProposal').mockRejectedValue(new Error('TradingDurationNotAllowed'));
    const buy = vi.spyOn(client, 'buyContract');
    await expect(new DerivExecutionEngine(client).execute(approval.approvedSignal)).rejects.toThrow('TradingDurationNotAllowed');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ duration: 5, durationUnit: 't', currency: 'USD' }));
    expect(buy).not.toHaveBeenCalled();
    expect(optionSpecificationSchema.parse(approval.approvedSignal.optionSpecification).duration).toBe(5);
  });
  it('refuses a proposal that exceeds the approved risk budget', async () => {
    const approval = new RiskEngine(1000).evaluate(candidate(), 'DEMO');
    if (!approval.approved) throw new Error('Fixture should be approved');
    const client = new DerivClient();
    vi.spyOn(client, 'requestProposal').mockResolvedValue({ id: 'quote', ask_price: 2, payout: 3, spot: 100, longcode: '' });
    const buy = vi.spyOn(client, 'buyContract');
    await expect(new DerivExecutionEngine(client).execute(approval.approvedSignal)).rejects.toThrow('exceeds approved stake');
    expect(buy).not.toHaveBeenCalled();
  });
});
