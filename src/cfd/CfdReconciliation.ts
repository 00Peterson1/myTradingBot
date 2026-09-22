import { z } from 'zod';
import { contentHash } from '../research/experiments/ExperimentRegistry.js';
import { cfdRequestSchema, type CfdRequest } from './CfdLedger.js';
import type { CfdOrderResult } from './types.js';

/** A complete cumulative order/deal response, never inferred from absence in open positions. */
export const cfdEvidenceSchema = z.object({
  accountKey: z.string().min(1), clientOrderId: z.string().uuid(), requestHash: z.string().min(1),
  brokerOrderId: z.string().min(1), observedAtMs: z.number().int().nonnegative(),
  state: z.enum(['WORKING', 'FILLED', 'CANCELLED', 'REJECTED']), completeDealHistory: z.literal(true),
  deals: z.array(z.object({ id: z.string().min(1), positionId: z.string().min(1), volumeLots: z.number().finite().positive(),
    price: z.number().finite().positive(), commission: z.number().finite().nonnegative(), timeMs: z.number().int().nonnegative() }).strict()),
}).strict();
export type CfdEvidence = z.infer<typeof cfdEvidenceSchema>;
export function reconcileCfdEvidence(requestInput: CfdRequest, accountKey: string, input: unknown): { evidence: CfdEvidence; result: CfdOrderResult; terminal: boolean } {
  const request = cfdRequestSchema.parse(requestInput), evidence = cfdEvidenceSchema.parse(input);
  const clientId = request.kind === 'OPEN' ? request.order.clientOrderId : request.clientOrderId;
  if (evidence.accountKey !== accountKey || evidence.clientOrderId !== clientId || evidence.requestHash !== contentHash(request)) throw new Error('CFD reconciliation identity mismatch');
  if (new Set(evidence.deals.map(deal => deal.id)).size !== evidence.deals.length) throw new Error('Duplicate CFD deal identity');
  if (new Set(evidence.deals.map(deal => deal.positionId)).size > 1) throw new Error('CFD order spans multiple positions; manual reconciliation required');
  if (evidence.deals.some(deal => deal.timeMs > evidence.observedAtMs || (request.kind === 'OPEN' && deal.timeMs < request.order.createdAtMs) || (request.kind === 'CLOSE' && deal.positionId !== request.positionId))) throw new Error('Invalid CFD deal position/time');
  const requested = request.kind === 'OPEN' ? request.order.volumeLots : request.volumeLots;
  const volume = evidence.deals.reduce((sum, deal) => sum + deal.volumeLots, 0);
  if (volume > requested + 1e-8 || (evidence.state === 'FILLED' && Math.abs(volume - requested) > 1e-8) || (evidence.state === 'REJECTED' && volume > 0)) throw new Error('CFD order state contradicts executed volume');
  const terminal = evidence.state !== 'WORKING';
  const first = evidence.deals[0];
  if (!first) return { evidence, terminal, result: terminal ? { status: 'REJECTED', reason: `Broker confirmed ${evidence.state} without fills` } : { status: 'UNKNOWN', reason: 'Broker order is still working' } };
  return { evidence, terminal, result: { status: terminal && Math.abs(volume - requested) <= 1e-8 ? 'FILLED' : 'PARTIAL',
    fill: { orderId: evidence.brokerOrderId, positionId: first.positionId, filledLots: volume,
      price: evidence.deals.reduce((sum, deal) => sum + deal.price * deal.volumeLots, 0) / volume,
      commission: evidence.deals.reduce((sum, deal) => sum + deal.commission, 0), timeMs: Math.max(...evidence.deals.map(deal => deal.timeMs)) } } };
}

/** Authoritative complete position history, including broker-triggered stop/target exits. */
export const cfdClosureEvidenceSchema = z.object({
  accountKey: z.string().min(1), positionId: z.string().min(1), openingClientOrderId: z.string().uuid(),
  symbol: z.string().min(1), side: z.enum(['LONG', 'SHORT']), state: z.literal('CLOSED'), completeDealHistory: z.literal(true),
  observedAtMs: z.number().int().nonnegative(),
  deals: z.array(z.object({ id: z.string().min(1), kind: z.enum(['OPEN', 'CLOSE']), volumeLots: z.number().finite().positive(), price: z.number().finite().positive(), timeMs: z.number().int().nonnegative() }).strict()).min(2),
}).strict();
export type CfdClosureEvidence = z.infer<typeof cfdClosureEvidenceSchema>;
