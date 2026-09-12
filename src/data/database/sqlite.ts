import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
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
  _db = new Database(DB_PATH, { verbose: undefined });

  // WAL mode: much faster for concurrent reads, safer writes
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  initSchema(_db);
  log.info('SQLite schema ready');

  return _db;
}

/**
 * Initialises the database schema.
 * All tables are created with IF NOT EXISTS — safe to call repeatedly.
 */
function initSchema(db: Database.Database): void {
  db.exec(`
    -- Symbol registry
    CREATE TABLE IF NOT EXISTS symbols (
      symbol          TEXT PRIMARY KEY,
      display_name    TEXT NOT NULL DEFAULT '',
      market          TEXT NOT NULL DEFAULT '',
      submarket       TEXT NOT NULL DEFAULT '',
      instrument_type TEXT NOT NULL DEFAULT '',
      pip_size        REAL,
      is_active       INTEGER NOT NULL DEFAULT 1,
      last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Raw tick data
    CREATE TABLE IF NOT EXISTS ticks (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol   TEXT    NOT NULL,
      epoch    INTEGER NOT NULL,
      ts       TEXT    NOT NULL,
      price    REAL    NOT NULL,
      tick_id  INTEGER,
      UNIQUE (symbol, epoch, price)
    );
    CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks (symbol, ts);
    CREATE INDEX IF NOT EXISTS idx_ticks_symbol_epoch ON ticks (symbol, epoch);

    -- Computed features per tick
    CREATE TABLE IF NOT EXISTS tick_features (
      tick_id          INTEGER PRIMARY KEY REFERENCES ticks(id) ON DELETE CASCADE,
      symbol           TEXT    NOT NULL,
      ts               TEXT    NOT NULL,
      log_return       REAL,
      simple_return    REAL,
      mom_5            REAL,
      mom_10           REAL,
      mom_20           REAL,
      mom_50           REAL,
      mom_100          REAL,
      rolling_std_20   REAL,
      rolling_std_50   REAL,
      realized_vol_20  REAL,
      vol_adj_mom_20   REAL,
      vol_adj_mom_50   REAL,
      rolling_mean_20  REAL,
      rolling_mean_50  REAL,
      z_score_20       REAL,
      z_score_50       REAL,
      rolling_high_20  REAL,
      rolling_low_20   REAL,
      rolling_high_50  REAL,
      rolling_low_50   REAL,
      drawdown_20      REAL,
      autocorr_lag1    REAL
    );
    CREATE INDEX IF NOT EXISTS idx_tick_features_symbol_ts ON tick_features (symbol, ts);
  `);
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
