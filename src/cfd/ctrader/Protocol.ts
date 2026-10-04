import { z } from 'zod';

export type Wire = Record<string, unknown>;
export const object = (value: unknown): Wire => z.record(z.unknown()).parse(value);
export const rows = (value: unknown): Wire[] => z.array(z.record(z.unknown())).parse(value ?? []);
export function integer(value: unknown): number {
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) throw new Error('Invalid protocol integer');
  return z.number().int().safe().parse(typeof value === 'string' ? Number(value) : value);
}
export const positive = (value: unknown): number => z.number().finite().positive().parse(value);
export function identifier(value: unknown): string {
  const n = integer(value); if (n <= 0) throw new Error('Invalid protocol identifier'); return String(n);
}
export function money(value: unknown, digits: unknown): number {
  const precision = integer(digits);
  if (precision < 0 || precision > 12) throw new Error('Invalid monetary precision');
  return integer(value) / 10 ** precision;
}
export function enumIs(value: unknown, number: number, name: string): boolean { return value === number || value === name; }
export function volumeUnits(lots: number, lotSize: number): number {
  const value = positive(lots) * positive(lotSize), rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || Math.abs(value - rounded) > 1e-6) throw new Error('Volume cannot be represented in broker units');
  return rounded;
}

/** Exhaust inclusive time ranges without dropping rows sharing a timestamp. Fail closed on a saturated millisecond. */
export async function completeHistory(fetch: (from: number, to: number) => Promise<Wire>, field: string,
  idField: string, from: number, to: number, maxRequests = 2048): Promise<Wire[]> {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error('Invalid history interval');
  const result = new Map<string, Wire>(); let count = 0;
  async function visit(start: number, end: number): Promise<void> {
    if (++count > maxRequests) throw new Error('History request budget exceeded; completeness not established');
    const response = await fetch(start, end);
    if (typeof response.hasMore !== 'boolean') throw new Error('Missing history completeness flag');
    if (response.hasMore) {
      if (start === end) throw new Error('Saturated history timestamp; manual reconciliation required');
      const middle = Math.floor((start + end) / 2);
      await visit(start, middle); await visit(middle + 1, end); return;
    }
    for (const row of rows(response[field])) {
      const id = identifier(row[idField]);
      if (result.has(id)) throw new Error('Duplicate deal/order across history pages');
      result.set(id, row);
    }
  }
  // Bound individual requests to seven days even on long-lived accounts.
  for (let start = from; start <= to; start += 604800000) await visit(start, Math.min(to, start + 604799999));
  return [...result.values()];
}
