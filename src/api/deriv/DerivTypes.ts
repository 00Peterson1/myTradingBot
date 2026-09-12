import { z } from 'zod';

// ---------------------------------------------------------------------------
// Active Symbol from Deriv API
// ---------------------------------------------------------------------------
export const ActiveSymbolSchema = z.object({
  symbol: z.string(),
  display_name: z.string(),
  market: z.string(),
  submarket: z.string(),
  pip: z.number().optional(),
  is_trading_suspended: z.number().transform((v) => v === 1),
  exchange_is_open: z.number().transform((v) => v === 1),
});

export type ActiveSymbol = z.infer<typeof ActiveSymbolSchema>;

// ---------------------------------------------------------------------------
// Tick from Deriv subscription
// ---------------------------------------------------------------------------
export const DerivTickSchema = z.object({
  ask: z.number().optional(),
  bid: z.number().optional(),
  epoch: z.number(),
  id: z.number().optional(),
  pip_size: z.number().optional(),
  quote: z.number(),
  symbol: z.string(),
});

export type DerivTick = z.infer<typeof DerivTickSchema>;

// ---------------------------------------------------------------------------
// Tick History response
// ---------------------------------------------------------------------------
export const TickHistoryResponseSchema = z.object({
  history: z.object({
    prices: z.array(z.number()),
    times: z.array(z.number()),
  }),
  pip_size: z.number().optional(),
  subscription: z
    .object({
      id: z.string(),
    })
    .optional(),
});

export type TickHistoryResponse = z.infer<typeof TickHistoryResponseSchema>;

// ---------------------------------------------------------------------------
// Proposal response (for binary options)
// ---------------------------------------------------------------------------
export const ProposalSchema = z.object({
  ask_price: z.number(),
  date_expiry: z.number().optional(),
  date_start: z.number().optional(),
  display_value: z.string().optional(),
  id: z.string(),
  longcode: z.string().optional(),
  payout: z.number(),
  spot: z.number().optional(),
  spot_time: z.number().optional(),
});

export type Proposal = z.infer<typeof ProposalSchema>;

// ---------------------------------------------------------------------------
// Buy response
// ---------------------------------------------------------------------------
export const BuyResponseSchema = z.object({
  balance_after: z.number(),
  buy_price: z.number(),
  contract_id: z.number(),
  longcode: z.string().optional(),
  payout: z.number(),
  purchase_time: z.number(),
  shortcode: z.string().optional(),
  start_time: z.number().optional(),
  transaction_id: z.number(),
});

export type BuyResponse = z.infer<typeof BuyResponseSchema>;

// ---------------------------------------------------------------------------
// Profit table entry (contract history)
// ---------------------------------------------------------------------------
export const ContractSchema = z.object({
  contract_id: z.number(),
  contract_type: z.string(),
  buy_price: z.number(),
  sell_price: z.number().optional(),
  profit: z.number().optional(),
  profit_percentage: z.number().optional(),
  status: z.string(),
  date_start: z.number(),
  date_expiry: z.number().optional(),
  date_settlement: z.number().optional(),
  underlying: z.string(),
  longcode: z.string().optional(),
  shortcode: z.string().optional(),
  is_expired: z.number().optional(),
  is_settleable: z.number().optional(),
  is_sold: z.number().optional(),
});

export type Contract = z.infer<typeof ContractSchema>;

// ---------------------------------------------------------------------------
// Generic Deriv API response wrapper
// ---------------------------------------------------------------------------
export interface DerivResponse<T = unknown> {
  msg_type: string;
  echo_req: Record<string, unknown>;
  req_id?: number;
  error?: {
    code: string;
    message: string;
  };
  [key: string]: unknown;
  // The actual payload is keyed by msg_type
  _payload?: T;
}

// ---------------------------------------------------------------------------
// Account balance
// ---------------------------------------------------------------------------
export const BalanceSchema = z.object({
  balance: z.number(),
  currency: z.string(),
  id: z.string().optional(),
  loginid: z.string().optional(),
});

export type Balance = z.infer<typeof BalanceSchema>;
