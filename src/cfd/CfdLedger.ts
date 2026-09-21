import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalJson, contentHash } from '../research/experiments/ExperimentRegistry.js';
import { cfdOrderSchema, type CfdOrder } from './types.js';

export const cfdRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('OPEN'), order: cfdOrderSchema }).strict(),
  z.object({ kind: z.literal('CLOSE'), clientOrderId: z.string().uuid(), positionId: z.string().min(1), volumeLots: z.number().finite().positive() }).strict(),
]);
export type CfdRequest = z.infer<typeof cfdRequestSchema>;
const fillSchema = z.object({ orderId: z.string().min(1), positionId: z.string().min(1), filledLots: z.number().finite().positive(), price: z.number().finite().positive(), commission: z.number().finite().nonnegative(), timeMs: z.number().int().nonnegative() }).strict();
export const cfdResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('FILLED'), fill: fillSchema }).strict(),
  z.object({ status: z.literal('PARTIAL'), fill: fillSchema }).strict(),
  z.object({ status: z.literal('REJECTED'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('UNKNOWN'), reason: z.string().min(1) }).strict(),
]);
const rowSchema = z.object({ account_key: z.string(), client_id: z.string(), request_json: z.string(), request_hash: z.string(),
  status: z.enum(['SUBMITTING', 'UNKNOWN', 'PARTIAL', 'FILLED', 'REJECTED']), result_json: z.string().nullable(), updated_ms: z.number().int() });
export type CfdIntent = z.infer<typeof rowSchema>;

/** Durable submission journal, not a fabricated cash wallet. Broker snapshots own CFD balances. */
export class CfdLedger {
  readonly accountKey: string;
  constructor(private readonly db: Database.Database, identity: { provider: string; id: string; mode: 'PAPER' | 'DEMO' | 'LIVE' }, private readonly clock: () => number = Date.now) {
    const parsed = z.object({ provider: z.string().min(1), id: z.string().min(1), mode: z.enum(['PAPER', 'DEMO', 'LIVE']) }).strict().parse(identity);
    this.accountKey = canonicalJson(parsed);
    ensureCfdSchema(db);
  }
  find(clientId: string): CfdIntent | undefined {
    const row: unknown = this.db.prepare('SELECT * FROM cfd_intents WHERE account_key=? AND client_id=?').get(this.accountKey, clientId);
    return row === undefined ? undefined : rowSchema.parse(row);
  }
  intents(): CfdIntent[] { return z.array(rowSchema).parse(this.db.prepare('SELECT * FROM cfd_intents WHERE account_key=? ORDER BY updated_ms,client_id').all(this.accountKey)); }
  /** Committed before network I/O. An uncertain operation locks further submissions across processes. */
  begin(input: CfdRequest): { created: boolean; intent: CfdIntent } {
    const request = cfdRequestSchema.parse(input), clientId = request.kind === 'OPEN' ? request.order.clientOrderId : request.clientOrderId;
    return this.db.transaction(() => {
      const prior = this.find(clientId);
      if (prior) {
        if (prior.request_hash !== contentHash(request)) throw new Error('CFD client order ID reused with a different request');
        return { created: false, intent: prior };
      }
      if (this.intents().some(row => ['SUBMITTING', 'UNKNOWN', 'PARTIAL'].includes(row.status))) throw new Error('Unresolved CFD submission requires reconciliation');
      this.db.prepare('INSERT INTO cfd_intents VALUES (?,?,?,?,?,?,?)').run(this.accountKey, clientId, canonicalJson(request), contentHash(request), 'SUBMITTING', null, this.clock());
      this.event(clientId, 'SUBMITTING', request);
      const intent = this.find(clientId);
      if (!intent) throw new Error('CFD intent was not persisted');
      return { created: true, intent };
    }).immediate();
  }
  /** Partial execution remains unresolved: it must never authorize a replacement order. */
  record(clientId: string, input: unknown): void {
    const result = cfdResultSchema.parse(input);
    this.db.transaction(() => {
      const intent = this.find(clientId);
      if (!intent || !['SUBMITTING', 'UNKNOWN'].includes(intent.status)) throw new Error('CFD intent is not awaiting a submission result');
      const request = cfdRequestSchema.parse(JSON.parse(intent.request_json) as unknown);
      const volume = request.kind === 'OPEN' ? request.order.volumeLots : request.volumeLots;
      if ('fill' in result) {
        if (result.fill.filledLots > volume + 1e-8 || (result.status === 'FILLED' && Math.abs(result.fill.filledLots - volume) > 1e-8)) throw new Error('CFD fill volume does not match request');
        if (request.kind === 'CLOSE' && result.fill.positionId !== request.positionId) throw new Error('CFD close position identity mismatch');
      }
      this.db.prepare('UPDATE cfd_intents SET status=?,result_json=?,updated_ms=? WHERE account_key=? AND client_id=?').run(result.status, canonicalJson(result), this.clock(), this.accountKey, clientId);
      this.event(clientId, result.status, result);
    }).immediate();
  }
  /** Call only after acquiring exclusive runner ownership; never resend recovered submissions. */
  recover(): number {
    return this.db.transaction(() => {
      const pending = this.intents().filter(row => row.status === 'SUBMITTING');
      for (const row of pending) this.record(row.client_id, { status: 'UNKNOWN', reason: 'Process interrupted before a durable broker result' });
      return pending.length;
    }).immediate();
  }
  order(intent: CfdIntent): CfdOrder | null {
    const request = cfdRequestSchema.parse(JSON.parse(intent.request_json) as unknown);
    return request.kind === 'OPEN' ? request.order : null;
  }
  private event(clientId: string, kind: string, payload: unknown): void {
    this.db.prepare('INSERT INTO cfd_events(account_key,client_id,kind,payload_json,time_ms) VALUES (?,?,?,?,?)').run(this.accountKey, clientId, kind, canonicalJson(payload), this.clock());
  }
}

export function ensureCfdSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cfd_intents (
    account_key TEXT NOT NULL, client_id TEXT NOT NULL, request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('SUBMITTING','UNKNOWN','PARTIAL','FILLED','REJECTED')),
    result_json TEXT, updated_ms INTEGER NOT NULL, PRIMARY KEY(account_key,client_id));
    CREATE TABLE IF NOT EXISTS cfd_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_key TEXT NOT NULL, client_id TEXT NOT NULL,
    kind TEXT NOT NULL, payload_json TEXT NOT NULL, time_ms INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS cfd_events_no_update BEFORE UPDATE ON cfd_events BEGIN SELECT RAISE(ABORT,'CFD events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS cfd_events_no_delete BEFORE DELETE ON cfd_events BEGIN SELECT RAISE(ABORT,'CFD events are append-only'); END;`);
}
