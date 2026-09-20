"""Atomic, append-only claims for prospective pair-model test intervals."""
import json
import math
import sqlite3
from datetime import datetime, timezone


def claim_holdout(folder, dataset_id, pair_id, symbols, start, end, settings):
    if not all(math.isfinite(value) for value in (start, end)) or start > end:
        raise ValueError('Invalid holdout interval')
    # Symbol identity, rather than a user-chosen pair alias, owns the interval.
    instruments = json.dumps(sorted(symbols))
    folder.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(folder / 'holdouts.sqlite', timeout=30) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS claims (dataset_id TEXT PRIMARY KEY, instruments TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, content TEXT NOT NULL)')
        for operation in ('UPDATE', 'DELETE'):
            conn.execute(f"CREATE TRIGGER IF NOT EXISTS no_{operation} BEFORE {operation} ON claims BEGIN SELECT RAISE(ABORT, 'Holdout claims are immutable'); END")
        conn.execute('BEGIN IMMEDIATE')
        # Old markers lack temporal identity; do not silently forget their usage.
        for marker in folder.glob('holdout-*.json'):
            old = json.loads(marker.read_text())
            if old.get('registry_version') != 1 and old.get('pair_id') == pair_id:
                raise ValueError('Legacy holdout use requires review before this pair can be evaluated again')
        if conn.execute('SELECT 1 FROM claims WHERE instruments=? AND start<=? AND end>=?', (instruments, end, start)).fetchone():
            raise ValueError('Holdout overlaps previously consumed observations')
        content = {'registry_version': 1, 'dataset_id': dataset_id, 'pair_id': pair_id, 'symbols': list(symbols),
                   'start': start, 'end': end, 'settings': settings, 'claimed_at': datetime.now(timezone.utc).isoformat()}
        conn.execute('INSERT INTO claims VALUES (?,?,?,?,?)', (dataset_id, instruments, start, end, json.dumps(content, allow_nan=False)))
    # Failure here still leaves the interval consumed in SQLite.
    with (folder / f'holdout-{dataset_id}.json').open('x') as marker:
        json.dump(content, marker, allow_nan=False)
