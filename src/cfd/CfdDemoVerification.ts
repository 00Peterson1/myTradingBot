import type { ExperimentRegistry } from '../research/experiments/ExperimentRegistry.js';
import type { CfdExecutionController, ReconcilingCfdBroker } from './CfdExecutionController.js';
import type { CfdOrder } from './types.js';
import { cfdOrderSchema } from './types.js';

/** Explicit demo-only round trip. Call only after the adapter is authorized and operator requests verification. */
export async function verifyCfdDemo(broker: ReconcilingCfdBroker, controller: CfdExecutionController,
  orderInput: CfdOrder, limits: { accountId: string; maxVolumeLots: number; reconnect?: () => Promise<void> }, registry: ExperimentRegistry): Promise<Record<string, unknown>> {
  const order = cfdOrderSchema.parse(orderInput);
  const before = await broker.snapshot();
  if (!limits.accountId || !Number.isFinite(limits.maxVolumeLots) || limits.maxVolumeLots <= 0 || order.volumeLots > limits.maxVolumeLots) throw new Error('Demo verification volume limit exceeded');
  if (before.account.mode !== 'DEMO' || before.account.id !== limits.accountId || before.positions.length) throw new Error('Verification requires the designated demo account with no existing positions');
  const attempt = registry.begin({ before, order }, { product: 'CFD', purpose: 'DEMO_EXECUTION_VERIFICATION', limits: { accountId: limits.accountId, maxVolumeLots: limits.maxVolumeLots }, physicalReconnect: Boolean(limits.reconnect) }, 'VALIDATION_STUDY');
  try {
    const ready = await controller.reconcile();
    if (ready.unresolved) throw new Error('Outstanding CFD intents require reconciliation');
    const opened = await controller.open(order);
    if (opened.status !== 'FILLED') throw new Error('Demo open did not produce a confirmed full fill; reconcile before any replacement');
    const during = await broker.snapshot();
    const position = during.positions.find(row => row.id === opened.fill.positionId);
    if (during.account.id !== limits.accountId || during.account.mode !== 'DEMO' || during.positions.length !== 1 || position?.symbol !== order.symbol || position.side !== order.side || Math.abs(position.volumeLots - order.volumeLots) > 1e-8 || position.stopLoss === null) throw new Error('Broker position/protection did not match the demo order');
    // Simulate application losing readiness, then require broker reconciliation before closing.
    controller.disconnected();
    if (limits.reconnect) await limits.reconnect();
    const resumed = await controller.reconcile();
    if (resumed.unresolved) throw new Error('Demo recovery left unresolved orders');
    const closed = await controller.close(position.id, position.volumeLots);
    if (closed.status !== 'FILLED') throw new Error('Demo close outcome uncertain; reconciliation required');
    const after = await broker.snapshot();
    if (after.account.mode !== 'DEMO' || after.account.id !== limits.accountId || after.positions.length || Math.abs(after.account.margin) > 1e-8) throw new Error('Demo account did not return to a flat position state');
    const result = { ...attempt, status: 'ROUND_TRIP_CONFIRMED', provider: before.account.provider, accountId: limits.accountId,
      opened, closed, before, during, after, liveEligible: false,
      limitations: [...(limits.reconnect ? ['Physical reconnect tested after a confirmed fill; mid-fill disconnects require separate fault tests'] : ['Readiness reset is not a physical network-disconnect test']), 'One round trip does not validate profitability, all symbols, or live readiness', 'Adapter identity, broker statements and real disconnect scenarios require independent verification'] };
    registry.finish(attempt.attemptId, 'COMPLETED', result);
    return result;
  } catch (error) {
    const result = { ...attempt, status: 'FAILED_REVIEW_ACCOUNT_AND_RECONCILE', reason: error instanceof Error ? error.message : 'Demo verification failed', liveEligible: false };
    registry.finish(attempt.attemptId, 'FAILED', result);
    return result;
  }
}
