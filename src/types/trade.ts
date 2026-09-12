/**
 * Trade lifecycle status.
 */
export type TradeStatus =
  | 'PENDING' // Signal approved, awaiting execution
  | 'OPEN' // Contract purchased, awaiting resolution
  | 'SETTLED' // Contract resolved (won or lost)
  | 'CANCELLED' // Cancelled before execution
  | 'ERROR'; // Execution error

/**
 * Trading mode — results MUST NEVER be mixed across modes.
 * Backtest and paper results cannot justify live trading.
 * Demo results are the only justified basis for live consideration.
 */
export type TradingMode = 'BACKTEST' | 'PAPER' | 'DEMO' | 'LIVE';

/**
 * A trade record — complete lifecycle from signal to settlement.
 */
export interface Trade {
  readonly id: string; // UUID
  readonly signalId: string; // UUID of the Signal that generated this trade
  readonly mode: TradingMode;
  readonly symbol: string;
  readonly strategy: string;
  readonly direction: 'BUY' | 'SELL';
  readonly contractType: 'CALL' | 'PUT'; // Binary options contract type
  readonly contractDuration: number;
  readonly contractDurationUnit: 't' | 's' | 'm' | 'h' | 'd';
  readonly contractId?: string; // Deriv contract ID (null for paper/backtest)
  readonly stakeAmount: number;
  readonly entryPrice: number;
  readonly exitPrice: number | null; // null = not yet settled
  readonly entryTime: Date;
  readonly exitTime: Date | null;
  readonly status: TradeStatus;
  readonly riskNotes?: string;
}

/**
 * Result of a settled trade — merged with Trade for storage.
 */
export interface TradeResult {
  readonly profit: number; // Positive = won, negative = lost
  readonly won: boolean;
  readonly returnPct: number; // profit / stakeAmount
  readonly exitPrice: number;
  readonly exitTime: Date;
  readonly status: 'SETTLED';
}

/**
 * Daily P&L summary per symbol and strategy.
 */
export interface DailyPnL {
  readonly date: Date;
  readonly mode: TradingMode;
  readonly symbol: string;
  readonly strategy: string;
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly totalStaked: number;
  readonly totalProfit: number;
  readonly winRate: number;
}
