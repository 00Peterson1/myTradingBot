#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('migrate', 'Initialize the existing SQLite schema. Does not place orders.');
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from '../data/database/sqlite.js';

try {
  mkdirSync(fileURLToPath(new URL('../../data/', import.meta.url)), { recursive: true });
  const db = getDb();
  if (db.pragma('quick_check', { simple: true }) !== 'ok') {
    throw new Error('SQLite integrity check failed');
  }
  db.close();
  process.stdout.write('Versioned SQLite migrations applied; integrity check passed.\n');
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
}
