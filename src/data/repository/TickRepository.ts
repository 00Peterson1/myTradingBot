import type pg from 'pg';
import { getPool } from '../database/pool.js';
import { TICK_INSERT_BATCH_SIZE } from '../../config/constants.js';
import { createLogger } from '../../monitoring/Logger.js';
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

export async function upsertSymbol(sym: SymbolRecord): Promise<void> {
  await getPool().query(
    `INSERT INTO symbols (symbol, display_name, market, submarket, instrument_type, pip_size, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (symbol) DO UPDATE SET
       display_name   = EXCLUDED.display_name,
       last_seen_at   = NOW(),
       is_active      = TRUE`,
    [
      sym.symbol,
      sym.displayName,
      sym.market,
      sym.submarket,
      sym.instrumentType,
      sym.pipSize ?? null,
    ],
  );
}

export async function getActiveSymbols(): Promise<string[]> {
  const { rows } = await getPool().query<{ symbol: string }>(
    'SELECT symbol FROM symbols WHERE is_active = TRUE ORDER BY symbol',
  );
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
 * Silently ignores duplicates (ON CONFLICT DO NOTHING).
 * Returns the stored tick ID or null if it was a duplicate.
 */
export async function insertTick(tick: TickInsert, client?: pg.PoolClient): Promise<bigint | null> {
  const ts = new Date(tick.epoch * 1000);
  const db = client ?? getPool();

  const result = await db.query<{ id: string }>(
    `INSERT INTO ticks (symbol, epoch, ts, price, tick_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (symbol, epoch, price) DO NOTHING
     RETURNING id`,
    [tick.symbol, tick.epoch, ts, tick.price, tick.tickId ?? null],
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (!row) return null;
  return BigInt(row.id);
}

/**
 * Bulk-inserts ticks in batches of TICK_INSERT_BATCH_SIZE.
 * Returns count of actually inserted (non-duplicate) ticks.
 */
export async function bulkInsertTicks(ticks: TickInsert[]): Promise<number> {
  if (ticks.length === 0) return 0;

  let inserted = 0;
  const pool = getPool();

  for (let i = 0; i < ticks.length; i += TICK_INSERT_BATCH_SIZE) {
    const batch = ticks.slice(i, i + TICK_INSERT_BATCH_SIZE);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const tick of batch) {
        const id = await insertTick(tick, client);
        if (id !== null) inserted++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    log.debug({ batch: i / TICK_INSERT_BATCH_SIZE + 1, inserted }, 'Batch inserted');
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// Tick Queries
// ---------------------------------------------------------------------------

export interface TickRow {
  id: string;
  symbol: string;
  epoch: number;
  ts: Date;
  price: string;
  tick_id: string | null;
}

/**
 * Fetches the N most recent ticks for a symbol ordered ascending.
 */
export async function getRecentTicks(symbol: string, limit: number): Promise<Tick[]> {
  const { rows } = await getPool().query<TickRow>(
    `SELECT id, symbol, epoch, ts, price, tick_id
     FROM ticks
     WHERE symbol = $1
     ORDER BY ts DESC
     LIMIT $2`,
    [symbol, limit],
  );
  return rows.reverse().map(rowToTick);
}

/**
 * Fetches ticks for a symbol within a time range.
 */
export async function getTicksInRange(symbol: string, from: Date, to: Date): Promise<Tick[]> {
  const { rows } = await getPool().query<TickRow>(
    `SELECT id, symbol, epoch, ts, price, tick_id
     FROM ticks
     WHERE symbol = $1 AND ts >= $2 AND ts <= $3
     ORDER BY ts ASC`,
    [symbol, from, to],
  );
  return rows.map(rowToTick);
}

/**
 * Returns the latest tick timestamp for a symbol (for incremental fetching).
 */
export async function getLatestTickEpoch(symbol: string): Promise<number | null> {
  const { rows } = await getPool().query<{ epoch: number }>(
    'SELECT epoch FROM ticks WHERE symbol = $1 ORDER BY epoch DESC LIMIT 1',
    [symbol],
  );
  return rows[0]?.epoch ?? null;
}

/**
 * Returns tick count for a symbol (for research readiness checks).
 */
export async function getTickCount(symbol: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    'SELECT COUNT(*) as count FROM ticks WHERE symbol = $1',
    [symbol],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Feature Storage
// ---------------------------------------------------------------------------

export async function upsertTickFeatures(features: TickFeatures): Promise<void> {
  await getPool().query(
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
       $1, $2, $3,
       $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13,
       $14, $15,
       $16, $17,
       $18, $19,
       $20, $21, $22, $23,
       $24, $25
     )
     ON CONFLICT (tick_id) DO UPDATE SET
       log_return = EXCLUDED.log_return,
       simple_return = EXCLUDED.simple_return,
       mom_5 = EXCLUDED.mom_5, mom_10 = EXCLUDED.mom_10,
       mom_20 = EXCLUDED.mom_20, mom_50 = EXCLUDED.mom_50,
       mom_100 = EXCLUDED.mom_100,
       rolling_std_20 = EXCLUDED.rolling_std_20,
       rolling_std_50 = EXCLUDED.rolling_std_50,
       realized_vol_20 = EXCLUDED.realized_vol_20,
       vol_adj_mom_20 = EXCLUDED.vol_adj_mom_20,
       vol_adj_mom_50 = EXCLUDED.vol_adj_mom_50,
       rolling_mean_20 = EXCLUDED.rolling_mean_20,
       rolling_mean_50 = EXCLUDED.rolling_mean_50,
       z_score_20 = EXCLUDED.z_score_20,
       z_score_50 = EXCLUDED.z_score_50,
       rolling_high_20 = EXCLUDED.rolling_high_20,
       rolling_low_20 = EXCLUDED.rolling_low_20,
       rolling_high_50 = EXCLUDED.rolling_high_50,
       rolling_low_50 = EXCLUDED.rolling_low_50,
       drawdown_20 = EXCLUDED.drawdown_20,
       autocorr_lag1 = EXCLUDED.autocorr_lag1`,
    [
      features.tickCount.toString(),
      features.symbol,
      features.timestamp,
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
    ],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToTick(row: TickRow): Tick {
  const tick: Tick = {
    id: BigInt(row.id),
    symbol: row.symbol,
    epoch: row.epoch,
    timestamp: row.ts,
    price: parseFloat(row.price),
  };
  if (row.tick_id !== null) {
    (tick as { tickId?: number }).tickId = parseInt(row.tick_id, 10);
  }
  return tick;
}
