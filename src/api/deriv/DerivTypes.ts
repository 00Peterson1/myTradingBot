import { z } from 'zod';

// ---------------------------------------------------------------------------
// Accepts both old API (symbol) and new API (underlying_symbol) response shapes,
// normalising everything to a consistent { symbol, display_name, market } object.
export const ActiveSymbolSchema = z
  .object({
    // New API uses underlying_symbol; legacy uses symbol
    underlying_symbol: z.string().optional(),
    symbol: z.string().optional(),
    // Display name — new API uses underlying_symbol_name
    underlying_symbol_name: z.string().optional(),
    display_name: z.string().optional(),
    market: z.string().optional(),
    submarket: z.string().optional(),
    market_display_name: z.string().optional(),
    submarket_display_name: z.string().optional(),
    subgroup: z.string().optional(),
    underlying_symbol_type: z.string().optional(),
    symbol_type: z.string().optional(),
    exchange_is_open: z.union([z.number(), z.boolean()]).optional(),
    is_trading_suspended: z.union([z.number(), z.boolean()]).optional(),
    pip: z.number().optional(),
    // In active_symbols this is the price increment, not the tick decimal count.
    pip_size: z.number().optional(),
    spot: z.number().optional(),
    spot_time: z.number().optional(),
  })
  .passthrough()
  .transform((data) => ({
    ...data,
    symbol: data.underlying_symbol ?? data.symbol ?? '',
    display_name: data.underlying_symbol_name ?? data.display_name ?? '',
    market: data.market ?? '',
    submarket: data.submarket ?? '',
    symbol_type: data.underlying_symbol_type ?? data.symbol_type,
  }));

export type ActiveSymbol = z.infer<typeof ActiveSymbolSchema>;

export const AvailableContractSchema = z.object({
  contract_type: z.string(),
  min_contract_duration: z.string().optional(),
  max_contract_duration: z.string().optional(),
  contract_category: z.string().optional(),
  expiry_type: z.string().optional(),
  barriers: z.number().optional(),
  barrier: z.string().optional(),
  barrier_category: z.string().optional(),
  start_type: z.string().optional(),
  underlying_symbol: z.string().optional(),
  market: z.string().optional(),
  submarket: z.string().optional(),
}).passthrough();

export type AvailableContract = z.infer<typeof AvailableContractSchema>;

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
