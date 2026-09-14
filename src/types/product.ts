import { z } from 'zod';

export const productSchema = z.enum(['OPTIONS', 'CFD']);
export type ProductType = z.infer<typeof productSchema>;
export const durationUnitSchema = z.enum(['t', 's', 'm', 'h', 'd']);
export type DurationUnit = z.infer<typeof durationUnitSchema>;
export const optionContractTypeSchema = z.enum([
  'CALL', 'PUT', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF',
]);
export type OptionContractType = z.infer<typeof optionContractTypeSchema>;

/** Integer minor units. Precision is explicit, never inferred from the market price. */
export const moneySchema = z.object({
  minorUnits: z.number().int().safe(),
  currency: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/),
  decimals: z.number().int().min(0).max(8),
}).strict().readonly();
export type Money = z.infer<typeof moneySchema>;

export function money(amount: number, currency: string, decimals: number): Money {
  if (!Number.isFinite(amount)) throw new Error('Money must be finite');
  const factor = 10 ** decimals;
  const minorUnits = Math.round(amount * factor);
  if (Math.abs(amount * factor - minorUnits) > 1e-6) {
    throw new Error('Amount exceeds declared currency precision');
  }
  return moneySchema.parse({ minorUnits, currency, decimals });
}
export function majorUnits(value: Money): number {
  return value.minorUnits / 10 ** value.decimals;
}
export function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency || left.decimals !== right.decimals) {
    throw new Error('Cannot combine amounts with different currencies or precision');
  }
  return moneySchema.parse({ ...left, minorUnits: left.minorUnits + right.minorUnits });
}

export const optionSpecificationSchema = z.object({
  product: z.literal('OPTIONS'),
  symbol: z.string().min(1),
  contractType: optionContractTypeSchema,
  duration: z.number().int().positive(),
  durationUnit: durationUnitSchema,
  basis: z.literal('stake'),
  stake: moneySchema.refine(value => value.minorUnits > 0, 'Stake must be positive'),
  barrier: z.number().int().min(0).max(9).optional(),
}).strict().superRefine((spec, ctx) => {
  const needsBarrier = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(spec.contractType);
  if (needsBarrier !== (spec.barrier !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Barrier does not match the contract family' });
  }
}).readonly();
export type OptionSpecification = z.infer<typeof optionSpecificationSchema>;

/** CFD positions are deliberately separate from stake/duration-based Options contracts. */
export interface CFDPosition {
  readonly product: 'CFD';
  readonly positionId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly quantity: number;
  readonly entryPrice: number;
  readonly markPrice: number;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly marginUsed: Money;
  readonly unrealizedPnl: Money;
  readonly realizedPnl: Money;
  readonly financing: Money;
}
