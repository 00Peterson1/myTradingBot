import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EconomicCalendar } from '../../../src/fundamentals/EconomicCalendar.js';

let db: Database.Database;
vi.mock('../../../src/data/database/sqlite.js', () => ({ getDb: (): Database.Database => db }));

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE economic_events (
    event_id TEXT PRIMARY KEY, country TEXT, currency TEXT, event_name TEXT,
    scheduled_at TEXT, impact TEXT, previous REAL, forecast REAL, actual REAL,
    affected_pairs TEXT, fetched_at TEXT
  )`);
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });

describe('economic calendar input boundary', () => {
  it('stores valid rows, preserves missing values, and queries upcoming events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      title: 'CPI', country: 'USD', impact: 'High',
      date: new Date(Date.now() + 3600_000).toISOString(), previous: '', forecast: '2.5%',
    }]))));
    const calendar = new EconomicCalendar();
    await calendar.refresh();
    const events = calendar.getUpcoming('frxEURUSD', 2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ previous: null, forecast: 2.5, affectedPairs: [], impact: 'CRITICAL' });
  });
  it('rejects malformed external rows before writing any events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{ title: {} }]))));
    const calendar = new EconomicCalendar();
    await expect(calendar.refresh()).rejects.toThrow('Economic calendar refresh failed');
    expect(calendar.getAllEvents()).toEqual([]);
  });
  it('reports provider HTTP failure instead of silently treating it as fresh data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(new EconomicCalendar().refresh()).rejects.toThrow('Economic calendar refresh failed');
  });
});
