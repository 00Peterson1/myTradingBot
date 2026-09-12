/**
 * System-wide constants.
 * No magic numbers anywhere else in the codebase.
 */

// ---------------------------------------------------------------------------
// Deriv API Endpoints (new API — developers.deriv.com)
// ---------------------------------------------------------------------------

/** Public WebSocket gateway — market data, no authentication required. */
export const DERIV_WS_PUBLIC = 'wss://api.derivws.com/trading/v1/options/ws/public';

/** REST base URL — account management, OTP issuance. */
export const DERIV_REST_BASE = 'https://api.derivws.com';

/** Trading WebSocket base (demo) — connect to OTP URL, not this directly. */
export const DERIV_WS_DEMO_BASE = 'wss://api.derivws.com/trading/v1/options/ws/demo';

/** Trading WebSocket base (real/live) — connect to OTP URL, not this directly. */
export const DERIV_WS_REAL_BASE = 'wss://api.derivws.com/trading/v1/options/ws/real';

// ---------------------------------------------------------------------------
// Deriv WebSocket — timing
// ---------------------------------------------------------------------------

/** Maximum time to wait for a WebSocket response before timing out. */
export const DERIV_REQUEST_TIMEOUT_MS = 30_000;

/** Base delay for exponential backoff on reconnect (ms). */
export const DERIV_RECONNECT_BASE_DELAY_MS = 1_000;

/** Maximum reconnect delay (ms). */
export const DERIV_RECONNECT_MAX_DELAY_MS = 60_000;

/** Maximum reconnect attempts before giving up (0 = unlimited). */
export const DERIV_RECONNECT_MAX_ATTEMPTS = 0;

/** Heartbeat ping interval (ms). */
export const DERIV_PING_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Feature Engine — rolling window sizes
// These are NOT strategy parameters — they are feature computation windows.
// Strategy parameters are separate and subject to overfitting analysis.
// ---------------------------------------------------------------------------

export const FEATURE_WINDOWS = [5, 10, 20, 50, 100] as const;
export type FeatureWindow = (typeof FEATURE_WINDOWS)[number];

/** Minimum ticks required before feature computation is attempted. */
export const MIN_TICKS_FOR_FEATURES = 100;

// ---------------------------------------------------------------------------
// Research / Statistics
// ---------------------------------------------------------------------------

/** Ljung-Box test default lag count. */
export const LB_DEFAULT_LAGS = 20;

/** Annualization factor for tick-level Sharpe (approximate — synthetic indices
 *  trade continuously so this is 365 * 24 * 3600 ticks if 1 tick/s). */
export const ANNUALIZATION_SECONDS = 365 * 24 * 3600;

/** Minimum trades required to compute a meaningful Sharpe ratio. */
export const MIN_TRADES_FOR_SHARPE = 30;

/** Minimum trades required to claim an edge (for PBO calculation). */
export const MIN_TRADES_FOR_PBO = 50;

// ---------------------------------------------------------------------------
// Risk Engine
// ---------------------------------------------------------------------------

/** Minimum allowed stake amount in USD. */
export const MIN_STAKE_USD = 1.0;

/** Maximum fraction of balance risked per trade (hard ceiling). */
export const HARD_MAX_RISK_PER_TRADE = 0.05; // 5% — never exceeded regardless of config

/** Maximum allowed drawdown fraction (hard ceiling). */
export const HARD_MAX_DRAWDOWN = 0.25; // 25% — hard stop regardless of config

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Timeout for contract proposal requests (ms). */
export const PROPOSAL_TIMEOUT_MS = 10_000;

/** Timeout for contract buy requests (ms). */
export const BUY_TIMEOUT_MS = 10_000;

/** How often to poll open contracts for status (ms). */
export const CONTRACT_POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Schema version — increment when migrations change schema. */
export const SCHEMA_VERSION = 1;

/** Batch size for bulk tick inserts. */
export const TICK_INSERT_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Backtesting
// ---------------------------------------------------------------------------

/** Walk-forward: fraction of data used for training in each window. */
export const WF_TRAIN_FRACTION = 0.6;

/** Walk-forward: fraction used for validation. */
export const WF_VALIDATE_FRACTION = 0.2;

/** Walk-forward: fraction used for out-of-sample test. */
export const WF_TEST_FRACTION = 0.2;

/** Minimum windows for a walk-forward result to be considered valid. */
export const WF_MIN_WINDOWS = 5;
