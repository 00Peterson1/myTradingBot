import { getDb } from '../database/sqlite.js';
import { createLogger } from '../../monitoring/Logger.js';
import { TICK_INSERT_BATCH_SIZE } from '../../config/constants.js';
import type { Tick, TickFeatures } from '../../types/index.js';

const log = createLogger('TickRepository');

// ---------------------------------------------------------------------------
// Symbol Registry
// ---------------------------------------------------------------------------

export interface SymbolRecord {
  symbol: string;
  displayName: string;
  market: string;
  submarket: string;
  instrumentType: string;
  pipSize?: number;
}

export function upsertSymbol(sym: SymbolRecord): void {
  getDb()
    .prepare(
      `INSERT INTO symbols (symbol, display_name, market, submarket, instrument_type, pip_size, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (symbol) DO UPDATE SET
         display_name   = excluded.display_name,
         last_seen_at   = datetime('now'),
         is_active      = 1`,
    )
    .run(
      sym.symbol,
      sym.displayName,
      sym.market,
      sym.submarket,
      sym.instrumentType,
      sym.pipSize ?? null,
    );
}

export function getActiveSymbols(): string[] {
  const rows = getDb()
    .prepare<[], { symbol: string }>('SELECT symbol FROM symbols WHERE is_active = 1 ORDER BY symbol')
    .all();
  return rows.map((r) => r.symbol);
}

// ---------------------------------------------------------------------------
// Tick Insertion
// ---------------------------------------------------------------------------

export interface TickInsert {
  symbol: string;
  epoch: number;
  price: number;
  tickId?: number;
}

/**
 * Inserts a single tick.
 * Silently ignores duplicates (ON CONFLICT DO NOTHING via IGNORE).
 * Returns the stored rowid or null if it was a duplicate.
 */
export function insertTick(tick: TickInsert): bigint | null {
  const ts = new Date(tick.epoch * 1000).toISOString();
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO ticks (symbol, epoch, ts, price, tick_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(tick.symbol, tick.epoch, ts, tick.price, tick.tickId ?? null);

  return result.changes > 0 ? BigInt(result.lastInsertRowid) : null;
}

/**
 * Bulk-inserts ticks in batches of TICK_INSERT_BATCH_SIZE.
 * Returns count of actually inserted (non-duplicate) ticks.
 * Uses a transaction for speed — SQLite without transactions is very slow for bulk inserts.
 */
export function bulkInsertTicks(ticks: TickInsert[]): number {
  if (ticks.length === 0) return 0;

  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ticks (symbol, epoch, ts, price, tick_id) VALUES (?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const insertBatch = db.transaction((batch: TickInsert[]) => {
    for (const tick of batch) {
      const ts = new Date(tick.epoch * 1000).toISOString();
      const result = stmt.run(tick.symbol, tick.epoch, ts, tick.price, tick.tickId ?? null);
      if (result.changes > 0) inserted++;
    }
  });

  for (let i = 0; i < ticks.length; i += TICK_INSERT_BATCH_SIZE) {
    const batch = ticks.slice(i, i + TICK_INSERT_BATCH_SIZE);
    insertBatch(batch);
    log.debug({ batchIndex: Math.floor(i / TICK_INSERT_BATCH_SIZE) + 1, inserted }, 'Batch inserted');
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// Tick Queries
// ---------------------------------------------------------------------------

interface TickRow {
  id: number;
  symbol: string;
  epoch: number;
  ts: string;
  price: number;
  tick_id: number | null;
}

/**
 * Fetches the N most recent ticks for a symbol ordered ascending (oldest first).
 */
export function getRecentTicks(symbol: string, limit: number): Tick[] {
  const rows = getDb()
    .prepare<[string, number], TickRow>(
      `SELECT id, symbol, epoch, ts, price, tick_id
       FROM ticks
       WHERE symbol = ?
       ORDER BY epoch DESC
       LIMIT ?`,
    )
    .all(symbol, limit);
  // Reverse so ticks are oldest-first (chronological)
  return rows.reverse().map(rowToTick);
}

/**
 * Fetches ticks for a symbol within a time range (inclusive).
 */
export function getTicksInRange(symbol: string, from: Date, to: Date): Tick[] {
  const rows = getDb()
    .prepare<[string, string, string], TickRow>(
      `SELECT id, symbol, epoch, ts, price, tick_id
       FROM ticks
       WHERE symbol = ? AND ts >= ? AND ts <= ?
       ORDER BY epoch ASC`,
    )
    .all(symbol, from.toISOString(), to.toISOString());
  return rows.map(rowToTick);
}

/**
 * Returns the latest tick epoch for a symbol (for incremental fetching).
 */
export function getLatestTickEpoch(symbol: string): number | null {
  const row = getDb()
    .prepare<[string], { epoch: number }>(
      'SELECT epoch FROM ticks WHERE symbol = ? ORDER BY epoch DESC LIMIT 1',
    )
    .get(symbol);
  return row?.epoch ?? null;
}

/**
 * Returns tick count for a symbol (for research readiness checks).
 */
export function getTickCount(symbol: string): number {
  const row = getDb()
    .prepare<[string], { count: number }>(
      'SELECT COUNT(*) as count FROM ticks WHERE symbol = ?',
    )
    .get(symbol);
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Feature Storage
// ---------------------------------------------------------------------------

export function upsertTickFeatures(tickRowId: bigint, features: TickFeatures): void {
  getDb()
    .prepare(
      `INSERT INTO tick_features (
         tick_id, symbol, ts,
         log_return, simple_return,
         mom_5, mom_10, mom_20, mom_50, mom_100,
         rolling_std_20, rolling_std_50, realized_vol_20,
         vol_adj_mom_20, vol_adj_mom_50,
         rolling_mean_20, rolling_mean_50,
         z_score_20, z_score_50,
         rolling_high_20, rolling_low_20, rolling_high_50, rolling_low_50,
         drawdown_20, autocorr_lag1
       ) VALUES (
         ?, ?, ?,
         ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?,
         ?, ?,
         ?, ?, ?, ?,
         ?, ?
       )
       ON CONFLICT (tick_id) DO UPDATE SET
         log_return      = excluded.log_return,
         simple_return   = excluded.simple_return,
         mom_5           = excluded.mom_5,
         mom_10          = excluded.mom_10,
         mom_20          = excluded.mom_20,
         mom_50          = excluded.mom_50,
         mom_100         = excluded.mom_100,
         rolling_std_20  = excluded.rolling_std_20,
         rolling_std_50  = excluded.rolling_std_50,
         realized_vol_20 = excluded.realized_vol_20,
         vol_adj_mom_20  = excluded.vol_adj_mom_20,
         vol_adj_mom_50  = excluded.vol_adj_mom_50,
         rolling_mean_20 = excluded.rolling_mean_20,
         rolling_mean_50 = excluded.rolling_mean_50,
         z_score_20      = excluded.z_score_20,
         z_score_50      = excluded.z_score_50,
         rolling_high_20 = excluded.rolling_high_20,
         rolling_low_20  = excluded.rolling_low_20,
         rolling_high_50 = excluded.rolling_high_50,
         rolling_low_50  = excluded.rolling_low_50,
         drawdown_20     = excluded.drawdown_20,
         autocorr_lag1   = excluded.autocorr_lag1`,
    )
    .run(
      Number(tickRowId),
      features.symbol,
      features.timestamp.toISOString(),
      features.logReturn1,
      features.simpleReturn1,
      features.mom5,
      features.mom10,
      features.mom20,
      features.mom50,
      features.mom100,
      features.rollingStd20,
      features.rollingStd50,
      features.realizedVol20,
      features.volAdjMom20,
      features.volAdjMom50,
      features.rollingMean20,
      features.rollingMean50,
      features.zScore20,
      features.zScore50,
      features.rollingHigh20,
      features.rollingLow20,
      features.rollingHigh50,
      features.rollingLow50,
      features.drawdownPct20,
      features.ac1_20,
    );
}

/**
 * Bulk-upsert features inside a single transaction for speed.
 */
export function bulkUpsertTickFeatures(pairs: { rowId: bigint; features: TickFeatures }[]): void {
  if (pairs.length === 0) return;
  const db = getDb();
  const upsert = db.transaction(() => {
    for (const { rowId, features } of pairs) {
      upsertTickFeatures(rowId, features);
    }
  });
  upsert();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToTick(row: TickRow): Tick {
  const tick: Tick = {
    id: BigInt(row.id),
    symbol: row.symbol,
    epoch: row.epoch,
    timestamp: new Date(row.ts),
    price: row.price,
  };
  if (row.tick_id !== null) {
    (tick as { tickId?: number }).tickId = row.tick_id;
  }
  return tick;
}
