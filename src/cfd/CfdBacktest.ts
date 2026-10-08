import { cfdDirection } from './CfdSignal.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cfdDatasetIdentity, type CfdDataset } from './CfdDataset.js';
import { PaperCfdBroker } from './PaperCfdBroker.js';
import { approveCfdOrder, cfdRiskPolicySchema, sizeCfdLots } from './CfdRisk.js';
import type { CfdOrder } from './types.js';

export const cfdBacktestConfigSchema = z.object({
  family: z.enum(['MOMENTUM', 'MEAN_REVERSION', 'BREAKOUT']), lookback: z.number().int().min(3).max(10000),
  threshold: z.number().positive().max(1), stopFraction: z.number().positive().max(0.2), rewardRisk: z.number().positive().max(10),
  maxHoldingQuotes: z.number().int().positive(), maxGapMs: z.number().int().positive(), initialBalance: z.number().positive(),
  commissionPerLotPerSide: z.number().finite().nonnegative(), slippageTicks: z.number().int().nonnegative(), stopOutMarginRatio: z.number().positive(),
  risk: cfdRiskPolicySchema,
}).strict();
export type CfdBacktestConfig = z.infer<typeof cfdBacktestConfigSchema>;
export interface CfdBacktestResult { symbol: string; datasetId: string; trades: number; tradeNet: number[]; netProfit: number; maxDrawdown: number; rejectedOrders: number; rejectionReasons: Record<string, number>; equity: { timeMs: number; equity: number; margin: number }[]; assumptions: string[] }

/** Single-symbol, next-quote execution. No future data is passed to the decision calculation. */
export async function backtestCfd(input: CfdDataset, configInput: CfdBacktestConfig): Promise<CfdBacktestResult> {
  const { dataset, id } = cfdDatasetIdentity(input), config = cfdBacktestConfigSchema.parse(configInput);
  if (config.risk.commissionPerLotRoundTrip < 2 * config.commissionPerLotPerSide) throw new Error('Risk policy understates CFD commissions');
  const broker = new PaperCfdBroker({ initialBalance: config.initialBalance, currency: dataset.accountCurrency,
    leverage: dataset.quotes[0]?.leverage ?? 1, commissionPerLotPerSide: config.commissionPerLotPerSide, slippageTicks: config.slippageTicks, stopOutMarginRatio: config.stopOutMarginRatio, maxDecisionAgeMs: config.risk.maxQuoteAgeMs }, [dataset.instrument]);
  const rejectionReasons: Record<string, number> = {};
  const rejected = (reason: string): void => { rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1; };
  const mids: number[] = [], tradeNet: number[] = [], equity: CfdBacktestResult['equity'] = [];
  let pending: { side: 'LONG' | 'SHORT'; timeMs: number } | null = null;
  let held = 0, priorFlatBalance = config.initialBalance, peak = config.initialBalance, maxDrawdown = 0, rejectedOrders = 0;
  let dailyEquity = config.initialBalance, day = -1, hadPosition = false;
  for (let i = 0; i < dataset.quotes.length; i++) {
    const row = dataset.quotes[i];
    if (!row) throw new Error('Missing quote');
    const gap = i > 0 && row.timeMs - (dataset.quotes[i - 1]?.timeMs ?? row.timeMs) > config.maxGapMs;
    if (gap) { pending = null; mids.length = 0; }
    broker.advance({ symbol: dataset.instrument.symbol, bid: row.bid, ask: row.ask, timeMs: row.timeMs }, row.profitCurrencyToAccount, row);
    let snapshot = await broker.snapshot();
    const currentDay = Math.floor(row.timeMs / 86400000);
    // The preceding mark, not today's first post-gap equity, anchors the daily loss budget.
    if (currentDay !== day) { dailyEquity = equity.at(-1)?.equity ?? config.initialBalance; day = currentDay; }
    if (snapshot.positions.length) {
      held++;
      const position = snapshot.positions[0];
      if (position && (held >= config.maxHoldingQuotes || i === dataset.quotes.length - 1)) await broker.close(position.id, position.volumeLots, randomUUID());
    }
    snapshot = await broker.snapshot();
    if (hadPosition && !snapshot.positions.length) { tradeNet.push(snapshot.account.balance - priorFlatBalance); priorFlatBalance = snapshot.account.balance; hadPosition = false; }
    if (pending && !snapshot.positions.length && i < dataset.quotes.length - 1) {
      const entry = pending.side === 'LONG' ? row.ask : row.bid;
      const sign = pending.side === 'LONG' ? 1 : -1, tick = dataset.instrument.priceTick;
      const stopLoss = Math.round((entry - sign * entry * config.stopFraction) / tick) * tick;
      const takeProfit = Math.round((entry + sign * entry * config.stopFraction * config.rewardRisk) / tick) * tick;
      try {
        const lossPerLot = Math.abs(entry - stopLoss) * dataset.instrument.contractSize * row.profitCurrencyToAccount + Math.max(2 * config.commissionPerLotPerSide, config.risk.commissionPerLotRoundTrip) + config.slippageTicks * tick * dataset.instrument.contractSize * row.profitCurrencyToAccount;
        const volumeLots = sizeCfdLots(snapshot.account.equity * config.risk.maxRiskFraction, lossPerLot, dataset.instrument);
        const order: CfdOrder = { product: 'CFD', clientOrderId: randomUUID(), hypothesisId: 'CFD_RESEARCH_ONLY', symbol: dataset.instrument.symbol,
          side: pending.side, volumeLots, stopLoss, takeProfit, maxSlippagePoints: config.slippageTicks, createdAtMs: pending.timeMs };
        await approveCfdOrder(broker, order, snapshot.account, config.risk, { positions: 0, reservedMargin: 0, reservedRisk: 0, dailyStartEquity: dailyEquity }, row.timeMs);
        const result = await broker.submit(order);
        if (result.status === 'FILLED') { hadPosition = true; held = 0; } else { rejectedOrders++; rejected(result.status); }
      } catch (error) { rejectedOrders++; rejected(error instanceof Error ? error.message : 'Unknown rejection'); }
    }
    pending = null;
    snapshot = await broker.snapshot();
    peak = Math.max(peak, snapshot.account.equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - snapshot.account.equity) / peak);
    equity.push({ timeMs: row.timeMs, equity: snapshot.account.equity, margin: snapshot.account.margin });
    const mid = (row.bid + row.ask) / 2;
    if (!snapshot.positions.length && mids.length >= config.lookback) {
      const side = cfdDirection(mids, mid, config);
      if (side) pending = { side, timeMs: row.timeMs };
    }
    mids.push(mid);
    if (mids.length > config.lookback) mids.shift();
  }
  return { symbol: dataset.instrument.symbol, datasetId: id, trades: tradeNet.length, tradeNet, netProfit: (await broker.snapshot()).account.balance - config.initialBalance, maxDrawdown, rejectedOrders, rejectionReasons, equity,
    assumptions: ['Next-quote execution; fixed adverse slippage', 'Dated leverage and financing supplied by dataset; not independently broker-verified', 'No liquidity/depth or market-impact model; single-symbol account', 'Gaps reset decisions/warmup; stops fill at next available quote'] };
}
