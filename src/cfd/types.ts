import { z } from 'zod';

const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
export const cfdInstrumentSchema = z.object({
  symbol: z.string().min(1), category: z.enum(['forex', 'metals', 'commodities', 'crypto', 'stock_indices', 'stocks']),
  contractSize: positive, volumeMin: positive, volumeMax: positive, volumeStep: positive,
  priceTick: positive, minStopDistance: nonnegative, profitCurrency: z.string().min(3),
}).strict().refine(row => row.volumeMin <= row.volumeMax, 'Invalid volume limits');
export const cfdQuoteSchema = z.object({ symbol: z.string().min(1), bid: positive, ask: positive, timeMs: z.number().int().nonnegative() })
  .strict().refine(row => row.ask >= row.bid, 'Crossed bid/ask quote');
export const cfdAccountSchema = z.object({ id: z.string().min(1), provider: z.string().min(1), mode: z.enum(['DEMO', 'LIVE', 'PAPER']),
  currency: z.string().min(3), balance: z.number().finite(), equity: z.number().finite(), margin: nonnegative,
  freeMargin: z.number().finite(), tradeAllowed: z.boolean(), hedging: z.boolean(), timeMs: z.number().int().nonnegative() }).strict();
export const cfdOrderSchema = z.object({ product: z.literal('CFD'), clientOrderId: z.string().uuid(), hypothesisId: z.string().min(1),
  symbol: z.string().min(1), side: z.enum(['LONG', 'SHORT']), volumeLots: positive, stopLoss: positive, takeProfit: positive.nullable(),
  maxSlippagePoints: z.number().int().nonnegative(), createdAtMs: z.number().int().nonnegative(),
}).strict();
export const cfdPositionSchema = z.object({ id: z.string().min(1), symbol: z.string().min(1), side: z.enum(['LONG', 'SHORT']),
  volumeLots: positive, entryPrice: positive, currentPrice: positive, stopLoss: positive.nullable(), takeProfit: positive.nullable(),
  unrealizedPnl: z.number().finite(), financing: z.number().finite(), clientOrderId: z.string().nullable(),
}).strict();
export type CfdInstrument = z.infer<typeof cfdInstrumentSchema>;
export type CfdQuote = z.infer<typeof cfdQuoteSchema>;
export type CfdAccount = z.infer<typeof cfdAccountSchema>;
export type CfdOrder = z.infer<typeof cfdOrderSchema>;
export type CfdPosition = z.infer<typeof cfdPositionSchema>;
export interface CfdSnapshot { account: CfdAccount; positions: CfdPosition[] }
export interface CfdFill { orderId: string; positionId: string; filledLots: number; price: number; commission: number; timeMs: number }
export type CfdOrderResult = { status: 'FILLED' | 'PARTIAL'; fill: CfdFill } | { status: 'REJECTED'; reason: string } | { status: 'UNKNOWN'; reason: string };

/** Monetary estimates and snapshots are in the authenticated account currency. */
export interface CfdBroker {
  snapshot(): Promise<CfdSnapshot>;
  instrument(symbol: string): Promise<CfdInstrument>;
  quote(symbol: string): Promise<CfdQuote>;
  estimateMargin(order: CfdOrder, entryPrice: number): Promise<number>;
  estimateProfit(order: CfdOrder, entryPrice: number, exitPrice: number): Promise<number>;
  submit(order: CfdOrder): Promise<CfdOrderResult>;
  close(positionId: string, volumeLots: number, clientOrderId: string): Promise<CfdOrderResult>;
}
