import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = (name: string, args: string[], extra: Record<string, string> = {}): ReturnType<typeof spawnSync> => spawnSync(
  process.execPath, ['--import', 'tsx', resolve(`src/cli/${name}.ts`), ...args],
  { encoding: 'utf8', timeout: 15_000, env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null',
    DERIV_API_TOKEN: '', DERIV_APP_ID: '', LOG_PRETTY: 'false', LIVE_TRADING: 'false', LIVE_CONFIRMATION: 'false', ...extra } },
);

describe('CLI startup boundaries (no account or network requests)', () => {
  it.each(['doctor', 'migrate', 'markets', 'research', 'research-daemon', 'backtest', 'trade-demo', 'trade-live'])(
    '%s help starts without credentials or database access', name => {
      const result = run(name, ['--help']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(String(result.stdout)).toContain('Usage: npm run');
    },
  );
  it.each(['research', 'backtest'])( '%s rejects invalid configuration before starting work', name => {
    const result = run(name, [], { CONTRACT_DURATION: '-1' });
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('Invalid environment configuration');
  });
  it('live startup rejects missing live opt-in', () => {
    const result = run('trade-live', []);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('LIVE TRADING IS DISABLED');
  });
});
