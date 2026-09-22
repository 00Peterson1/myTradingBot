import lzma
import struct
import unittest
from market_data.dukascopy import decode_ticks, hour_url, parse_hour


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
