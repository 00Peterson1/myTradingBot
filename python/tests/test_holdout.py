import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from spread_model.holdout import claim_holdout


class HoldoutClaims(unittest.TestCase):
    def test_changed_data_alias_and_overlapping_subsets_do_not_reopen_holdout(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            claim_holdout(folder, 'first', 'A-B', ('A', 'B'), 100, 200, {})
            for dataset, pair, symbols, start, end in [('changed', 'A-B', ('A', 'B'), 100, 200),
                                                     ('subset', 'renamed', ('B', 'A'), 120, 150),
                                                     ('edge', 'A-B', ('A', 'B'), 200, 250)]:
                with self.assertRaisesRegex(ValueError, 'overlaps'):
                    claim_holdout(folder, dataset, pair, symbols, start, end, {})
            claim_holdout(folder, 'future', 'A-B', ('A', 'B'), 201, 300, {})
            with sqlite3.connect(folder / 'holdouts.sqlite') as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM claims').fetchone()[0], 2)
                with self.assertRaisesRegex(sqlite3.IntegrityError, 'immutable'):
                    conn.execute('DELETE FROM claims')

    def test_legacy_claim_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'holdout-old.json').write_text(json.dumps({'pair_id': 'A-B'}))
            with self.assertRaisesRegex(ValueError, 'Legacy'):
                claim_holdout(folder, 'new', 'A-B', ('A', 'B'), 100, 200, {})

if __name__ == '__main__': unittest.main()
