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
    -- Symbol registry (extended with market metadata)
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

    -- Market characteristics profile (updated after each research cycle)
    CREATE TABLE IF NOT EXISTS market_profiles (
      symbol             TEXT PRIMARY KEY,
      market_category    TEXT NOT NULL DEFAULT '',
      exchange_is_open   INTEGER NOT NULL DEFAULT 0,
      spot               REAL,
      tick_rate_estimate REAL,
      trading_hours      TEXT,          -- JSON: {"always_open":true} or {"sessions":[...]}
      tradability_score  INTEGER DEFAULT 0,
      research_score     INTEGER DEFAULT 0,
      last_profiled_at   TEXT,
      last_seen_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Pair spread state (persists across daemon restarts)
    CREATE TABLE IF NOT EXISTS pair_spread_state (
      pair_id          TEXT PRIMARY KEY,   -- e.g. 'frxEURGBP-frxAUDNZD'
      symbol_a         TEXT NOT NULL,
      symbol_b         TEXT NOT NULL,
      beta_hedge_ratio REAL,
      spread_mean      REAL,
      spread_std       REAL,
      cointegration_p  REAL,
      last_z_score     REAL,
      window_size      INTEGER DEFAULT 200,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- RL Q-table (persisted across restarts so agents accumulate experience)
    CREATE TABLE IF NOT EXISTS rl_q_tables (
      strategy_name TEXT    NOT NULL,
      symbol        TEXT    NOT NULL,
      state_key     TEXT    NOT NULL,  -- serialized discretized state e.g. "2_1_3"
      action        TEXT    NOT NULL,  -- BUY | SELL | HOLD
      q_value       REAL    NOT NULL DEFAULT 0.0,
      update_count  INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (strategy_name, symbol, state_key, action)
    );

    -- Economic calendar events
    CREATE TABLE IF NOT EXISTS economic_events (
      event_id       TEXT PRIMARY KEY,
      country        TEXT NOT NULL,
      currency       TEXT NOT NULL,
      event_name     TEXT NOT NULL,
      scheduled_at   TEXT NOT NULL,
      impact         TEXT NOT NULL,  -- LOW | MEDIUM | HIGH | CRITICAL
      previous       REAL,
      forecast       REAL,
      actual         REAL,
      affected_pairs TEXT,           -- JSON array of symbol strings
      fetched_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_econ_events_scheduled ON economic_events (scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_econ_events_currency ON economic_events (currency);

    -- Gemini context filter cache (4-hour TTL per pair)
    CREATE TABLE IF NOT EXISTS gemini_context_cache (
      pair_id          TEXT PRIMARY KEY,
      divergence_score INTEGER NOT NULL DEFAULT 0,
      suppress_trade   INTEGER NOT NULL DEFAULT 0,
      rationale        TEXT,
      key_risk         TEXT,
      fetched_at       TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at       TEXT NOT NULL
    );
  `);

  // Extend symbols table with new columns (safe — catches if already exist)
  const newSymbolCols: [string, string][] = [
    ['market_category', 'TEXT NOT NULL DEFAULT ""'],
    ['exchange_is_open', 'INTEGER NOT NULL DEFAULT 0'],
    ['spot', 'REAL'],
    ['tick_rate_estimate', 'REAL'],
    ['trading_hours', 'TEXT'],
    ['tradability_score', 'INTEGER DEFAULT 0'],
    ['research_score', 'INTEGER DEFAULT 0'],
    ['last_profiled_at', 'TEXT'],
  ];
  for (const [col, def] of newSymbolCols) {
    try {
      db.exec(`ALTER TABLE symbols ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  // Extend market_profiles with statistical research columns
  const newProfileCols: [string, string][] = [
    ['availability_known', 'INTEGER NOT NULL DEFAULT 0'],
    ['is_trading_suspended', 'INTEGER NOT NULL DEFAULT 0'],
    ['market_type',        'TEXT NOT NULL DEFAULT "unknown"'],
    ['is_autocorrelated',  'INTEGER NOT NULL DEFAULT 0'],
    ['is_normal',          'INTEGER NOT NULL DEFAULT 1'],
    ['has_edge',           'INTEGER NOT NULL DEFAULT 0'],
    ['std_dev',            'REAL'],
    ['sharpe',             'REAL'],
    ['score',              'INTEGER NOT NULL DEFAULT 0'],
    ['tick_count',         'INTEGER NOT NULL DEFAULT 0'],
    ['skewness',           'REAL'],
    ['kurtosis',           'REAL'],
    ['ljungbox_pvalue',    'REAL'],
    ['jb_pvalue',          'REAL'],
    ['momentum_lift',      'REAL'],
    ['momentum_pvalue',    'REAL'],
    ['recommended_strategies', 'TEXT'],
  ];
  for (const [col, def] of newProfileCols) {
    try {
      db.exec(`ALTER TABLE market_profiles ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists — safe to ignore
    }
  }
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
