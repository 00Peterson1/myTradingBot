"""Bounded, resumable public Dukascopy hourly bid/ask archive downloader.

Quotes only: never invents contract specifications, financing or commissions.
The original compressed files and hashes remain available for exact tick replay.
"""
import argparse
import concurrent.futures
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import json
import lzma
import math
import os
from pathlib import Path
import re
import struct
import time
import urllib.error
import urllib.request

BASE_URL = "https://datafeed.dukascopy.com/datafeed"
MAX_COMPRESSED = 16 * 1024 * 1024
MAX_DECOMPRESSED = 128 * 1024 * 1024


def decode_ticks(data, start_ms, scale):
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("Explicit positive provider price scale required")
    if not data:
        return []
    decoder = lzma.LZMADecompressor(memlimit=MAX_DECOMPRESSED)
    raw = decoder.decompress(data, max_length=MAX_DECOMPRESSED + 1)
    if len(raw) > MAX_DECOMPRESSED or not decoder.eof or decoder.unused_data or len(raw) % 20:
        raise ValueError("Invalid or oversized LZMA tick archive")
    result = []
    previous = -1
    for offset in range(0, len(raw), 20):
        ms, ask, bid, ask_volume, bid_volume = struct.unpack_from('>IIIff', raw, offset)
        if ms >= 3600000 or ms < previous or bid <= 0 or ask < bid:
            raise ValueError("Invalid bid/ask or unordered hourly tick")
        if not all(math.isfinite(v) and v >= 0 for v in (ask_volume, bid_volume)):
            raise ValueError("Invalid tick volume")
        result.append((start_ms + ms, bid / scale, ask / scale))
        previous = ms
    return result


def hour_url(symbol, hour):
    if not re.fullmatch(r'[A-Z0-9]+', symbol):
        raise ValueError("Use the exact provider instrument identifier")
    return f'{BASE_URL}/{symbol}/{hour.year}/{hour.month - 1:02}/{hour.day:02}/{hour.hour:02}h_ticks.bi5'


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as output:
        json.dump(value, output, indent=2, allow_nan=False)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def fetch_hour(symbol, hour, destination, scale):
    url = hour_url(symbol, hour)
    file = destination / f'{hour:%Y%m%d%H}.bi5'
    start_ms = int(hour.timestamp() * 1000)
    base = {'hour': hour.isoformat(), 'url': url, 'file': file.name}
    for attempt in range(3):
        try:
            cached = file.exists()
            if cached:
                if file.stat().st_size > MAX_COMPRESSED:
                    raise ValueError('Oversized cached archive')
                data = file.read_bytes()
            else:
                request = urllib.request.Request(url, headers={'User-Agent': 'CFDResearchArchive/1.0'})
                with urllib.request.urlopen(request, timeout=20) as response:
                    data = response.read(MAX_COMPRESSED + 1)
                if len(data) > MAX_COMPRESSED:
                    raise ValueError('Oversized archive')
            ticks = decode_ticks(data, start_ms, scale)
            if not cached:
                temporary = file.with_suffix('.tmp')
                temporary.write_bytes(data)
                temporary.replace(file)
            return {**base, 'status': 'AVAILABLE' if ticks else 'EMPTY', 'ticks': len(ticks),
                    'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return {**base, 'status': 'UNAVAILABLE', 'reason': 'HTTP 404; not assumed to be a closed session'}
            reason = f'HTTP {error.code}'
        except (OSError, ValueError, lzma.LZMAError) as error:
            reason = str(error)
            if isinstance(error, (ValueError, lzma.LZMAError)):
                break
        if attempt < 2:
            time.sleep(2 ** attempt)
    return {**base, 'status': 'FAILED', 'reason': reason}


def parse_hour(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None or result.utcoffset() != timedelta(0) or result.minute or result.second or result.microsecond:
        raise ValueError('Dates must be UTC whole hours, e.g. 2025-01-01T00:00:00Z')
    return result.astimezone(timezone.utc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--symbol', required=True)
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True, help='Exclusive UTC end hour')
    parser.add_argument('--scale', type=float, required=True, help='Provider integer-price divisor; FX typically 100000, JPY pairs 1000. Never inferred for indices/metals.')
    parser.add_argument('--out', required=True)
    parser.add_argument('--workers', type=int, choices=range(1, 5), default=2)
    parser.add_argument('--snapshot-ms', type=int, default=0, help='0 retains all ticks; positive retains last observed quote per UTC bucket, with its actual timestamp. Raw archives are always retained.')
    args = parser.parse_args()
    start, end = parse_hour(args.start), parse_hour(args.end)
    hours = int((end - start).total_seconds() // 3600)
    if hours < 1 or hours > 8784 or args.snapshot_ms < 0 or args.snapshot_ms > 3600000:
        parser.error('Require 1..8784 hours and snapshot-ms 0..3600000')
    hour_url(args.symbol, start)
    decode_ticks(b'', int(start.timestamp() * 1000), args.scale)
    destination = Path(args.out)
    destination.mkdir(parents=True, exist_ok=True)
    manifest_path = destination / 'manifest.json'
    specification = {'provider': 'Dukascopy', 'symbol': args.symbol, 'start': start.isoformat(), 'endExclusive': end.isoformat(), 'priceScale': args.scale, 'snapshotMs': args.snapshot_ms}
    if manifest_path.exists():
        prior = json.loads(manifest_path.read_text())
        if prior['specification'] != specification:
            parser.error('Output directory belongs to a different acquisition specification')
    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(fetch_hour, args.symbol, start + timedelta(hours=i), destination, args.scale) for i in range(hours)]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            rows.append(future.result())
            if index % 100 == 0:
                print(f'{index}/{hours} hours processed', flush=True)
    rows.sort(key=lambda row: row['hour'])
    manifest = {'version': 1, 'specification': specification, 'hours': rows, 'statuses': {status: sum(row['status'] == status for row in rows) for status in ('AVAILABLE', 'EMPTY', 'UNAVAILABLE', 'FAILED')},
                'costs': 'UNKNOWN: quotes cannot establish Deriv financing, margin, commission or instrument mapping',
                'demoEligible': False, 'liveEligible': False}
    atomic_json(manifest_path, manifest)
    # Never publish a silently truncated export after transport/decode failure.
    if manifest['statuses']['FAILED']:
        raise RuntimeError('Archive has failed hours; inspect manifest and rerun to resume')
    temporary = destination / 'quotes.csv.tmp'
    count = duplicate_times = 0
    with temporary.open('w', newline='') as output:
        writer = csv.writer(output)
        writer.writerow(['timeMs', 'bid', 'ask'])
        pending = None
        for row in rows:
            if row['status'] != 'AVAILABLE':
                continue
            hour = parse_hour(row['hour'])
            for tick in decode_ticks((destination / row['file']).read_bytes(), int(hour.timestamp() * 1000), args.scale):
                # Equal-ms ticks cannot be ordered by the downstream contract. Preserve archives and explicitly count collapsed snapshots.
                same_bucket = pending is not None and (tick[0] // args.snapshot_ms == pending[0] // args.snapshot_ms if args.snapshot_ms else tick[0] == pending[0])
                if same_bucket:
                    duplicate_times += int(tick[0] == pending[0])
                elif pending is not None:
                    writer.writerow(pending)
                    count += 1
                pending = tick
        if pending is not None:
            writer.writerow(pending)
            count += 1
    temporary.replace(destination / 'quotes.csv')
    manifest.update({'exportedQuotes': count, 'sameTimestampCollapses': duplicate_times, 'exportSha256': hashlib.sha256((destination / 'quotes.csv').read_bytes()).hexdigest(), 'exportLimitations': 'Last observed quote per bucket; no interpolation. Intrabucket stop/target paths require the retained raw ticks. Missing hours remain gaps.'})
    atomic_json(manifest_path, manifest)
    print(json.dumps({'manifest': str(manifest_path), 'quotes': count, 'statuses': manifest['statuses']}))


if __name__ == '__main__':
    main()
