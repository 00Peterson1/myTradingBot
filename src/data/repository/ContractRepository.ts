import { getDb } from '../database/sqlite.js';
import type { AvailableContract } from '../../api/deriv/DerivTypes.js';

function table() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS market_contracts (
    symbol TEXT PRIMARY KEY, contracts_json TEXT NOT NULL, fetched_at TEXT NOT NULL
  )`);
  return db;
}

export function saveContracts(symbol: string, contracts: readonly AvailableContract[]): void {
  table().prepare(`INSERT INTO market_contracts VALUES (?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET contracts_json=excluded.contracts_json, fetched_at=excluded.fetched_at`)
    .run(symbol, JSON.stringify(contracts), new Date().toISOString());
}

export function getCachedContracts(symbol: string, maxAgeHours = 24): AvailableContract[] | null {
  const row = table().prepare('SELECT contracts_json, fetched_at FROM market_contracts WHERE symbol=?')
    .get(symbol) as { contracts_json: string; fetched_at: string } | undefined;
  if (!row || Date.now() - Date.parse(row.fetched_at) > maxAgeHours * 3600000) return null;
  return JSON.parse(row.contracts_json) as AvailableContract[];
}
