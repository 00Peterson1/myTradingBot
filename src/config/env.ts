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

  // Database
  DATABASE_HOST: z.string().default('localhost'),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_NAME: z.string().default('quant_trading'),
  DATABASE_USER: z.string().default('postgres'),
  DATABASE_PASSWORD: z.string().min(1, 'DATABASE_PASSWORD is required'),
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
    .transform((v) => (v.trim() === '' ? ['R_100', 'R_10', 'R_25', 'R_50', 'R_75'] : v.split(',').map((s) => s.trim())))
    .default('R_100,R_10,R_25,R_50,R_75'),
  COLLECT_SYMBOLS: z
    .string()
    .transform((v) => (v.trim() === '' ? [] : v.split(',').map((s) => s.trim())))
    .default(''),
  COLLECT_HISTORY_SECONDS: z.coerce.number().int().positive().default(86_400),

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
  return env.LIVE_TRADING && env.LIVE_CONFIRMATION;
}

/**
 * Whether demo trading is enabled.
 */
export function isDemoTradingEnabled(): boolean {
  return getEnv().DEMO_TRADING;
}
