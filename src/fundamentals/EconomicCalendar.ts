import { z } from 'zod';
import { getDb } from '../data/database/sqlite.js';
import { getEnv } from '../config/env.js';

export type EventImpact = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface EconomicEvent {
  eventId: string;
  country: string;
  currency: string;
  eventName: string;
  scheduledAt: Date;
  impact: EventImpact;
  previous: number | null;
  forecast: number | null;
  actual: number | null;
  affectedPairs: string[];
}

const calendarItemSchema = z.object({
  title: z.string().min(1), country: z.string(), impact: z.string(),
  date: z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid event date'),
  previous: z.string().nullish(), forecast: z.string().nullish(),
});
interface EventRow {
  event_id: string; country: string; currency: string; event_name: string;
  scheduled_at: string; impact: EventImpact; previous: number | null;
  forecast: number | null; actual: number | null; affected_pairs: string;
}
function parseValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export class EconomicCalendar {
  private mapImpact(impactStr: string, title: string): EventImpact {
    const upperTitle = title.toUpperCase();
    if (upperTitle.includes('NON-FARM') || upperTitle.includes('INTEREST RATE') || 
        upperTitle.includes('GDP') || upperTitle.includes('CPI')) {
      return 'CRITICAL';
    }
    const lowerImpact = impactStr.toLowerCase();
    if (lowerImpact === 'high') return 'HIGH';
    if (lowerImpact === 'medium') return 'MEDIUM';
    if (lowerImpact === 'low') return 'LOW';
    return 'LOW';
  }

  async refresh(): Promise<void> {
    const db = getDb();
    
    const row = db.prepare('SELECT MIN(fetched_at) as oldest FROM economic_events').get() as { oldest: string | null } | undefined;
    if (row?.oldest) {
      const oldestDate = new Date(row.oldest);
      const now = new Date();
      if (now.getTime() - oldestDate.getTime() < 3600_000) {
        return;
      }
    }

    try {
      const response = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
      if (!response.ok) throw new Error(`Calendar request failed: ${String(response.status)}`);
      const data = z.array(calendarItemSchema).parse(await response.json());

      const stmt = db.prepare(`
        INSERT INTO economic_events (event_id, country, currency, event_name, scheduled_at, impact, previous, forecast, actual, affected_pairs, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(event_id) DO UPDATE SET
          actual = excluded.actual,
          fetched_at = datetime('now')
      `);

      db.transaction(() => {
        for (const item of data) {
          const impact = this.mapImpact(item.impact, item.title);
          
          const prev = parseValue(item.previous);
          const fore = parseValue(item.forecast);

          const eventId = item.title + '_' + item.date;

          stmt.run(
            eventId,
            item.country,
            item.country,
            item.title,
            new Date(item.date).toISOString(),
            impact,
            prev,
            fore,
            null,
            JSON.stringify([]),
          );
        }
      })();
    } catch (error) {
      throw new Error('Economic calendar refresh failed', { cause: error });
    }
  }

  isBlackout(symbol: string, now: Date = new Date()): boolean {
    let currencies: string[] = [];
    if (symbol.startsWith('frx') && symbol.length === 9) {
      currencies = [symbol.substring(3, 6), symbol.substring(6, 9)];
    }

    if (currencies.length === 0) return false;

    const env = getEnv();
    const criticalHours = env.ECON_BLACKOUT_HOURS_CRITICAL;
    const highHours = env.ECON_BLACKOUT_HOURS_HIGH;

    const db = getDb();
    
    const placeholders = currencies.map(() => '?').join(',');
    const events = db.prepare(`SELECT * FROM economic_events WHERE currency IN (${placeholders})`).all(...currencies) as EventRow[];

    const nowTime = now.getTime();

    for (const row of events) {
      const schedTime = new Date(row.scheduled_at).getTime();
      const diffHours = Math.abs(schedTime - nowTime) / 3600_000;

      if (row.impact === 'CRITICAL' && diffHours <= criticalHours) {
        return true;
      }
      if (row.impact === 'HIGH' && diffHours <= highHours) {
        return true;
      }
    }
    return false;
  }

  getUpcoming(symbol: string, hoursAhead: number): EconomicEvent[] {
    let currencies: string[] = [];
    if (symbol.startsWith('frx') && symbol.length === 9) {
      currencies = [symbol.substring(3, 6), symbol.substring(6, 9)];
    }
    if (currencies.length === 0) return [];

    const db = getDb();
    const placeholders = currencies.map(() => '?').join(',');
    const events = db.prepare(`
      SELECT * FROM economic_events 
      WHERE currency IN (${placeholders}) 
      AND impact IN ('HIGH', 'CRITICAL')
      AND datetime(scheduled_at) > datetime('now')
      AND datetime(scheduled_at) <= datetime('now', ?)
    `).all(...currencies, `+${String(hoursAhead)} hours`) as EventRow[];

    return events.map(row => ({
      eventId: row.event_id,
      country: row.country,
      currency: row.currency,
      eventName: row.event_name,
      scheduledAt: new Date(row.scheduled_at),
      impact: row.impact,
      previous: row.previous,
      forecast: row.forecast,
      actual: row.actual,
      affectedPairs: z.array(z.string()).parse(JSON.parse(row.affected_pairs))
    }));
  }

  getAllEvents(): EconomicEvent[] {
    const db = getDb();
    const events = db.prepare('SELECT * FROM economic_events').all() as EventRow[];
    return events.map(row => ({
      eventId: row.event_id,
      country: row.country,
      currency: row.currency,
      eventName: row.event_name,
      scheduledAt: new Date(row.scheduled_at),
      impact: row.impact,
      previous: row.previous,
      forecast: row.forecast,
      actual: row.actual,
      affectedPairs: z.array(z.string()).parse(JSON.parse(row.affected_pairs))
    }));
  }
}
