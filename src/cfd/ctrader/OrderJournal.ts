import type Database from 'better-sqlite3';
import { z } from 'zod';
import { contentHash } from '../../research/experiments/ExperimentRegistry.js';
import type { CfdRequest } from '../CfdLedger.js';

const rowSchema = z.object({ account_id: z.string(), client_id: z.string(), request_hash: z.string(),
  symbol_id: z.string(), lot_size: z.number().positive(), submitted_ms: z.number().int(), broker_order_id: z.string().nullable() });
export type BrokerIntent = z.infer<typeof rowSchema>;
/** Separate durable wire dispatch marker. Losing an acknowledgement must never permit another send. */
export class CTraderOrderJournal {
  constructor(private readonly db: Database.Database, private readonly accountId: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS ctrader_dispatches (
      account_id TEXT NOT NULL, client_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      symbol_id TEXT NOT NULL, lot_size REAL NOT NULL, submitted_ms INTEGER NOT NULL, broker_order_id TEXT,
      PRIMARY KEY(account_id,client_id), UNIQUE(account_id,broker_order_id));`);
  }
  find(clientId: string): BrokerIntent | undefined {
    const row: unknown = this.db.prepare('SELECT * FROM ctrader_dispatches WHERE account_id=? AND client_id=?').get(this.accountId, clientId);
    return row === undefined ? undefined : rowSchema.parse(row);
  }
  reserve(request: CfdRequest, symbolId: string, lotSize: number): boolean {
    const clientId = request.kind === 'OPEN' ? request.order.clientOrderId : request.clientOrderId;
    return this.db.transaction(() => {
      const prior = this.find(clientId);
      if (prior) {
        if (prior.request_hash !== contentHash(request)) throw new Error('Broker client identity reused');
        return false;
      }
      this.db.prepare('INSERT INTO ctrader_dispatches VALUES (?,?,?,?,?,?,NULL)').run(this.accountId, clientId, contentHash(request), symbolId, lotSize, Date.now());
      return true;
    }).immediate();
  }
  bind(clientId: string, brokerId: string): void {
    this.db.transaction(() => {
      const prior = this.find(clientId);
      if (!prior || (prior.broker_order_id && prior.broker_order_id !== brokerId)) throw new Error('Broker acknowledgement identity mismatch');
      this.db.prepare('UPDATE ctrader_dispatches SET broker_order_id=? WHERE account_id=? AND client_id=?').run(brokerId, this.accountId, clientId);
    }).immediate();
  }
}
