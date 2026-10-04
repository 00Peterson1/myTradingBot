import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { completeHistory, integer, money, volumeUnits } from '../../../src/cfd/ctrader/Protocol.js';
import { CTraderOrderJournal } from '../../../src/cfd/ctrader/OrderJournal.js';
import type { CfdRequest } from '../../../src/cfd/CfdLedger.js';

describe('cTrader protocol and durable dispatch boundary', () => {
  it('converts broker cents, lot sizes and money without accepting unsafe integers', () => {
    expect(volumeUnits(0.01, 10000000)).toBe(100000);
    expect(volumeUnits(0.01, 100)).toBe(1);
    expect(money('123456', 3)).toBe(123.456);
    expect(() => integer('9007199254740993')).toThrow();
    expect(() => integer('1e3')).toThrow();
    expect(() => money(10, undefined)).toThrow();
    expect(() => volumeUnits(0.001, 100)).toThrow();
  });
  it('splits saturated pages without dropping equal timestamps', async () => {
    const calls: number[][] = [];
    const result = await completeHistory(async (from, to) => {
      calls.push([from, to]);
      return from !== to ? { hasMore: true, deal: [{ dealId: 999 }] } : { hasMore: false, deal: [{ dealId: from + 1 }, { dealId: from + 101 }] };
    }, 'deal', 'dealId', 0, 1);
    expect(result.map(row => row.dealId)).toEqual([1, 101, 2, 102]);
    expect(calls).toEqual([[0, 1], [0, 0], [1, 1]]);
    await expect(completeHistory(async () => ({ hasMore: true }), 'deal', 'dealId', 0, 0)).rejects.toThrow('Saturated');
    await expect(completeHistory(async () => ({}), 'deal', 'dealId', 0, 1)).rejects.toThrow('completeness');
  });
  it('refuses changed client IDs and survives adapter reconstruction without permitting a resend', () => {
    const db = new Database(':memory:');
    try {
      const request: CfdRequest = { kind: 'CLOSE', clientOrderId: 'da4e1b88-d4b1-4ad8-9a8d-6aa0fe93fc43', positionId: '11', volumeLots: 0.01 };
      const first = new CTraderOrderJournal(db, '123');
      expect(first.reserve(request, '101', 100)).toBe(true);
      const restarted = new CTraderOrderJournal(db, '123');
      expect(restarted.reserve(request, '101', 100)).toBe(false);
      expect(() => restarted.reserve({ ...request, volumeLots: 0.02 }, '101', 100)).toThrow('reused');
      restarted.bind(request.clientOrderId, '44');
      expect(first.find(request.clientOrderId)?.broker_order_id).toBe('44');
      expect(() => first.bind(request.clientOrderId, '45')).toThrow('mismatch');
    } finally { db.close(); }
  });
});
