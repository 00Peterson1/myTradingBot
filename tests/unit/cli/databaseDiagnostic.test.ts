import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { inspectDatabase } from '../../../src/cli/databaseDiagnostic.js';

describe('database diagnostics', () => {
  it('does not create missing storage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
    try {
      const path = join(dir, 'missing.db');
      expect(() => inspectDatabase(path)).toThrow();
      expect(existsSync(path)).toBe(false);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('reports the existing schema without migrating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
    try {
      const path = join(dir, 'test.db');
      const db = new Database(path);
      db.exec("CREATE TABLE ticks (symbol TEXT); INSERT INTO ticks VALUES ('TEST'), ('TEST')");
      db.close();
      expect(inspectDatabase(path)).toEqual({ tables: ['ticks'], integrity: ['ok'], counts: [{ symbol: 'TEST', cnt: 2 }] });
      expect(inspectDatabase(path).tables).not.toContain('market_profiles');
    } finally { rmSync(dir, { recursive: true }); }
  });
});
