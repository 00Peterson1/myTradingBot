#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('experiments', 'Read-only registry listing. --id HASH --output PATH exports a verified bundle without overwriting files.');
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { readExperimentBundle } from '../research/experiments/ExperimentRegistry.js';
import { print } from '../monitoring/print.js';

try {
  const db = new Database(fileURLToPath(new URL('../../data/trading.db', import.meta.url)), { readonly: true, fileMustExist: true });
  try {
    const id = process.argv[process.argv.indexOf('--id') + 1];
    if (process.argv.includes('--id')) {
      const output = process.argv[process.argv.indexOf('--output') + 1];
      if (!id || !process.argv.includes('--output') || !output) throw new Error('--id and --output require values');
      const bundle = readExperimentBundle(db, id);
      writeFileSync(output, JSON.stringify(bundle, null, 2), { flag: 'wx' });
      print(`Verified experiment exported to ${output}`);
    } else {
      const rows = db.prepare('SELECT id FROM experiment_manifests ORDER BY rowid DESC LIMIT 20').all() as { id: string }[];
      for (const row of rows) print(row.id);
      if (!rows.length) print('No registered experiments.');
    }
  } finally { db.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Registry inspection failed');
  process.exitCode = 1;
}
