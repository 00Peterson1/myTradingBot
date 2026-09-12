import pg from 'pg';
import { getEnv } from '../../config/index.js';
import { createLogger } from '../../monitoring/Logger.js';

const log = createLogger('Database');

let _pool: pg.Pool | null = null;

/**
 * Returns the singleton PostgreSQL connection pool.
 * The pool is created lazily on first call.
 */
export function getPool(): pg.Pool {
  if (_pool !== null) return _pool;

  const env = getEnv();

  _pool = new pg.Pool({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    min: env.DATABASE_POOL_MIN,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: env.DATABASE_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
  });

  _pool.on('connect', () => {
    log.debug('New database connection established');
  });

  _pool.on('error', (err: Error) => {
    log.error({ err }, 'Unexpected database pool error');
  });

  return _pool;
}

/**
 * Tests the database connection.
 * Call this at startup to fail fast if the database is unreachable.
 */
export async function testConnection(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query<{ now: Date }>('SELECT NOW() as now');
    const row = result.rows[0];
    if (!row) throw new Error('Empty result from database health check');
    log.info({ serverTime: row.now }, 'Database connection healthy');
  } finally {
    client.release();
  }
}

/**
 * Closes all pool connections.
 * Call this during graceful shutdown.
 */
export async function closePool(): Promise<void> {
  if (_pool !== null) {
    log.info('Closing database pool');
    await _pool.end();
    _pool = null;
  }
}

/**
 * Executes a function within a database transaction.
 * Commits on success, rolls back on error.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
