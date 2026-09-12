import pino from 'pino';

// ---------------------------------------------------------------------------
// Logger configuration — set by main application startup
// Tests use defaults without env
// ---------------------------------------------------------------------------

let _config = {
  level: 'info' as pino.Level,
  pretty: process.env['NODE_ENV'] !== 'production',
};

let _logger: pino.Logger | null = null;

/**
 * Configures the logger. Call this during application startup
 * BEFORE any modules create loggers.
 *
 * In test environments, this is NOT called and the logger uses
 * safe defaults (no env required).
 */
export function configureLogger(level: pino.Level, pretty: boolean): void {
  _config = { level, pretty };
  _logger = null; // Force recreation with new config
}

/**
 * Returns the singleton structured logger.
 * Safe to call at any time — does NOT require env to be configured.
 */
export function getLogger(name?: string): pino.Logger {
  if (_logger === null) {
    const options: pino.LoggerOptions = {
      level: _config.level,
      base: { service: 'quant-trading' },
    };
    if (_config.pretty) {
      options.transport = {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      };
    }
    _logger = pino(options);
  }

  return name ? _logger.child({ module: name }) : _logger;
}

/**
 * Creates a child logger bound to a module name.
 * Safe to call at module-load time.
 *
 * @example
 * const log = createLogger('TickCollector');
 * log.info({ symbol, price }, 'Tick received');
 */
export function createLogger(module: string): pino.Logger {
  return getLogger().child({ module });
}

/**
 * Initialize logger from validated env config.
 * Call this once at application startup after env is validated.
 */
export function initLoggerFromEnv(): void {
  // Import here to avoid circular deps and top-level side effects
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEnv } = require('../config/env.js') as {
      getEnv: () => { LOG_LEVEL: pino.Level; LOG_PRETTY: boolean };
    };
    const env = getEnv();
    configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  } catch {
    // If env is not yet configured (e.g., in tests), keep defaults
  }
}
