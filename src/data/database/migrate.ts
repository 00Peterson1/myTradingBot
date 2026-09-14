/**
 * Database Migrations — SQLite Edition
 *
 * With SQLite, the schema is managed automatically by sqlite.ts via
 * `CREATE TABLE IF NOT EXISTS` statements. There is no separate migration
 * runner needed — the schema is always up to date when the DB is opened.
 *
 * This file is kept for API compatibility (the `migrate` npm script).
 * For future PostgreSQL production use, restore the pg-based migration
 * logic from git history and point it at the SQL files in /migrations.
 */

import { createLogger } from '../../monitoring/Logger.js';
import { getDb } from './sqlite.js';

const log = createLogger('Migrate');

/**
 * Ensures the SQLite schema is initialised.
 * The schema is already applied by getDb() — this is a no-op validation call.
 */
export function runMigrations(_migrationsDir?: string): Promise<void> {
  getDb(); // triggers schema creation if DB didn't exist yet
  log.info('SQLite schema is up to date (managed by sqlite.ts)');
  return Promise.resolve();
}
