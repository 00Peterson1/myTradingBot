"""Bounded, resumable public Dukascopy hourly bid/ask archive downloader.

Quotes only: never invents contract specifications, financing or commissions.
The original compressed files and hashes remain available for exact tick replay.
"""
import argparse
import concurrent.futures
import csv
import fcntl
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


def fetch_hour(symbol, hour, destination, scale, expected_sha=None, deadline=None):
    url = hour_url(symbol, hour)
    file = destination / f'{hour:%Y%m%d%H}.bi5'
    start_ms = int(hour.timestamp() * 1000)
    base = {'hour': hour.isoformat(), 'url': url, 'file': file.name}
    reason = 'Acquisition time budget exhausted'
    for attempt in range(3):
        if deadline is not None and time.monotonic() >= deadline:
            break
        retry_delay = 2 ** attempt
        try:
            cached = file.exists()
            if cached:
                if file.stat().st_size > MAX_COMPRESSED:
                    raise ValueError('Oversized cached archive')
                data = file.read_bytes()
            else:
                request = urllib.request.Request(url, headers={'User-Agent': 'CFDResearchArchive/1.0'})
                with urllib.request.urlopen(request, timeout=20 if deadline is None else max(0.001, min(20, deadline - time.monotonic()))) as response:
                    data = response.read(MAX_COMPRESSED + 1)
                if len(data) > MAX_COMPRESSED:
                    raise ValueError('Oversized archive')
            if expected_sha is not None and hashlib.sha256(data).hexdigest() != expected_sha:
                raise ValueError('Archive differs from recorded SHA256')
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
            if error.code not in (429, 500, 502, 503, 504):
                break
            retry_after = error.headers.get('Retry-After') if error.headers else None
            if retry_after and retry_after.isdecimal():
                retry_delay = max(retry_delay, int(retry_after))
            if retry_delay > 60:
                reason += '; retry deferred by provider'
                break
        except (OSError, ValueError, lzma.LZMAError) as error:
            reason = str(error)
            if isinstance(error, (ValueError, lzma.LZMAError)):
                break
        if attempt < 2:
            if deadline is not None and time.monotonic() + retry_delay >= deadline:
                break
            time.sleep(retry_delay)
    # Retain the original identity even on failure: a retry must never bless changed bytes.
    return {**base, 'status': 'FAILED', 'reason': reason, **({'sha256': expected_sha} if expected_sha is not None else {})}


def parse_hour(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None or result.utcoffset() != timedelta(0) or result.minute or result.second or result.microsecond:
        raise ValueError('Dates must be UTC whole hours, e.g. 2025-01-01T00:00:00Z')
    return result.astimezone(timezone.utc)


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def acquisition_rows(symbol, requested, previous, updated):
    """Unvisited hours stay pending but retain their last recorded content identity."""
    prior = {row['hour']: row for row in previous}
    current = {row['hour']: row for row in updated}
    rows = []
    for hour in requested:
        key = hour.isoformat()
        pending = {**prior.get(key, {}), 'hour': key, 'url': hour_url(symbol, hour),
                   'file': f'{hour:%Y%m%d%H}.bi5', 'status': 'PENDING'}
        row = current.get(key, pending)
        expected = prior.get(key, {}).get('sha256')
        if expected is not None and row.get('sha256') != expected:
            row = {**row, 'status': 'FAILED', 'reason': 'Archive identity differs from prior manifest', 'sha256': expected}
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--symbol', required=True)
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True, help='Exclusive UTC end hour')
    parser.add_argument('--scale', type=float, required=True, help='Provider integer-price divisor; FX typically 100000, JPY pairs 1000. Never inferred for indices/metals.')
    parser.add_argument('--out', required=True)
    parser.add_argument('--max-seconds', type=int, default=300, help='Stop scheduling requests after this wall-clock budget; resume with the same command')
    parser.add_argument('--utc-hour', type=int, choices=range(24), help='Optional predeclared one-hour daily research window; output is explicitly incomplete intraday coverage')
    parser.add_argument('--workers', type=int, choices=range(1, 5), default=2)
    parser.add_argument('--snapshot-ms', type=int, default=0, help='0 retains all ticks; positive retains last observed quote per UTC bucket, with its actual timestamp. Raw archives are always retained.')
    args = parser.parse_args()
    start, end = parse_hour(args.start), parse_hour(args.end)
    hours = int((end - start).total_seconds() // 3600)
    if hours < 1 or hours > 8784 or args.max_seconds < 1 or args.snapshot_ms < 0 or args.snapshot_ms > 3600000:
        parser.error('Require 1..8784 hours and snapshot-ms 0..3600000')
    hour_url(args.symbol, start)
    decode_ticks(b'', int(start.timestamp() * 1000), args.scale)
    destination = Path(args.out)
    destination.mkdir(parents=True, exist_ok=True)
    # OS-managed ownership survives neither crashes nor process termination.
    with (destination / '.acquisition.lock').open('a') as ownership:
        fcntl.flock(ownership, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest_path = destination / 'manifest.json'
        specification = {'provider': 'Dukascopy', 'symbol': args.symbol, 'start': start.isoformat(), 'endExclusive': end.isoformat(), 'priceScale': args.scale, 'snapshotMs': args.snapshot_ms, 'utcHour': args.utc_hour}
        prior = {}
        if manifest_path.exists():
            prior = json.loads(manifest_path.read_text())
            if prior['specification'] != specification:
                parser.error('Output directory belongs to a different acquisition specification')
        requested = [start + timedelta(hours=i) for i in range(hours) if args.utc_hour is None or (start + timedelta(hours=i)).hour == args.utc_hour]
        if not requested:
            parser.error('Selected UTC window contains no requested hours')
        deadline = time.monotonic() + args.max_seconds
        atomic_json(manifest_path, {'version': 1, 'specification': specification, 'status': 'ACQUIRING', 'hours': prior.get('hours', []), 'demoEligible': False, 'liveEligible': False})
        expected_hashes = {row['hour']: row.get('sha256') for row in prior.get('hours', [])}
        rows = []
        # Each worker draws only when ready; shutdown waits for at most the in-flight requests.
        import threading
        iterator = iter(requested)
        lock = threading.Lock()

        def worker():
            while time.monotonic() < deadline:
                with lock:
                    hour = next(iterator, None)
                if hour is None:
                    return
                result = fetch_hour(args.symbol, hour, destination, args.scale, expected_hashes.get(hour.isoformat()), deadline)
                with lock:
                    rows.append(result)
                    if len(rows) % 25 == 0:
                        atomic_json(manifest_path, {'version': 1, 'specification': specification, 'status': 'ACQUIRING',
                                    'hours': acquisition_rows(args.symbol, requested, prior.get('hours', []), rows),
                                    'demoEligible': False, 'liveEligible': False})
                        print(f'{len(rows)}/{len(requested)} hours processed', flush=True)

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(lambda _: worker(), range(args.workers)))
        rows = acquisition_rows(args.symbol, requested, prior.get('hours', []), rows)
        manifest = {'version': 1, 'specification': specification, 'hours': rows, 'statuses': {status: sum(row['status'] == status for row in rows) for status in ('AVAILABLE', 'EMPTY', 'UNAVAILABLE', 'FAILED', 'PENDING')},
                    'costs': 'UNKNOWN: quotes cannot establish Deriv financing, margin, commission or instrument mapping',
                    'demoEligible': False, 'liveEligible': False}
        atomic_json(manifest_path, manifest)
        # Never publish a silently truncated export after transport/decode failure.
        if manifest['statuses']['FAILED'] or manifest['statuses']['PENDING']:
            print(json.dumps({'manifest': str(manifest_path), 'status': 'INCOMPLETE_RESUME_REQUIRED', 'statuses': manifest['statuses']}), flush=True)
            raise SystemExit(2)
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
        if count < 2:
            temporary.unlink()
            manifest['status'] = 'INSUFFICIENT_OBSERVATIONS'
            atomic_json(manifest_path, manifest)
            print(json.dumps({'manifest': str(manifest_path), 'status': manifest['status'], 'quotes': count}), flush=True)
            raise SystemExit(2)
        temporary.replace(destination / 'quotes.csv')
        manifest.update({'exportedQuotes': count, 'sameTimestampCollapses': duplicate_times, 'exportSha256': file_sha256(destination / 'quotes.csv'), 'exportLimitations': 'Last observed quote per bucket; no interpolation. Intrabucket stop/target paths require the retained raw ticks. Missing hours remain gaps.'})
        atomic_json(manifest_path, manifest)
        print(json.dumps({'manifest': str(manifest_path), 'quotes': count, 'statuses': manifest['statuses']}))


if __name__ == '__main__':
    main()
