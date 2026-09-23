import lzma
import struct
import unittest
import io
from contextlib import redirect_stdout, redirect_stderr
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from market_data.dukascopy import decode_ticks, hour_url, parse_hour, fetch_hour, acquisition_rows, main


class HistoricalQuoteTests(unittest.TestCase):
    def test_bid_ask_scaling_and_order(self):
        data = lzma.compress(struct.pack('>IIIff', 100, 110020, 110000, 1, 2))
        self.assertEqual(decode_ticks(data, 1000, 100000), [(1100, 1.1, 1.1002)])
        self.assertIn('/2025/00/06/12h_ticks.bi5', hour_url('EURUSD', parse_hour('2025-01-06T12:00:00Z')))

    def test_rejects_corrupt_crossed_and_unordered_ticks(self):
        for raw in [b'invalid', struct.pack('>IIIff', 100, 10, 20, 1, 2), struct.pack('>IIIff', 3600000, 20, 10, 1, 2), struct.pack('>IIIff', 100, 20, 10, float('nan'), 2)]:
            with self.assertRaises(ValueError):
                decode_ticks(lzma.compress(raw), 1000, 100000)
        with self.assertRaises(ValueError):
            parse_hour('2025-01-01T00:00:00')

    def test_equal_timestamps_preserved_in_raw_decode(self):
        row = struct.pack('>IIIff', 100, 20, 10, 1, 2)
        self.assertEqual(len(decode_ticks(lzma.compress(row + row), 1000, 100000)), 2)

    def test_download_resumes_from_verified_cache_and_refuses_changed_bytes(self):
        payload = lzma.compress(struct.pack('>IIIff', 100, 110020, 110000, 1, 2))
        hour = parse_hour('2025-01-06T12:00:00Z')
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            with patch('market_data.dukascopy.urllib.request.urlopen', return_value=io.BytesIO(payload)) as request:
                first = fetch_hour('EURUSD', hour, destination, 100000)
                self.assertEqual(first['status'], 'AVAILABLE')
                self.assertEqual(first['ticks'], 1)
                request.assert_called_once()
            with patch('market_data.dukascopy.urllib.request.urlopen') as request:
                self.assertEqual(fetch_hour('EURUSD', hour, destination, 100000, first['sha256']), first)
                request.assert_not_called()
                (destination / first['file']).write_bytes(lzma.compress(struct.pack('>IIIff', 100, 110030, 110000, 1, 2)))
                failed = fetch_hour('EURUSD', hour, destination, 100000, first['sha256'])
                self.assertEqual(failed['status'], 'FAILED')
                self.assertIn('SHA256', failed['reason'])

    def test_failed_cache_hash_remains_pinned_across_retries(self):
        hour = parse_hour('2025-01-06T12:00:00Z')
        original = lzma.compress(struct.pack('>IIIff', 100, 110020, 110000, 1, 2))
        changed = lzma.compress(struct.pack('>IIIff', 100, 110030, 110000, 1, 2))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            with patch('market_data.dukascopy.urllib.request.urlopen', return_value=io.BytesIO(original)):
                first = fetch_hour('EURUSD', hour, destination, 100000)
            (destination / first['file']).write_bytes(changed)
            with patch('market_data.dukascopy.urllib.request.urlopen') as request:
                for _ in range(3):
                    failed = fetch_hour('EURUSD', hour, destination, 100000, first['sha256'])
                    self.assertEqual(failed['status'], 'FAILED')
                    self.assertEqual(failed['sha256'], first['sha256'])
                    first = acquisition_rows('EURUSD', [hour], [first], [failed])[0]
                request.assert_not_called()

    def test_unvisited_hours_preserve_identity_without_claiming_reverification(self):
        hour = parse_hour('2025-01-06T12:00:00Z')
        old = {'hour': hour.isoformat(), 'sha256': 'original', 'status': 'AVAILABLE'}
        row = acquisition_rows('EURUSD', [hour], [old], [])[0]
        self.assertEqual(row['status'], 'PENDING')
        self.assertEqual(row['sha256'], 'original')
        changed = {**old, 'sha256': 'changed'}
        row = acquisition_rows('EURUSD', [hour], [old], [changed])[0]
        self.assertEqual(row['status'], 'FAILED')
        self.assertEqual(row['sha256'], 'original')

    def test_expired_budget_never_starts_network_request(self):
        hour = parse_hour('2025-01-06T12:00:00Z')
        with tempfile.TemporaryDirectory() as directory, patch('market_data.dukascopy.urllib.request.urlopen') as request:
            row = fetch_hour('EURUSD', hour, Path(directory), 100000, deadline=0)
            self.assertEqual(row['status'], 'FAILED')
            request.assert_not_called()

    def test_missing_cache_cannot_be_replaced_by_changed_provider_history(self):
        hour = parse_hour('2025-01-06T12:00:00Z')
        changed = lzma.compress(struct.pack('>IIIff', 100, 110030, 110000, 1, 2))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            with patch('market_data.dukascopy.urllib.request.urlopen', return_value=io.BytesIO(changed)):
                failed = fetch_hour('EURUSD', hour, destination, 100000, 'original-hash')
            self.assertEqual(failed['status'], 'FAILED')
            self.assertEqual(failed['sha256'], 'original-hash')
            self.assertFalse((destination / failed['file']).exists())

    def test_empty_archive_does_not_publish_successful_quote_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / '2025010612.bi5').write_bytes(b'')
            argv = ['dukascopy', '--symbol', 'EURUSD', '--start', '2025-01-06T12:00:00Z',
                    '--end', '2025-01-06T13:00:00Z', '--scale', '100000', '--out', directory]
            with patch('sys.argv', argv), redirect_stdout(io.StringIO()), patch('market_data.dukascopy.urllib.request.urlopen') as request:
                with self.assertRaises(SystemExit) as stopped:
                    main()
                self.assertEqual(stopped.exception.code, 2)
                request.assert_not_called()
            self.assertEqual(json.loads((path / 'manifest.json').read_text())['status'], 'INSUFFICIENT_OBSERVATIONS')
            self.assertFalse((path / 'quotes.csv').exists())
            self.assertFalse((path / 'quotes.csv.tmp').exists())

    def test_daily_window_outside_requested_range_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            argv = ['dukascopy', '--symbol', 'EURUSD', '--start', '2025-01-06T00:00:00Z',
                    '--end', '2025-01-06T01:00:00Z', '--scale', '100000', '--utc-hour', '12', '--out', directory]
            with patch('sys.argv', argv), redirect_stderr(io.StringIO()), patch('market_data.dukascopy.urllib.request.urlopen') as request:
                with self.assertRaises(SystemExit) as stopped:
                    main()
                self.assertEqual(stopped.exception.code, 2)
                request.assert_not_called()
