import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './pool.js';
import { createLogger } from '../../monitoring/Logger.js';

const log = createLogger('Migrate');
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Runs all SQL migration files in order.
 * Migration files must be named NNN_description.sql where NNN is a zero-padded integer.
 * Migrations already recorded in schema_migrations are skipped.
 */
export async function runMigrations(migrationsDir?: string): Promise<void> {
  const dir = migrationsDir ?? resolve(__dirname, '../../../../migrations');
  const pool = getPool();

  // Ensure the migrations table exists before anything else
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      description TEXT NOT NULL
    )
  `);

  // Get applied versions
  const { rows } = await pool.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  const applied = new Set(rows.map((r) => r.version));

  // Import fs dynamically
  const fs = await import('fs/promises');

  // Read migration files
  const fileNames = await fs.readdir(dir);
  const files = fileNames.filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const match = /(\d+)_/.exec(file);
    if (!match?.[1]) {
      log.warn({ file }, 'Skipping migration file with non-standard name');
      continue;
    }

    const version = parseInt(match[1], 10);
    if (applied.has(version)) {
      log.debug({ version, file }, 'Migration already applied, skipping');
      continue;
    }

    log.info({ version, file }, 'Applying migration');
    const sql = await readFile(file, 'utf-8');
    await pool.query(sql);
    log.info({ version }, 'Migration applied successfully');
  }

  log.info('All migrations up to date');
}
