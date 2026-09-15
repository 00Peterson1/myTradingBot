import type Database from 'better-sqlite3';
import { initializeLegacySchema } from './legacySchema.js';
import { ensureOptionsSchema } from '../../portfolio/OptionsLedger.js';
import { ensureExperimentSchema } from '../../research/experiments/ExperimentRegistry.js';

export interface Migration { version: number; name: string; apply: (db: Database.Database) => void }
const migrations: readonly Migration[] = [
  { version: 1, name: 'Adopt legacy research schema', apply: initializeLegacySchema },
  { version: 2, name: 'Durable Options accounting', apply: ensureOptionsSchema },
  { version: 3, name: 'Immutable research registry', apply: ensureExperimentSchema },
];

/** One transaction per version; failed DDL and its version marker roll back together. */
export function runMigrations(db: Database.Database, plan: readonly Migration[] = migrations): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  if (plan.some((migration, i) => !Number.isInteger(migration.version) || migration.version < 1 || (i > 0 && migration.version <= (plan[i - 1]?.version ?? 0)))) throw new Error('Invalid migration plan');
  const applied = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all() as { version: number; name: string }[];
  if (applied.some(row => !plan.some(migration => migration.version === row.version && migration.name === row.name))) throw new Error('Database migration history is newer or incompatible');
  for (const migration of plan) {
    db.transaction(() => {
      if (db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(migration.version)) return;
      migration.apply(db);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version, migration.name, new Date().toISOString());
    }).immediate();
  }
}
