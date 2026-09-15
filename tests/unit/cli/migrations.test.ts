import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../../src/data/database/migrations.js';
describe('versioned schema migrations', () => {
  it('adopts existing data and is idempotent across all schemas', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      db.prepare('INSERT INTO symbols(symbol) VALUES (?)').run('TEST');
      runMigrations(db);
      expect(db.prepare('SELECT symbol FROM symbols').all()).toEqual([{ symbol: 'TEST' }]);
      expect(db.prepare('SELECT version FROM schema_migrations').all()).toHaveLength(3);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='options_accounts'").get()).toBeDefined();
    } finally { db.close(); }
  });
  it('rolls back failed schema writes and version markers', () => {
    const db = new Database(':memory:');
    try {
      expect(() => { runMigrations(db, [{ version: 1, name: 'fail', apply: (conn): void => { conn.exec('CREATE TABLE temporary_data(x)'); throw new Error('fixture'); } }]); }).toThrow('fixture');
      expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='temporary_data'").get()).toBeUndefined();
      runMigrations(db);
      expect(() => { runMigrations(db, []); }).toThrow('incompatible');
    } finally { db.close(); }
  });
});
