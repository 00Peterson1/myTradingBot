/**
 * Database Pool — SQLite Adapter
 *
 * The original PostgreSQL pool has been replaced with a SQLite-backed
 * implementation. This file re-exports the SQLite helpers so any code that
 * previously imported from here continues to work without changes.
 *
 * To switch back to PostgreSQL in future (e.g. production):
 *   - Replace this file with the original pg-based implementation.
 *   - Update TickRepository.ts to use pg.Pool again.
 *   - Add docker-compose / managed DB credentials.
 */

export { getDb as getPool, closeDb as closePool } from './sqlite.js';

/**
 * No-op testConnection for SQLite — the file is opened synchronously
 * in getDb(). Kept for API compatibility.
 */
export async function testConnection(): Promise<void> {
  // SQLite opens synchronously when getDb() is first called — nothing to test here.
}

/**
 * No-op withTransaction — use getDb().transaction() directly for SQLite.
 * Kept for API compatibility.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}
