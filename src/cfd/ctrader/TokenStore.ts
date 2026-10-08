import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

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
