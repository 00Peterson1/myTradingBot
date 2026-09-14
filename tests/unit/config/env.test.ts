import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv, getTradingEnv, resetEnvForTesting } from '../../../src/config/env.js';

describe('configuration boundaries', () => {
  beforeEach(() => {
    vi.stubEnv('DERIV_API_TOKEN', '');
    vi.stubEnv('DERIV_APP_ID', '');
    vi.stubEnv('LIVE_TRADING', 'false');
    vi.stubEnv('LIVE_CONFIRMATION', 'false');
    resetEnvForTesting();
  });
  afterEach(() => { vi.unstubAllEnvs(); resetEnvForTesting(); });
  it('allows public research without account credentials', () => {
    expect(getEnv().DERIV_API_TOKEN).toBe('');
    expect(() => getTradingEnv()).toThrow('requires DERIV_API_TOKEN and DERIV_APP_ID');
  });
  it('rejects misspelled safety booleans', () => {
    vi.stubEnv('LIVE_TRADING', 'treu');
    expect(() => getEnv()).toThrow('Invalid environment');
  });
  it('does not permit a single flag to authorize live mode', () => {
    vi.stubEnv('LIVE_TRADING', 'true');
    expect(() => getEnv()).toThrow('requires LIVE_CONFIRMATION');
  });
});
