import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type CfdLedger, cfdRequestSchema, cfdResultSchema, type CfdRequest } from './CfdLedger.js';
import { type CfdEvidence, type CfdClosureEvidence } from './CfdReconciliation.js';
import { CfdSubmissionService } from './CfdSubmissionService.js';
import { approveCfdOrder, cfdRiskPolicySchema, type CfdRiskPolicy } from './CfdRisk.js';
import { cfdAccountSchema, cfdPositionSchema, type CfdBroker, type CfdOrder, type CfdOrderResult, type CfdSnapshot } from './types.js';
import { canonicalJson } from '../research/experiments/ExperimentRegistry.js';

export interface ReconcilingCfdBroker extends CfdBroker {
  /** null means unknown, not rejected. Implementations must exhaust pagination before claiming completeness. */
  orderEvidence(request: CfdRequest): Promise<CfdEvidence | null>;
  positionClosureEvidence?(positionId: string): Promise<CfdClosureEvidence | null>;
}
/** Explicit bounded demo verification, not an eligible-strategy automatic trading runner. */
export class CfdExecutionController {
  private readonly service: CfdSubmissionService;
  private readonly policy: CfdRiskPolicy;
  private ready = false;
  private baselineDay: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly owner = randomUUID();
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { this.ledger.acquireRunner(this.owner); return operation(); });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  constructor(private readonly broker: ReconcilingCfdBroker, private readonly ledger: CfdLedger,
    policy: CfdRiskPolicy, private readonly dailyStartEquity: number,
    private readonly options: { demoAccountId?: string; authorizeHypothesis: (order: CfdOrder) => Promise<void>; now: () => number }) {
    this.policy = cfdRiskPolicySchema.parse(policy);
    if (!Number.isFinite(dailyStartEquity) || dailyStartEquity <= 0) throw new Error('A persisted or broker-verified daily equity baseline is required');
    this.service = new CfdSubmissionService(broker, ledger, { ...(options.demoAccountId ? { demoAccountId: options.demoAccountId } : {}), preflight: (request, snapshot): Promise<void> => this.preflight(request, snapshot) });
  }
  dispose(): void { this.ready = false; this.ledger.releaseRunner(this.owner); }
  private isReady(): boolean { return this.ready; }
  disconnected(): void { this.ready = false; }
  reconcile(): Promise<{ unresolved: number; positions: number }> { return this.exclusive(() => this.performReconcile()); }
  private async performReconcile(): Promise<{ unresolved: number; positions: number }> {
    this.ready = false;
    for (const intent of this.ledger.unresolved()) {
      const request = cfdRequestSchema.parse(JSON.parse(intent.request_json) as unknown);
      const evidence = await this.broker.orderEvidence(request);
      if (evidence) {
        const now = this.options.now();
        if (evidence.observedAtMs > now || now - evidence.observedAtMs > this.policy.maxQuoteAgeMs) throw new Error('Stale broker reconciliation response');
        this.ledger.acquireRunner(this.owner);
        this.ledger.reconcile(intent.client_id, evidence);
      }
    }
    const snapshot = await this.broker.snapshot();
    for (const [positionId, remaining] of this.ownedVolumes()) if (remaining > 1e-8 && !snapshot.positions.some(position => position.id === positionId) && !this.ledger.positionClosed(positionId)) {
      const evidence = await this.broker.positionClosureEvidence?.(positionId);
      if (evidence) {
        const now = this.options.now();
        if (evidence.observedAtMs > now || now - evidence.observedAtMs > this.policy.maxQuoteAgeMs) throw new Error('Stale position closure evidence');
        this.ledger.acquireRunner(this.owner);
        this.ledger.recordPositionClosure(evidence);
      }
    }
    this.ledger.acquireRunner(this.owner);
    this.checkSnapshot(snapshot, true);
    if (this.baselineDay === null) {
      this.baselineDay = Math.floor(snapshot.account.timeMs / 86400000);
      this.ledger.dailyBaseline(snapshot.account.timeMs, this.dailyStartEquity);
    }
    const unresolved = this.ledger.unresolved().length;
    this.ready = unresolved === 0;
    return { unresolved, positions: snapshot.positions.length };
  }
  open(order: CfdOrder): Promise<CfdOrderResult> {
    return this.exclusive(() => {
      if (!this.ready) return Promise.reject(new Error('CFD reconciliation required before opening positions'));
      return this.service.dispatch({ kind: 'OPEN', order });
    });
  }
  close(positionId: string, volumeLots: number, clientOrderId = randomUUID()): Promise<CfdOrderResult> {
    return this.exclusive(() => {
      if (!this.ready) return Promise.reject(new Error('CFD reconciliation required before closing positions'));
      return this.service.dispatch({ kind: 'CLOSE', positionId, volumeLots, clientOrderId });
    });
  }
  private ownedVolumes(): Map<string, number> {
    const volumes = new Map<string, number>();
    for (const intent of this.ledger.intents()) {
      const request = cfdRequestSchema.parse(JSON.parse(intent.request_json) as unknown);
      const result = intent.result_json ? cfdResultSchema.parse(JSON.parse(intent.result_json) as unknown) : null;
      if (result && 'fill' in result) volumes.set(result.fill.positionId, (volumes.get(result.fill.positionId) ?? 0) + (request.kind === 'OPEN' ? 1 : -1) * result.fill.filledLots);
    }
    return volumes;
  }
  private checkSnapshot(snapshot: CfdSnapshot, allowRiskReduction = false): void {
    const account = cfdAccountSchema.parse(snapshot.account), positions = z.array(cfdPositionSchema).parse(snapshot.positions), now = this.options.now();
    if (canonicalJson({ provider: account.provider, id: account.id, mode: account.mode }) !== this.ledger.accountKey) throw new Error('CFD account identity mismatch');
    if (account.mode === 'LIVE' || (account.mode === 'DEMO' && account.id !== this.options.demoAccountId)) throw new Error('CFD account mode is not authorized');
    if (account.timeMs > now || now - account.timeMs > this.policy.maxQuoteAgeMs) throw new Error('Stale CFD snapshot');
    if (!account.hedging || !account.tradeAllowed || new Set(positions.map(row => row.id)).size !== positions.length) throw new Error('Unsupported or invalid CFD position snapshot');
    for (const [id, remaining] of this.ownedVolumes()) if (remaining > 1e-8 && !positions.some(position => position.id === id) && !this.ledger.positionClosed(id)) throw new Error('Owned CFD position disappeared without confirmed exit history');
    const knownPositions = new Map<string, CfdOrder>();
    for (const intent of this.ledger.intents()) {
      const order = this.ledger.order(intent);
      const result = intent.result_json ? cfdResultSchema.parse(JSON.parse(intent.result_json) as unknown) : null;
      if (order && result !== null && 'fill' in result) knownPositions.set(result.fill.positionId, order);
    }
    for (const position of positions) {
      if (this.ledger.positionClosed(position.id)) throw new Error('Closed CFD position reappeared');
      const order = knownPositions.get(position.id);
      if (position.symbol !== order?.symbol || position.side !== order.side || position.volumeLots > order.volumeLots + 1e-8) throw new Error('Foreign or mismatched CFD position');
      if (!allowRiskReduction && (position.stopLoss === null || (position.side === 'LONG' ? position.stopLoss < order.stopLoss - 1e-8 : position.stopLoss > order.stopLoss + 1e-8))) throw new Error('Unprotected CFD position or widened stop loss');
    }
  }
  private async preflight(request: CfdRequest, snapshot: CfdSnapshot): Promise<void> {
    if (!this.ready) throw new Error('CFD connection has not been reconciled');
    this.checkSnapshot(snapshot, request.kind === 'CLOSE');
    if (request.kind === 'CLOSE') {
      const position = snapshot.positions.find(row => row.id === request.positionId);
      if (!position || request.volumeLots > position.volumeLots) throw new Error('Invalid close position or volume');
      const instrument = await this.broker.instrument(position.symbol);
      if (Math.abs(request.volumeLots / instrument.volumeStep - Math.round(request.volumeLots / instrument.volumeStep)) > 1e-7) throw new Error('Invalid close volume step');
      if (!this.isReady()) throw new Error('CFD disconnected during close preflight');
      this.ledger.acquireRunner(this.owner);
      return;
    }
    if (Math.floor(snapshot.account.timeMs / 86400000) !== this.baselineDay) throw new Error('New UTC day requires a verified daily equity baseline and new controller');
    await this.options.authorizeHypothesis(request.order);
    let reservedRisk = 0;
    for (const position of snapshot.positions) {
      if (position.stopLoss === null) throw new Error('Missing position protection');
      const order: CfdOrder = { ...request.order, symbol: position.symbol, side: position.side, volumeLots: position.volumeLots, stopLoss: position.stopLoss };
      const loss = await this.broker.estimateProfit(order, position.currentPrice, position.stopLoss);
      if (!Number.isFinite(loss)) throw new Error('Invalid open-position risk estimate');
      reservedRisk += Math.max(0, -loss) + position.volumeLots * this.policy.commissionPerLotRoundTrip;
    }
    await approveCfdOrder(this.broker, request.order, snapshot.account, this.policy, { positions: snapshot.positions.length, reservedMargin: 0, reservedRisk, dailyStartEquity: this.ledger.dailyBaseline(snapshot.account.timeMs, this.dailyStartEquity) }, this.options.now);
    this.ledger.acquireRunner(this.owner);
    if (!this.isReady()) throw new Error('CFD disconnected during preflight');
  }
}
