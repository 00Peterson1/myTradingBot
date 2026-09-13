import 'dotenv/config';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const envSchema = z.object({
  // Deriv
  DERIV_API_TOKEN: z.string().min(1, 'DERIV_API_TOKEN is required'),
  DERIV_APP_ID: z.string().min(1, 'DERIV_APP_ID is required'),

  // Safety — these defaults make the system safe even if env is misconfigured
  DEMO_TRADING: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('true'),
  LIVE_TRADING: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('false'),
  LIVE_CONFIRMATION: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('false'),

  // Trade Parameters — set these in .env to control trade sizing
  STAKE_AMOUNT: z.coerce.number().positive().optional(),
  CONTRACT_DURATION: z.coerce.number().int().positive().default(5),
  CONTRACT_DURATION_UNIT: z.enum(['t', 's', 'm', 'h', 'd']).default('t'),
  MAX_STAKE_PERCENT: z.coerce.number().min(0.001).max(0.25).default(0.02),
  MAX_DAILY_LOSS_PERCENT: z.coerce.number().min(0.01).max(1.0).default(0.10),

  // Contract Type & Digit Options
  CONTRACT_TYPE: z.enum(['AUTO', 'RISE_FALL', 'EVEN_ODD', 'OVER_UNDER', 'MATCHES_DIFFERS']).default('AUTO'),
  DIGIT_BARRIER: z.coerce.number().int().min(0).max(9).default(5),

  // Vote / Consensus Trading Controls
  VOTE_THRESHOLD: z.coerce.number().min(0.1).max(1.0).default(0.60),
  MIN_CONSENSUS_CONFIDENCE: z.coerce.number().min(0.0).max(1.0).default(0.55),
  MAX_TRADES_PER_HOUR: z.coerce.number().int().positive().default(10),
  MAX_OPEN_TRADES: z.coerce.number().int().positive().default(3),
  TOP_SYMBOLS: z.coerce.number().int().positive().optional(),
  VALIDATION_MAX_AGE_HOURS: z.coerce.number().positive().default(24),
  BACKTEST_PAYOUT_MULTIPLIER: z.coerce.number().positive().default(0.85),

  // Database
  DATABASE_HOST: z.string().default('localhost'),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_NAME: z.string().default('quant_trading'),
  DATABASE_USER: z.string().default('postgres'),
  DATABASE_PASSWORD: z.string().default(''), // Not required for SQLite mode
  DATABASE_SSL: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('false'),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // Risk limits
  RISK_MAX_PER_TRADE_FRACTION: z.coerce.number().positive().max(0.1).default(0.01),
  RISK_MAX_DAILY_LOSS_FRACTION: z.coerce.number().positive().max(0.5).default(0.05),
  RISK_MAX_DRAWDOWN_FRACTION: z.coerce.number().positive().max(1).default(0.15),
  RISK_MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().positive().default(5),
  RISK_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(3600),

  // Data collection
  SYMBOLS: z
    .string()
    .transform((v) => (v.trim() === '' ? ['ALL'] : v.split(',').map((s) => s.trim()).filter(Boolean)))
    .default('ALL'),
  COLLECT_SYMBOLS: z
    .string()
    .transform((v) => (v.trim() === '' ? [] : v.split(',').map((s) => s.trim())))
    .default(''),
  COLLECT_HISTORY_SECONDS: z.coerce.number().int().positive().default(86_400),

  // Research daemon
  SLOT_SECS_FAST: z.coerce.number().int().positive().default(60),
  SLOT_SECS_SLOW: z.coerce.number().int().positive().default(300),
  DAEMON_PARALLEL_FAST: z.coerce.number().int().positive().default(5),
  DAEMON_CATEGORIES: z
    .string()
    .transform((v) =>
      v.trim() === ''
        ? ['synthetic', 'forex', 'crypto', 'stocks', 'commodities']
        : v.split(',').map((s) => s.trim()),
    )
    .default('synthetic,forex,crypto,stocks,commodities'),

  // Pairs trading
  PAIRS_SPREAD_WINDOW: z.coerce.number().int().positive().default(200),
  PAIRS_COINTEG_WINDOW: z.coerce.number().int().positive().default(500),
  PAIRS_ENTRY_ZSCORE: z.coerce.number().positive().default(2.0),
  PAIRS_EXIT_ZSCORE: z.coerce.number().positive().default(0.5),
  PAIRS_MAX_ZSCORE: z.coerce.number().positive().default(4.5),

  // RL strategies
  RL_EPSILON: z.coerce.number().min(0).max(1).default(0.1),
  RL_LEARNING_RATE: z.coerce.number().positive().default(0.01),
  RL_DISCOUNT: z.coerce.number().min(0).max(1).default(0.95),

  // LLM context filter (Gemini)
  GEMINI_API_KEY: z.string().default(''),            // optional — filter degrades gracefully
  LLM_CACHE_HOURS: z.coerce.number().positive().default(4),
  LLM_DIVERGENCE_SUPPRESS_THRESHOLD: z.coerce.number().int().min(0).max(10).default(7),

  // Economic calendar
  ECON_BLACKOUT_HOURS_CRITICAL: z.coerce.number().positive().default(4),
  ECON_BLACKOUT_HOURS_HIGH: z.coerce.number().positive().default(2),

  // PyTorch sidecar
  PYTORCH_SIDECAR_URL: z.string().default('http://localhost:8765'),
  PYTORCH_SIDECAR_ENABLED: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('false'),
  ML_REVERSION_PROB_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('true'),

  // Backtesting
  BACKTEST_OUTPUT_DIR: z.string().default('./backtest-results'),

  // Research
  RESEARCH_SIGNIFICANCE_LEVEL: z.coerce.number().positive().max(0.5).default(0.05),
  RESEARCH_MIN_OBSERVATIONS: z.coerce.number().int().positive().default(1000),
});

export type Env = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Singleton — parse once at startup, fail fast on invalid config
// ---------------------------------------------------------------------------

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nSee .env.example for reference.`,
    );
  }

  const env = result.data;

  // ---------------------------------------------------------------------------
  // Critical safety check: live trading requires explicit double confirmation
  // ---------------------------------------------------------------------------
  if (env.LIVE_TRADING && !env.LIVE_CONFIRMATION) {
    throw new Error(
      'LIVE_TRADING=true requires LIVE_CONFIRMATION=true as a second explicit confirmation.\n' +
        'This is a deliberate safety mechanism. Do NOT enable live trading until backtesting is complete.',
    );
  }

  return env;
}

let _env: Env | null = null;

/**
 * Returns the validated, parsed environment configuration.
 * Parsed lazily on first call and cached thereafter.
 */
export function getEnv(): Env {
  if (_env === null) {
    _env = loadEnv();
  }
  return _env;
}

/**
 * Resets the cached environment — FOR TESTING ONLY.
 * Allows tests to set process.env before each test and get a fresh parse.
 */
export function resetEnvForTesting(): void {
  _env = null;
}

/**
 * Whether live trading is fully enabled (requires both flags).
 */
export function isLiveTradingEnabled(): boolean {
  const env = getEnv();
  return env.LIVE_TRADING && env.LIVE_CONFIRMATION && !env.DEMO_TRADING;
}

/**
 * Whether demo trading is enabled.
 */
export function isDemoTradingEnabled(): boolean {
  return getEnv().DEMO_TRADING;
}
