/**
 * Signal direction produced by a strategy.
 * A strategy ONLY produces a signal — it never sizes or executes.
 */
export type SignalDirection = 'BUY' | 'SELL' | 'NONE';

/**
 * Signal produced by a strategy.
 * Passed to the RiskEngine for approval/rejection.
 */
export interface Signal {
  readonly id: string; // UUID
  readonly timestamp: Date;
  readonly symbol: string;
  readonly price: number; // Price at signal generation
  readonly direction: SignalDirection;
  readonly strategy: string; // Strategy name
  readonly confidence: number; // 0–1 (internal, not a guarantee)
  readonly metadata: Record<string, unknown>; // Strategy-specific context
}

/**
 * A risk-approved signal ready for execution.
 * Created by the RiskEngine after approving a Signal.
 */
export interface ApprovedSignal {
  readonly signal: Signal;
  readonly stakeAmount: number; // Amount determined by PositionSizer
  readonly contractDuration: number; // Contract duration value
  readonly contractDurationUnit: 't' | 's' | 'm' | 'h' | 'd'; // Duration unit (t=ticks)
  readonly approvedAt: Date;
  readonly riskNotes: string;
}

/**
 * Reason a signal was rejected by the RiskEngine.
 */
export type RejectionReason =
  | 'MAX_DAILY_LOSS_HIT'
  | 'MAX_DRAWDOWN_HIT'
  | 'MAX_CONSECUTIVE_LOSSES'
  | 'KILL_SWITCH_ACTIVE'
  | 'INSUFFICIENT_CONFIDENCE'
  | 'COOLDOWN_ACTIVE'
  | 'LIVE_TRADING_DISABLED'
  | 'DEMO_TRADING_DISABLED'
  | 'POSITION_SIZE_TOO_SMALL'
  | 'NO_SIGNAL'
  // Context filter
  | 'LLM_POLICY_DIVERGENCE_RISK'  // Gemini flagged central bank policy divergence
  | 'ECONOMIC_BLACKOUT'           // High-impact event within suppression window
  // Pairs trading
  | 'COINTEGRATION_BROKEN'        // Pair no longer statistically cointegrated
  | 'SPREAD_EXPLOSION'            // |z-score| > hard-stop threshold
  // ML model
  | 'ML_LOW_REVERSION_PROB';      // PyTorch sidecar P(reversion) < threshold

/**
 * Result of the RiskEngine evaluation of a signal.
 */
export type RiskDecision =
  | { approved: true; approvedSignal: ApprovedSignal }
  | { approved: false; reason: RejectionReason; signal: Signal };
