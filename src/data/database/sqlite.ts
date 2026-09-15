import { runMigrations } from './migrations.js';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'node:fs';
import { createLogger } from '../../monitoring/Logger.js';

const log = createLogger('SQLite');

// ---------------------------------------------------------------------------
// Resolve DB path relative to the project root (works regardless of cwd)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/data/database/sqlite.ts → go up 3 dirs to reach the project root
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'trading.db');

let _db: Database.Database | null = null;

/**
 * Returns the singleton SQLite database connection.
 * Auto-creates the database file and schema on first call.
 */
export function getDb(): Database.Database {
  if (_db !== null) return _db;

  log.info({ path: DB_PATH }, 'Opening SQLite database');
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH, { verbose: undefined });

  // WAL mode: much faster for concurrent reads, safer writes
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  try { runMigrations(_db); } catch (error) { _db.close(); _db = null; throw error; }
  log.info('SQLite schema ready');

  return _db;
}

/**
 * Closes the database connection.
 * Call during graceful shutdown.
 */
export function closeDb(): void {
  if (_db !== null) {
    log.info('Closing SQLite database');
    _db.close();
    _db = null;
  }
}
