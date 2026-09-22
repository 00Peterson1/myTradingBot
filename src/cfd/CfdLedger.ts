import { reconcileCfdEvidence, cfdClosureEvidenceSchema } from './CfdReconciliation.js';
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
      if (this.unresolved().length) throw new Error('Unresolved CFD submission requires reconciliation');
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
  unresolved(): CfdIntent[] {
    return this.intents().filter(row => ['SUBMITTING', 'UNKNOWN', 'PARTIAL'].includes(row.status) &&
      !this.db.prepare('SELECT 1 FROM cfd_reconciliations WHERE account_key=? AND client_id=? AND terminal=1').get(this.accountKey, row.client_id));
  }
  reconcile(clientId: string, input: unknown): void {
    this.db.transaction(() => {
      const intent = this.find(clientId);
      if (!intent) throw new Error('Unknown CFD intent');
      const request = cfdRequestSchema.parse(JSON.parse(intent.request_json) as unknown);
      const { evidence, result, terminal } = reconcileCfdEvidence(request, this.accountKey, input);
      const hash = contentHash(evidence);
      if (this.db.prepare('SELECT 1 FROM cfd_reconciliations WHERE evidence_hash=?').get(hash)) return;
      if (!this.unresolved().some(row => row.client_id === clientId)) throw new Error('CFD intent already has a terminal result');
      const latest = this.db.prepare('SELECT observed_ms,evidence_json FROM cfd_reconciliations WHERE account_key=? AND client_id=? ORDER BY observed_ms DESC LIMIT 1').get(this.accountKey, clientId) as { observed_ms: number; evidence_json: string } | undefined;
      if (latest) {
        if (evidence.observedAtMs < latest.observed_ms) throw new Error('Stale CFD reconciliation evidence');
        const previous = reconcileCfdEvidence(request, this.accountKey, JSON.parse(latest.evidence_json) as unknown).evidence;
        for (const deal of previous.deals) if (!evidence.deals.some(next => next.id === deal.id && contentHash(next) === contentHash(deal))) throw new Error('CFD deal history changed or regressed');
      }
      if (intent.result_json) {
        const previous = cfdResultSchema.parse(JSON.parse(intent.result_json) as unknown);
        if ('fill' in previous && (!('fill' in result) || result.fill.orderId !== previous.fill.orderId || result.fill.positionId !== previous.fill.positionId || result.fill.commission + 1e-8 < previous.fill.commission || result.fill.filledLots + 1e-8 < previous.fill.filledLots)) throw new Error('Reconciliation contradicts previously observed fills');
      }
      this.db.prepare('INSERT INTO cfd_reconciliations VALUES (?,?,?,?,?,?)').run(hash, this.accountKey, clientId, evidence.observedAtMs, terminal ? 1 : 0, canonicalJson(evidence));
      this.db.prepare('UPDATE cfd_intents SET status=?,result_json=?,updated_ms=? WHERE account_key=? AND client_id=?').run(result.status, canonicalJson(result), this.clock(), this.accountKey, clientId);
      this.event(clientId, terminal ? 'RECONCILED_TERMINAL' : 'RECONCILED_WORKING', { evidenceHash: hash, result });
    }).immediate();
  }
  acquireRunner(owner: string, nowMs = Date.now()): void {
    if (!owner || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid CFD runner lease');
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO cfd_runner_leases VALUES (?,?,?) ON CONFLICT(account_key) DO UPDATE SET owner=excluded.owner, expires_ms=excluded.expires_ms WHERE cfd_runner_leases.owner=excluded.owner OR cfd_runner_leases.expires_ms<=?`).run(this.accountKey, owner, nowMs + 60000, nowMs);
      const row = this.db.prepare('SELECT owner FROM cfd_runner_leases WHERE account_key=?').get(this.accountKey) as { owner: string };
      if (row.owner !== owner) throw new Error('Another CFD runner owns this account');
    }).immediate();
  }
  releaseRunner(owner: string): void { this.db.prepare('DELETE FROM cfd_runner_leases WHERE account_key=? AND owner=?').run(this.accountKey, owner); }
  dailyBaseline(timeMs: number, openingEquity: number): number {
    if (!Number.isSafeInteger(timeMs) || timeMs < 0 || !Number.isFinite(openingEquity) || openingEquity <= 0) throw new Error('Invalid CFD daily baseline');
    const day = Math.floor(timeMs / 86400000);
    return this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO cfd_daily_baselines VALUES (?,?,?)').run(this.accountKey, day, openingEquity);
      const row = this.db.prepare('SELECT equity FROM cfd_daily_baselines WHERE account_key=? AND day=?').get(this.accountKey, day) as { equity: number };
      return row.equity;
    }).immediate();
  }
  positionClosed(positionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM cfd_position_closures WHERE account_key=? AND position_id=?').get(this.accountKey, positionId));
  }
  recordPositionClosure(input: unknown): void {
    const evidence = cfdClosureEvidenceSchema.parse(input);
    this.db.transaction(() => {
      const intent = this.find(evidence.openingClientOrderId);
      const order = intent ? this.order(intent) : null;
      const result = intent?.result_json ? cfdResultSchema.parse(JSON.parse(intent.result_json) as unknown) : null;
      if (!order || !result || !('fill' in result) || evidence.accountKey !== this.accountKey || evidence.positionId !== result.fill.positionId || evidence.symbol !== order.symbol || evidence.side !== order.side) throw new Error('CFD closure identity mismatch');
      if (new Set(evidence.deals.map(deal => deal.id)).size !== evidence.deals.length || evidence.deals.some(deal => deal.timeMs < order.createdAtMs || deal.timeMs > evidence.observedAtMs)) throw new Error('Invalid CFD closure deal history');
      const opened = evidence.deals.filter(deal => deal.kind === 'OPEN').reduce((sum, deal) => sum + deal.volumeLots, 0);
      const closed = evidence.deals.filter(deal => deal.kind === 'CLOSE').reduce((sum, deal) => sum + deal.volumeLots, 0);
      if (Math.abs(opened - result.fill.filledLots) > 1e-8 || Math.abs(opened - closed) > 1e-8) throw new Error('CFD closure volumes do not reconcile');
      const prior = this.db.prepare('SELECT evidence_json FROM cfd_position_closures WHERE account_key=? AND position_id=?').get(this.accountKey, evidence.positionId) as { evidence_json: string } | undefined;
      if (prior) {
        const previous = cfdClosureEvidenceSchema.parse(JSON.parse(prior.evidence_json) as unknown);
        if (contentHash(previous.deals) !== contentHash(evidence.deals)) throw new Error('Terminal CFD closure history changed');
        return;
      }
      this.db.prepare('INSERT INTO cfd_position_closures VALUES (?,?,?)').run(this.accountKey, evidence.positionId, canonicalJson(evidence));
      this.event(evidence.openingClientOrderId, 'POSITION_CLOSED_CONFIRMED', evidence);
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
  ensureCfdReconciliationSchema(db);
  ensureCfdPositionSchema(db);
  ensureCfdRunnerSchema(db);
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

export function ensureCfdReconciliationSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cfd_reconciliations (
    evidence_hash TEXT PRIMARY KEY, account_key TEXT NOT NULL, client_id TEXT NOT NULL,
    observed_ms INTEGER NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), evidence_json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS cfd_reconciliations_no_update BEFORE UPDATE ON cfd_reconciliations BEGIN SELECT RAISE(ABORT,'CFD evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS cfd_reconciliations_no_delete BEFORE DELETE ON cfd_reconciliations BEGIN SELECT RAISE(ABORT,'CFD evidence is immutable'); END;`);
}

export function ensureCfdPositionSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cfd_position_closures (account_key TEXT NOT NULL, position_id TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(account_key,position_id));
    CREATE TRIGGER IF NOT EXISTS cfd_position_closures_no_update BEFORE UPDATE ON cfd_position_closures BEGIN SELECT RAISE(ABORT,'CFD closure evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS cfd_position_closures_no_delete BEFORE DELETE ON cfd_position_closures BEGIN SELECT RAISE(ABORT,'CFD closure evidence is immutable'); END;`);
}

export function ensureCfdRunnerSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cfd_runner_leases (account_key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cfd_daily_baselines (account_key TEXT NOT NULL, day INTEGER NOT NULL, equity REAL NOT NULL CHECK(equity>0), PRIMARY KEY(account_key,day));
    CREATE TRIGGER IF NOT EXISTS cfd_daily_baselines_no_update BEFORE UPDATE ON cfd_daily_baselines BEGIN SELECT RAISE(ABORT,'CFD daily baseline is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS cfd_daily_baselines_no_delete BEFORE DELETE ON cfd_daily_baselines BEGIN SELECT RAISE(ABORT,'CFD daily baseline is immutable'); END;`);
}
