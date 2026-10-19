import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { ctraderConfigSchema, type CTraderConfig } from './DemoConnection.js';

const tokenSchema = z.object({ accountId: z.string(), clientId: z.string(), accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAtMs: z.number().int().positive() }).strict();
export type CTraderSavedTokens = z.infer<typeof tokenSchema>;
/** Local private credential state; never placed in experiment artifacts or log messages. */
export function readCTraderTokens(path: string, accountId: string, clientId: string): CTraderSavedTokens | null {
  if (!existsSync(path)) return null;
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('cTrader session credential file permissions must be private');
  const saved = tokenSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (saved.accountId !== accountId || saved.clientId !== clientId) return null;
  return saved;
}
export function saveCTraderTokens(path: string, input: CTraderSavedTokens): void {
  const value = tokenSchema.parse(input), temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600); renameSync(temporary, path);
}

/** All cTrader CLIs share refreshed credentials while preserving application/account identity. */
export function withSavedCTraderTokens(input: CTraderConfig, path = fileURLToPath(new URL('../../../data/.ctrader-session.json', import.meta.url))): CTraderConfig {
  const config = ctraderConfigSchema.parse(input);
  const saved = readCTraderTokens(path, config.accountId, config.clientId);
  return saved ? { ...config, accessToken: saved.accessToken, refreshToken: saved.refreshToken } : config;
}
