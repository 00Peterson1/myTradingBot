import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { cfdDirection } from './CfdSignal.js';
import { ensureCfdRunnerSchema, type ApprovedCfdStrategy } from './CfdDeployment.js';
import type { CfdExecutionController, ReconcilingCfdBroker } from './CfdExecutionController.js';
import type { CfdLedger } from './CfdLedger.js';
import { sizeCfdLots } from './CfdRisk.js';
import { type CfdOrder, cfdQuoteSchema } from './types.js';
import { contentHash } from '../research/experiments/ExperimentRegistry.js';

/** Serialized, one-approved-symbol demo loop. Unknown fills never cause replacement orders. */
export class CfdDemoRunner {
  private mids: number[] = [];
  private lastTime = 0;
  private pending: { side: 'LONG' | 'SHORT'; timeMs: number } | null = null;
  private busy = false;
  constructor(private readonly db: Database.Database, private readonly broker: ReconcilingCfdBroker,
    private readonly controller: CfdExecutionController, private readonly ledger: CfdLedger,
    private readonly approved: () => ApprovedCfdStrategy, private readonly stopped: () => boolean,
    private readonly now: () => number = Date.now) { ensureCfdRunnerSchema(db); }
  reset(): void { this.mids = []; this.lastTime = 0; this.pending = null; this.controller.disconnected(); }
  private record(accountId: string, kind: string, detail: unknown): string {
    this.db.prepare('INSERT INTO cfd_runner_events(account_id,kind,detail,time_ms) VALUES (?,?,?,?)').run(accountId, kind, JSON.stringify(detail), this.now());
    return kind;
  }
  async step(): Promise<string> {
    if (this.busy) throw new Error('Overlapping CFD runner step');
    this.busy = true;
    try {
      const strategy = this.approved(), { deployment, config } = strategy;
      if (this.stopped()) { this.pending = null; return this.record(deployment.accountId, 'PAUSED', { reason: 'Stop file or shutdown signal; broker stops remain active' }); }
      const recovered = await this.controller.reconcile();
      if (recovered.unresolved) { this.pending = null; return this.record(deployment.accountId, 'RECONCILIATION_REQUIRED', recovered); }
      const instrument = await this.broker.instrument(deployment.symbol);
      if (contentHash(instrument) !== contentHash(strategy.dataset.instrument)) throw new Error('Current CFD contract differs from validated contract');
      const quote = cfdQuoteSchema.parse(await this.broker.quote(deployment.symbol));
      if (quote.timeMs > this.now() || this.now() - quote.timeMs > config.risk.maxQuoteAgeMs) throw new Error('Stale runner quote');
      if (quote.timeMs <= this.lastTime) return 'WAITING_FOR_NEW_QUOTE';
      const gap = this.lastTime > 0 && quote.timeMs - this.lastTime > config.maxGapMs;
      if (gap) { this.mids = []; this.pending = null; }
      this.lastTime = quote.timeMs;
      const snapshot = await this.broker.snapshot();
      if (snapshot.account.mode !== 'DEMO' || snapshot.account.id !== deployment.accountId || snapshot.account.currency !== strategy.dataset.accountCurrency) throw new Error('Runner requires the approved demo identity/currency');
      const owned = snapshot.positions.filter(position => this.controller.ownsPosition(position.id));
      for (const position of owned) {
        const intent = this.ledger.intents().find(item => {
          const order = this.ledger.order(item);
          if (order?.hypothesisId !== deployment.hypothesisId || !item.result_json) return false;
          const result = JSON.parse(item.result_json) as { fill?: { positionId: string } };
          return result.fill?.positionId === position.id;
        });
        if (!intent) throw new Error('A different bot hypothesis owns an open position; explicit recovery required');
        const prior = this.db.prepare('SELECT held_quotes,last_quote_ms FROM cfd_runner_positions WHERE account_id=? AND position_id=?').get(deployment.accountId, position.id) as { held_quotes: number; last_quote_ms: number } | undefined;
        // If a crash happened after fill but before its holding counter was saved, reduce risk by closing.
        const held = prior ? prior.held_quotes + (quote.timeMs > prior.last_quote_ms ? 1 : 0) : config.maxHoldingQuotes;
        this.db.prepare('INSERT INTO cfd_runner_positions VALUES (?,?,?,?,?) ON CONFLICT(account_id,position_id) DO UPDATE SET held_quotes=excluded.held_quotes,last_quote_ms=excluded.last_quote_ms').run(deployment.accountId, position.id, deployment.hypothesisId, held, quote.timeMs);
        if (held >= config.maxHoldingQuotes) {
          const result = await this.controller.close(position.id, position.volumeLots);
          this.pending = null; this.mids = [];
          return this.record(deployment.accountId, 'CLOSE_RESULT', result);
        }
      }
      let resultKind = 'WARMING_UP';
      if (this.pending && owned.length === 0) {
        const decision = this.pending; this.pending = null;
        const entry = decision.side === 'LONG' ? quote.ask : quote.bid, sign = decision.side === 'LONG' ? 1 : -1;
        const tick = instrument.priceTick;
        const stopLoss = Math.round((entry - sign * entry * config.stopFraction) / tick) * tick;
        const takeProfit = Math.round((entry + sign * entry * config.stopFraction * config.rewardRisk) / tick) * tick;
        const prototype: CfdOrder = { product: 'CFD', clientOrderId: randomUUID(), hypothesisId: deployment.hypothesisId, symbol: deployment.symbol,
          side: decision.side, volumeLots: 1, stopLoss, takeProfit, maxSlippagePoints: config.slippageTicks, createdAtMs: decision.timeMs };
        const adverseEntry = entry + sign * config.slippageTicks * tick;
        const loss = -(await this.broker.estimateProfit(prototype, adverseEntry, stopLoss));
        const fee = Math.max(config.risk.commissionPerLotRoundTrip, await this.broker.estimateCommission?.(prototype, adverseEntry, stopLoss) ?? 0);
        const budget = Math.min(deployment.maxPlannedLoss, snapshot.account.equity * config.risk.maxRiskFraction);
        const lots = sizeCfdLots(budget, loss + fee, { ...instrument, volumeMax: Math.min(instrument.volumeMax, deployment.maxLots) });
        const order = { ...prototype, volumeLots: lots };
        const boundedLoss = -(await this.broker.estimateProfit(order, adverseEntry, stopLoss)) + Math.max(lots * config.risk.commissionPerLotRoundTrip, await this.broker.estimateCommission?.(order, adverseEntry, stopLoss) ?? 0);
        if (boundedLoss > budget || !Number.isFinite(boundedLoss) || boundedLoss <= 0) throw new Error('Runner order exceeds approved planned-loss cap');
        if (this.stopped() || contentHash(this.approved().deployment) !== contentHash(deployment)) throw new Error('Deployment or stop state changed during sizing');
        const result = await this.controller.open(order);
        if ('fill' in result) this.db.prepare('INSERT OR IGNORE INTO cfd_runner_positions VALUES (?,?,?,?,?)').run(deployment.accountId, result.fill.positionId, deployment.hypothesisId, 0, quote.timeMs);
        resultKind = this.record(deployment.accountId, 'OPEN_RESULT', result);
        if (result.status !== 'REJECTED') { this.mids = []; return resultKind; }
      }
      if (owned.length === 0) {
        const side = cfdDirection(this.mids, (quote.bid + quote.ask) / 2, config);
        if (side) { this.pending = { side, timeMs: quote.timeMs }; resultKind = 'SIGNAL_WAITING_FOR_NEXT_QUOTE'; }
      }
      this.mids.push((quote.bid + quote.ask) / 2);
      if (this.mids.length > config.lookback) this.mids.shift();
      return resultKind;
    } finally { this.busy = false; }
  }
}
