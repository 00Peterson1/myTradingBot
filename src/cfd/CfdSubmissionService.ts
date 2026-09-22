import { canonicalJson } from '../research/experiments/ExperimentRegistry.js';
import { type CfdLedger, cfdRequestSchema, cfdResultSchema, type CfdRequest } from './CfdLedger.js';
import { cfdAccountSchema, type CfdBroker, type CfdOrderResult, type CfdSnapshot } from './types.js';

/** Durable submission boundary. Live accounts always blocked. Demo requires an explicit account and preflight gate. */
export class CfdSubmissionService {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly broker: CfdBroker, private readonly ledger: CfdLedger, private readonly options: {
    demoAccountId?: string; preflight?: (request: CfdRequest, snapshot: CfdSnapshot) => Promise<void>;
  } = {}) {}

  dispatch(input: CfdRequest): Promise<CfdOrderResult> {
    // Copy/validate before queuing: caller mutation cannot alter the durable request.
    const request = cfdRequestSchema.parse(input);
    const result = this.queue.then(() => this.execute(request));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async execute(request: CfdRequest): Promise<CfdOrderResult> {
    const snapshot = await this.broker.snapshot();
    const account = cfdAccountSchema.parse(snapshot.account);
    if (account.mode !== 'PAPER' && !(account.mode === 'DEMO' && this.options.demoAccountId === account.id && this.options.preflight)) throw new Error('CFD broker execution is disabled until reconciliation and eligibility gates are integrated');
    if (canonicalJson({ provider: account.provider, id: account.id, mode: account.mode }) !== this.ledger.accountKey) throw new Error('CFD journal account identity mismatch');
    const reservation = this.ledger.begin(request);
    const clientId = reservation.intent.client_id;
    if (!reservation.created) {
      if (reservation.intent.result_json) return cfdResultSchema.parse(JSON.parse(reservation.intent.result_json) as unknown);
      return { status: 'UNKNOWN', reason: 'Existing durable submission must be reconciled; it will not be resent' };
    }
    try { await this.options.preflight?.(request, await this.broker.snapshot()); }
    catch {
      const result = { status: 'REJECTED', reason: 'Preflight rejected before broker submission' } as const;
      this.ledger.record(clientId, result);
      return result;
    }
    try {
      const result = request.kind === 'OPEN' ? await this.broker.submit(request.order) : await this.broker.close(request.positionId, request.volumeLots, request.clientOrderId);
      this.ledger.record(clientId, result);
      return cfdResultSchema.parse(result);
    } catch {
      // An exception may occur AFTER the broker accepted an order. Never turn it into a rejection.
      const result = { status: 'UNKNOWN', reason: 'Submission or durable result recording failed; broker reconciliation required' } as const;
      this.ledger.record(clientId, result);
      return result;
    }
  }
}
