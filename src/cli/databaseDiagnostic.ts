import Database from 'better-sqlite3';

/** Inspect existing storage without creating a file or applying schema changes. */
export function inspectDatabase(path: string): {
  tables: string[];
  integrity: string[];
  counts: { symbol: string; cnt: number }[];
} {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name);
    return {
      tables,
      integrity: (db.pragma('quick_check') as { quick_check: string }[]).map(row => row.quick_check),
      counts: tables.includes('ticks')
        ? db.prepare('SELECT symbol, COUNT(*) AS cnt FROM ticks GROUP BY symbol ORDER BY cnt DESC').all() as { symbol: string; cnt: number }[]
        : [],
    };
  } finally {
    db.close();
  }
}
