import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCTraderTokens, saveCTraderTokens, withSavedCTraderTokens } from '../../../src/cfd/ctrader/TokenStore.js';

describe('private rotating cTrader token storage', () => {
  it('saves replacements atomically with private permissions and binds them to the application/account', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ctrader-token-test-')), path = join(directory, 'session.json');
    try {
      const tokens = { accountId: '123', clientId: 'fixture-app', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAtMs: 2000 };
      expect(readCTraderTokens(path, '123', 'fixture-app')).toBeNull();
      saveCTraderTokens(path, tokens);
      saveCTraderTokens(path, { ...tokens, accessToken: 'replacement-fixture' });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readCTraderTokens(path, '123', 'fixture-app')?.accessToken).toBe('replacement-fixture');
      expect(readCTraderTokens(path, '456', 'fixture-app')).toBeNull();
      const config = { accountId: '123', clientId: 'fixture-app', clientSecret: 'fixture-secret', accessToken: 'original-fixture' };
      expect(withSavedCTraderTokens(config, path).accessToken).toBe('replacement-fixture');
      expect(withSavedCTraderTokens({ ...config, accountId: '456' }, path).accessToken).toBe('original-fixture');
      expect(readdirSync(directory)).toEqual(['session.json']);
      chmodSync(path, 0o644);
      expect(() => readCTraderTokens(path, '123', 'fixture-app')).toThrow('private');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
