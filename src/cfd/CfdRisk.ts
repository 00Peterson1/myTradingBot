import { z } from 'zod';
import { cfdAccountSchema, cfdInstrumentSchema, cfdOrderSchema, cfdQuoteSchema, type CfdAccount, type CfdBroker, type CfdInstrument, type CfdOrder, type CfdQuote } from './types.js';

export const cfdRiskPolicySchema = z.object({ maxRiskFraction: z.number().positive().max(0.02),
  maxMarginFraction: z.number().positive().max(0.5), maxSpreadFraction: z.number().positive().max(0.1),
  maxQuoteAgeMs: z.number().int().positive(), commissionPerLotRoundTrip: z.number().finite().nonnegative(),
  maxPositions: z.number().int().positive(), maxDailyLossFraction: z.number().positive().max(0.2),
}).strict();
export type CfdRiskPolicy = z.infer<typeof cfdRiskPolicySchema>;
export interface CfdApproval { order: CfdOrder; estimatedMargin: number; plannedLoss: number; quote: CfdQuote }

export function validateCfdOrder(orderInput: CfdOrder, instrumentInput: CfdInstrument, quoteInput: CfdQuote, nowMs: number, maxAgeMs: number): void {
  const order = cfdOrderSchema.parse(orderInput), instrument = cfdInstrumentSchema.parse(instrumentInput), quote = cfdQuoteSchema.parse(quoteInput);
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || quote.timeMs > nowMs || nowMs - quote.timeMs > maxAgeMs) throw new Error('CFD quote is stale or from the future');
  if (order.createdAtMs > nowMs || nowMs - order.createdAtMs > maxAgeMs) throw new Error('CFD decision is stale');
  if (order.symbol !== instrument.symbol || order.symbol !== quote.symbol) throw new Error('CFD instrument identity mismatch');
  if (order.volumeLots < instrument.volumeMin || order.volumeLots > instrument.volumeMax || Math.abs(order.volumeLots / instrument.volumeStep - Math.round(order.volumeLots / instrument.volumeStep)) > 1e-7) throw new Error('CFD lot size violates instrument limits');
  for (const price of [order.stopLoss, order.takeProfit]) if (price !== null && Math.abs(price / instrument.priceTick - Math.round(price / instrument.priceTick)) > 1e-6) throw new Error('CFD exit price violates tick size');
  const mark = order.side === 'LONG' ? quote.bid : quote.ask;
  const distance = order.side === 'LONG' ? mark - order.stopLoss : order.stopLoss - mark;
  if (distance <= 0 || distance < Math.max(instrument.minStopDistance, mark * (instrument.minStopDistanceFraction ?? 0))) throw new Error('Invalid CFD stop loss distance');
  if (order.takeProfit !== null) {
    const distance = order.side === 'LONG' ? order.takeProfit - quote.ask : quote.bid - order.takeProfit;
    if (distance <= 0 || distance < Math.max(instrument.minStopDistance, mark * (instrument.minStopDistanceFraction ?? 0))) throw new Error('Invalid CFD take profit distance');
  }
}

/** Risk uses broker account-currency estimates; no hard-coded forex pip values. */
export async function approveCfdOrder(broker: CfdBroker, order: CfdOrder, accountInput: CfdAccount, policyInput: CfdRiskPolicy,
  exposure: { positions: number; reservedMargin: number; reservedRisk: number; dailyStartEquity: number }, clock: number | (() => number) = Date.now): Promise<CfdApproval> {
  const account = cfdAccountSchema.parse(accountInput), policy = cfdRiskPolicySchema.parse(policyInput);
  if (!account.tradeAllowed || !account.hedging || account.equity <= 0) throw new Error('CFD account is not eligible for position-isolated execution');
  const checkFreshness = (): number => {
    const now = typeof clock === 'function' ? clock() : clock;
    if (!Number.isFinite(now) || now - account.timeMs > policy.maxQuoteAgeMs || account.timeMs > now) throw new Error('CFD account snapshot is stale');
    return now;
  };
  checkFreshness();
  if (Object.values(exposure).some(value => !Number.isFinite(value) || value < 0) || exposure.dailyStartEquity <= 0) throw new Error('Invalid CFD exposure state');
  if (exposure.positions >= policy.maxPositions) throw new Error('CFD position limit reached');
  if (account.equity <= exposure.dailyStartEquity * (1 - policy.maxDailyLossFraction)) throw new Error('CFD daily equity loss limit reached');
  const instrument = await broker.instrument(order.symbol);
  const quote = await broker.quote(order.symbol);
  validateCfdOrder(order, instrument, quote, checkFreshness(), policy.maxQuoteAgeMs);
  if ((quote.ask - quote.bid) / quote.bid > policy.maxSpreadFraction) throw new Error('CFD spread exceeds policy');
  const entry = (order.side === 'LONG' ? quote.ask : quote.bid) +
    (order.side === 'LONG' ? 1 : -1) * order.maxSlippagePoints * instrument.priceTick;
  if (entry <= 0) throw new Error('Invalid CFD slippage bound');
  const [margin, profitAtStop, brokerCommission] = await Promise.all([broker.estimateMargin(order, entry), broker.estimateProfit(order, entry, order.stopLoss), broker.estimateCommission?.(order, entry, order.stopLoss) ?? 0]);
  if (!Number.isFinite(brokerCommission) || brokerCommission < 0) throw new Error('Invalid broker commission estimate');
  validateCfdOrder(order, instrument, quote, checkFreshness(), policy.maxQuoteAgeMs);
  const plannedLoss = -profitAtStop + Math.max(brokerCommission, order.volumeLots * policy.commissionPerLotRoundTrip);
  if (!Number.isFinite(plannedLoss) || profitAtStop >= 0 || plannedLoss <= 0 || plannedLoss + exposure.reservedRisk > account.equity * policy.maxRiskFraction) throw new Error('CFD planned stop loss exceeds risk budget');
  if (!Number.isFinite(margin) || margin <= 0 || margin + exposure.reservedMargin > account.freeMargin || account.margin + margin + exposure.reservedMargin > account.equity * policy.maxMarginFraction) throw new Error('CFD margin budget exceeded');
  return { order: cfdOrderSchema.parse(order), estimatedMargin: margin, plannedLoss, quote };
}

/** Round DOWN to the broker volume quantum; a below-minimum budget cannot be rounded up. */
export function sizeCfdLots(riskBudget: number, lossPerLot: number, instrument: CfdInstrument): number {
  cfdInstrumentSchema.parse(instrument);
  if (!Number.isFinite(riskBudget) || riskBudget <= 0 || !Number.isFinite(lossPerLot) || lossPerLot <= 0) throw new Error('Invalid CFD sizing inputs');
  const units = Math.floor(Math.min(instrument.volumeMax, riskBudget / lossPerLot) / instrument.volumeStep + 1e-10);
  const lots = Number((units * instrument.volumeStep).toFixed(8));
  if (lots < instrument.volumeMin || lots * lossPerLot > riskBudget + 1e-8) throw new Error('Risk budget is below broker minimum volume');
  return lots;
}
