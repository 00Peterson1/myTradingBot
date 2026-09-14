import type Database from 'better-sqlite3';
import { z } from 'zod';
import { money, optionSpecificationSchema } from '../types/product.js';
import type { ApprovedSignal } from '../types/signal.js';

const stateSchema = z.enum(['RESERVED', 'SUBMITTING', 'UNKNOWN', 'OPEN', 'SETTLED', 'CANCELLED']);
export type IntentStatus = z.infer<typeof stateSchema>;
const intentSchema = z.object({
  intent_id: z.string(), account_key: z.string(), signal_id: z.string(),
  symbol: z.string(), strategy: z.string(), specification: z.string(),
  status: stateSchema, reserved_minor: z.number().int(), cost_minor: z.number().int().nullable(),
  contract_id: z.string().nullable(), payout_minor: z.number().int().nullable(),
  profit_minor: z.number().int().nullable(), updated_at: z.string(),
});
export type LedgerIntent = z.infer<typeof intentSchema>;
const accountSchema = z.object({
  account_key: z.string(), account_id: z.string(), mode: z.enum(['DEMO', 'LIVE', 'PAPER', 'BACKTEST']),
  currency: z.literal('USD'), cash_minor: z.number().int().safe(), initial_minor: z.number().int().safe(),
  revision: z.number().int(), risk_json: z.string().nullable(), blocked_reason: z.string().nullable(),
});
export interface OptionsPortfolioSnapshot {
  readonly id: string;
  readonly cashMinor: number;
  readonly reservedMinor: number;
  readonly openCostMinor: number;
  readonly availableMinor: number;
  readonly equityMinor: number;
  readonly blockedReason: string | null;
  readonly intents: readonly LedgerIntent[];
}

/** SQLite-owned account state. Every financial transition and audit event commits atomically. */
export class OptionsLedger {
  readonly accountKey: string;

  constructor(
    private readonly db: Database.Database,
    accountId: string,
    mode: 'DEMO' | 'LIVE' | 'PAPER' | 'BACKTEST',
    openingBalance: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!accountId.trim()) throw new Error('Account ID is required');
    const openingMinor = money(openingBalance, 'USD', 2).minorUnits;
    if (openingMinor < 0) throw new Error('Opening balance must not be negative');
    this.accountKey = `${mode}:OPTIONS:${accountId}`;
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS options_accounts (
        account_key TEXT PRIMARY KEY, account_id TEXT NOT NULL, mode TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency='USD'), cash_minor INTEGER NOT NULL CHECK(cash_minor>=0),
        initial_minor INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        risk_json TEXT, blocked_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS options_intents (
        intent_id TEXT PRIMARY KEY, account_key TEXT NOT NULL REFERENCES options_accounts(account_key),
        signal_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT NOT NULL,
        specification TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('RESERVED','SUBMITTING','UNKNOWN','OPEN','SETTLED','CANCELLED')),
        reserved_minor INTEGER NOT NULL CHECK(reserved_minor>0), cost_minor INTEGER,
        contract_id TEXT, payout_minor INTEGER, profit_minor INTEGER, updated_at TEXT NOT NULL,
        UNIQUE(account_key, signal_id), UNIQUE(account_key, contract_id)
      );
      CREATE TABLE IF NOT EXISTS options_ledger_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        account_key TEXT NOT NULL REFERENCES options_accounts(account_key),
        intent_id TEXT, event_type TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_options_intents_account ON options_intents(account_key, status);
      CREATE TRIGGER IF NOT EXISTS options_events_no_update BEFORE UPDATE ON options_ledger_events
        BEGIN SELECT RAISE(ABORT, 'Ledger events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS options_events_no_delete BEFORE DELETE ON options_ledger_events
        BEGIN SELECT RAISE(ABORT, 'Ledger events are immutable'); END;
    `);
    this.db.transaction(() => {
      const result = this.db.prepare(`INSERT OR IGNORE INTO options_accounts
        (account_key,account_id,mode,currency,cash_minor,initial_minor) VALUES (?,?,?,'USD',?,?)`)
        .run(this.accountKey, accountId, mode, openingMinor, openingMinor);
      if (result.changes) this.event(null, 'ACCOUNT_INITIALIZED', { openingMinor });
    }).immediate();
  }

  private account(): z.infer<typeof accountSchema> {
    return accountSchema.parse(this.db.prepare('SELECT * FROM options_accounts WHERE account_key=?').get(this.accountKey));
  }

  snapshot(): OptionsPortfolioSnapshot {
    return this.db.transaction(() => {
      const account = this.account();
      const intents = z.array(intentSchema).parse(this.db.prepare('SELECT * FROM options_intents WHERE account_key=? ORDER BY intent_id').all(this.accountKey));
      const reservedMinor = intents.filter(i => ['RESERVED', 'SUBMITTING', 'UNKNOWN'].includes(i.status)).reduce((sum, i) => sum + i.reserved_minor, 0);
      const openCostMinor = intents.filter(i => i.status === 'OPEN').reduce((sum, i) => sum + (i.cost_minor ?? 0), 0);
      return { id: `${this.accountKey}:${String(account.revision)}`, cashMinor: account.cash_minor,
        reservedMinor, openCostMinor, availableMinor: account.cash_minor - reservedMinor,
        equityMinor: account.cash_minor + openCostMinor, blockedReason: account.blocked_reason, intents };
    })();
  }

  /** The risk callback runs under the write lock, so competing approvals observe reservations. */
  reserve(approve: () => ApprovedSignal, fee = 0): LedgerIntent {
    return this.db.transaction(() => {
      const snapshot = this.snapshot();
      if (snapshot.blockedReason) throw new Error(`Portfolio blocked: ${snapshot.blockedReason}`);
      const approved = approve();
      const spec = optionSpecificationSchema.parse(approved.optionSpecification);
      if (approved.signal.product !== 'OPTIONS' || spec.stake.currency !== 'USD' || spec.stake.decimals !== 2) throw new Error('Unsupported reservation product/currency');
      const existing = this.db.prepare('SELECT * FROM options_intents WHERE account_key=? AND signal_id=?').get(this.accountKey, approved.signal.id);
      if (existing) {
        const intent = intentSchema.parse(existing);
        if (intent.specification !== JSON.stringify(spec)) throw new Error('Signal ID reused with a different specification');
        throw new Error('Signal has already been reserved');
      }
      const feeMinor = money(fee, 'USD', 2).minorUnits;
      if (feeMinor < 0) throw new Error('Execution fee cannot be negative');
      if (spec.stake.minorUnits + feeMinor > snapshot.availableMinor) throw new Error('Insufficient available balance');
      const id = crypto.randomUUID();
      this.db.prepare(`INSERT INTO options_intents
        (intent_id,account_key,signal_id,symbol,strategy,specification,status,reserved_minor,updated_at)
        VALUES (?,?,?,?,?,?,'RESERVED',?,?)`).run(id, this.accountKey, approved.signal.id,
          spec.symbol, approved.signal.strategy, JSON.stringify(spec), spec.stake.minorUnits + feeMinor, this.now().toISOString());
      this.event(id, 'OPTION_RESERVED', { specification: spec });
      return this.get(id);
    }).immediate();
  }

  /** Reserved intents were never submitted; in-flight submissions have unknown outcomes. */
  recoverAfterRestart(): void {
    this.db.transaction(() => {
      for (const intent of this.snapshot().intents) {
        if (intent.status === 'RESERVED') this.cancel(intent.intent_id);
        else if (intent.status === 'SUBMITTING') this.markUnknown(intent.intent_id);
      }
    }).immediate();
  }

  get(intentId: string): LedgerIntent {
    return intentSchema.parse(this.db.prepare('SELECT * FROM options_intents WHERE intent_id=? AND account_key=?').get(intentId, this.accountKey));
  }

  markSubmitting(intentId: string): void { this.transition(intentId, ['RESERVED'], 'SUBMITTING'); }
  markUnknown(intentId: string): void {
    this.db.transaction(() => {
      this.transition(intentId, ['SUBMITTING'], 'UNKNOWN');
      this.block('Unknown purchase outcome requires reconciliation');
    }).immediate();
  }
  cancel(intentId: string): void { this.transition(intentId, ['RESERVED'], 'CANCELLED'); }
  rejectPurchase(intentId: string): void { this.transition(intentId, ['SUBMITTING'], 'CANCELLED'); }

  recordPurchase(intentId: string, contractId: string, cost: number, receipt?: unknown): void {
    const costMinor = money(cost, 'USD', 2).minorUnits;
    this.db.transaction(() => {
      const intent = this.get(intentId);
      if (intent.status === 'OPEN' && intent.contract_id === contractId && intent.cost_minor === costMinor) return;
      if (!['SUBMITTING', 'UNKNOWN'].includes(intent.status)) throw new Error('Invalid purchase transition');
      if (!contractId || costMinor <= 0 || costMinor > intent.reserved_minor) throw new Error('Invalid purchase cost/contract');
      this.db.prepare('UPDATE options_accounts SET cash_minor=cash_minor-? WHERE account_key=?').run(costMinor, this.accountKey);
      this.db.prepare("UPDATE options_intents SET status='OPEN',contract_id=?,cost_minor=?,updated_at=? WHERE intent_id=?")
        .run(contractId, costMinor, this.now().toISOString(), intentId);
      this.event(intentId, 'OPTION_OPENED', { contractId, costMinor, receipt });
    }).immediate();
  }

  recordSettlement(intentId: string, payout: number, profit: number, updateRisk?: () => void, details?: unknown): boolean {
    const payoutMinor = money(payout, 'USD', 2).minorUnits;
    const profitMinor = money(profit, 'USD', 2).minorUnits;
    return this.db.transaction(() => {
      const intent = this.get(intentId);
      if (intent.status === 'SETTLED') {
        if (intent.payout_minor !== payoutMinor || intent.profit_minor !== profitMinor) throw new Error('Conflicting duplicate settlement');
        return false;
      }
      if (intent.status !== 'OPEN' || intent.cost_minor === null) throw new Error('Only open contracts can settle');
      if (payoutMinor < 0 || payoutMinor - intent.cost_minor !== profitMinor) throw new Error('Settlement arithmetic does not reconcile');
      this.db.prepare('UPDATE options_accounts SET cash_minor=cash_minor+? WHERE account_key=?').run(payoutMinor, this.accountKey);
      this.db.prepare("UPDATE options_intents SET status='SETTLED',payout_minor=?,profit_minor=?,updated_at=? WHERE intent_id=?")
        .run(payoutMinor, profitMinor, this.now().toISOString(), intentId);
      this.event(intentId, 'OPTION_SETTLED', { payoutMinor, profitMinor, details });
      updateRisk?.();
      return true;
    }).immediate();
  }

  block(reason: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE options_accounts SET blocked_reason=? WHERE account_key=?').run(reason, this.accountKey);
      this.event(null, 'ACCOUNT_BLOCKED', { reason });
    }).immediate();
  }

  confirmReconciled(balance: number, remoteContractIds: readonly string[]): void {
    this.db.transaction(() => {
      const snapshot = this.snapshot();
      if (snapshot.intents.some(intent => ['SUBMITTING', 'UNKNOWN'].includes(intent.status))) {
        throw new Error('Unresolved purchase outcomes require operator reconciliation');
      }
      const local = snapshot.intents.filter(intent => intent.status === 'OPEN').map(intent => intent.contract_id).sort();
      const remote = [...remoteContractIds].sort();
      if (JSON.stringify(local) !== JSON.stringify(remote)) throw new Error('Remote portfolio differs from the ledger');
      if (money(balance, 'USD', 2).minorUnits !== snapshot.cashMinor) throw new Error('Remote cash balance differs from the ledger');
      this.db.prepare('UPDATE options_accounts SET blocked_reason=NULL WHERE account_key=?').run(this.accountKey);
      this.event(null, 'ACCOUNT_RECONCILED', { balanceMinor: snapshot.cashMinor, remoteContractIds });
    }).immediate();
  }

  countPurchasesSince(symbol: string, since: Date): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM options_ledger_events e
      JOIN options_intents i ON i.intent_id=e.intent_id
      WHERE e.account_key=? AND i.symbol=? AND e.event_type='OPTION_OPENED' AND e.occurred_at>?`)
      .get(this.accountKey, symbol, since.toISOString());
    return z.object({ count: z.number().int().nonnegative() }).parse(row).count;
  }

  saveRiskState(state: unknown): void {
    this.db.prepare('UPDATE options_accounts SET risk_json=? WHERE account_key=?').run(JSON.stringify(state), this.accountKey);
  }
  loadRiskState(): unknown {
    const json = this.account().risk_json;
    return json === null ? null : JSON.parse(json) as unknown;
  }

  private transition(intentId: string, from: readonly IntentStatus[], to: IntentStatus): void {
    this.db.transaction(() => {
      const intent = this.get(intentId);
      if (intent.status === to) return;
      if (!from.includes(intent.status)) throw new Error(`Invalid contract transition ${intent.status} to ${to}`);
      this.db.prepare('UPDATE options_intents SET status=?,updated_at=? WHERE intent_id=?').run(to, this.now().toISOString(), intentId);
      this.event(intentId, `OPTION_${to}`, {});
    }).immediate();
  }

  private event(intentId: string | null, type: string, payload: unknown): void {
    this.db.prepare('UPDATE options_accounts SET revision=revision+1 WHERE account_key=?').run(this.accountKey);
    this.db.prepare('INSERT INTO options_ledger_events(account_key,intent_id,event_type,payload,occurred_at) VALUES (?,?,?,?,?)')
      .run(this.accountKey, intentId, type, JSON.stringify(payload), this.now().toISOString());
  }
}
