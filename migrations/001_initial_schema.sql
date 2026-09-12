-- =============================================================================
-- Migration 001: Initial Schema
-- Quant Trading Research System — Deriv Synthetic Indices
-- =============================================================================
-- Design principles:
--   - Ticks are immutable once stored (append-only)
--   - Features are computed separately and stored in a parallel table
--   - Trades are strictly separated by mode (BACKTEST / PAPER / DEMO / LIVE)
--   - All timestamps stored as TIMESTAMPTZ (UTC)
--   - BIGSERIAL for high-volume tick tables
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Schema versioning
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Symbols — known instruments discovered from Deriv API
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS symbols (
  symbol          VARCHAR(32) PRIMARY KEY,
  display_name    TEXT NOT NULL,
  market          VARCHAR(64),         -- e.g. 'synthetic_index'
  submarket       VARCHAR(64),         -- e.g. 'random_index'
  instrument_type VARCHAR(64),         -- e.g. 'VOLATILITY', 'CRASH_BOOM', 'RANGE_BREAK'
  pip_size        NUMERIC(10, 8),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE symbols IS 'Instruments discovered from Deriv API — not hard-coded';

-- ---------------------------------------------------------------------------
-- Ticks — raw price observations (append-only, immutable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticks (
  id          BIGSERIAL PRIMARY KEY,
  symbol      VARCHAR(32) NOT NULL REFERENCES symbols(symbol),
  epoch       BIGINT NOT NULL,         -- Unix timestamp seconds (from Deriv)
  ts          TIMESTAMPTZ NOT NULL,    -- Converted to timestamp with tz
  price       NUMERIC(20, 8) NOT NULL,
  tick_id     BIGINT,                  -- Deriv-provided tick ID (may be NULL)

  -- Prevent exact duplicates
  CONSTRAINT ticks_symbol_epoch_price_unique UNIQUE (symbol, epoch, price)
);

COMMENT ON TABLE ticks IS 'Immutable raw tick store — never update, only insert';
COMMENT ON COLUMN ticks.epoch IS 'Unix timestamp in seconds as provided by Deriv';
COMMENT ON COLUMN ticks.ts IS 'UTC timestamp, derived from epoch at insert time';

CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks (symbol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ticks_symbol_epoch ON ticks (symbol, epoch DESC);
CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks (ts DESC);

-- ---------------------------------------------------------------------------
-- Tick Features — derived features computed by FeatureEngine
-- One row per tick (nullable if insufficient history)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tick_features (
  tick_id         BIGINT PRIMARY KEY REFERENCES ticks(id) ON DELETE CASCADE,
  symbol          VARCHAR(32) NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,

  -- Returns
  log_return      DOUBLE PRECISION,
  simple_return   DOUBLE PRECISION,

  -- Momentum (log return over k periods)
  mom_5           DOUBLE PRECISION,
  mom_10          DOUBLE PRECISION,
  mom_20          DOUBLE PRECISION,
  mom_50          DOUBLE PRECISION,
  mom_100         DOUBLE PRECISION,

  -- Volatility
  rolling_std_20  DOUBLE PRECISION,
  rolling_std_50  DOUBLE PRECISION,
  realized_vol_20 DOUBLE PRECISION,

  -- Vol-adjusted momentum
  vol_adj_mom_20  DOUBLE PRECISION,
  vol_adj_mom_50  DOUBLE PRECISION,

  -- Mean reversion
  rolling_mean_20 DOUBLE PRECISION,
  rolling_mean_50 DOUBLE PRECISION,
  z_score_20      DOUBLE PRECISION,
  z_score_50      DOUBLE PRECISION,

  -- Breakout
  rolling_high_20 DOUBLE PRECISION,
  rolling_low_20  DOUBLE PRECISION,
  rolling_high_50 DOUBLE PRECISION,
  rolling_low_50  DOUBLE PRECISION,
  drawdown_20     DOUBLE PRECISION,

  -- Autocorrelation of returns
  autocorr_lag1   DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_tick_features_symbol_ts ON tick_features (symbol, ts DESC);

-- ---------------------------------------------------------------------------
-- Trades — full lifecycle ledger
-- Strictly separated by mode — never mix BACKTEST, PAPER, DEMO, LIVE
-- ---------------------------------------------------------------------------
CREATE TYPE IF NOT EXISTS trading_mode AS ENUM ('BACKTEST', 'PAPER', 'DEMO', 'LIVE');
CREATE TYPE IF NOT EXISTS trade_status AS ENUM ('PENDING', 'OPEN', 'WON', 'LOST', 'CANCELLED', 'ERROR');
CREATE TYPE IF NOT EXISTS trade_direction AS ENUM ('BUY', 'SELL');

CREATE TABLE IF NOT EXISTS trades (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode                trading_mode NOT NULL,
  symbol              VARCHAR(32) NOT NULL,
  strategy            VARCHAR(64) NOT NULL,
  signal_id           UUID NOT NULL,
  contract_id         VARCHAR(64),       -- Deriv contract ID (NULL for paper/backtest)
  contract_type       VARCHAR(32),       -- e.g. 'CALL', 'PUT', 'DIGITEVEN'
  direction           trade_direction NOT NULL,
  entry_price         NUMERIC(20, 8) NOT NULL,
  stake               NUMERIC(20, 8) NOT NULL,
  payout              NUMERIC(20, 8),    -- Potential payout at entry
  profit              NUMERIC(20, 8),    -- Actual realized profit (negative = loss)
  status              trade_status NOT NULL DEFAULT 'PENDING',
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  duration_seconds    INTEGER,
  error_message       TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE trades IS 'Complete trade lifecycle — one row per trade, never deleted';
COMMENT ON COLUMN trades.mode IS 'BACKTEST/PAPER/DEMO/LIVE — never mix these in analysis';
COMMENT ON COLUMN trades.profit IS 'Positive = profit, negative = loss, NULL = not yet closed';

CREATE INDEX IF NOT EXISTS idx_trades_mode_symbol ON trades (mode, symbol);
CREATE INDEX IF NOT EXISTS idx_trades_mode_strategy ON trades (mode, strategy);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades (opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trades_updated_at
  BEFORE UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- Signals — every signal generated by a strategy (whether traded or not)
-- ---------------------------------------------------------------------------
CREATE TYPE IF NOT EXISTS signal_direction AS ENUM ('BUY', 'SELL', 'NONE');

CREATE TABLE IF NOT EXISTS signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol          VARCHAR(32) NOT NULL,
  price           NUMERIC(20, 8) NOT NULL,
  direction       signal_direction NOT NULL,
  strategy        VARCHAR(64) NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  risk_approved   BOOLEAN,
  rejection_reason VARCHAR(64),
  trade_id        UUID REFERENCES trades(id),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE signals IS 'Every signal ever generated — for full auditability';

CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals (ts DESC);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals (symbol);
CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals (strategy);

-- ---------------------------------------------------------------------------
-- Backtest Runs — metadata for each backtest run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backtest_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  strategy        VARCHAR(64) NOT NULL,
  symbol          VARCHAR(32) NOT NULL,
  parameters      JSONB NOT NULL,
  parameter_hash  VARCHAR(64) NOT NULL,  -- SHA256 of parameters JSON (for dedup)
  train_from      TIMESTAMPTZ NOT NULL,
  train_to        TIMESTAMPTZ NOT NULL,
  validate_from   TIMESTAMPTZ NOT NULL,
  validate_to     TIMESTAMPTZ NOT NULL,
  test_from       TIMESTAMPTZ NOT NULL,
  test_to         TIMESTAMPTZ NOT NULL,
  train_metrics   JSONB NOT NULL,
  validate_metrics JSONB NOT NULL,
  test_metrics    JSONB NOT NULL,         -- Only inspected after validation complete
  edge_status     VARCHAR(32) NOT NULL    -- EDGE_DETECTED | EDGE_NOT_DETECTED | INSUFFICIENT_EVIDENCE | OVERFIT_RISK_HIGH
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy ON backtest_runs (strategy);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_symbol ON backtest_runs (symbol);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_created_at ON backtest_runs (created_at DESC);

-- ---------------------------------------------------------------------------
-- Walk-Forward Results — aggregated multi-window results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS walkforward_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  strategy        VARCHAR(64) NOT NULL,
  symbol          VARCHAR(32) NOT NULL,
  window_count    INTEGER NOT NULL,
  backtest_run_ids UUID[] NOT NULL,
  aggregated_metrics JSONB NOT NULL,
  is_robust       BOOLEAN NOT NULL
);

-- ---------------------------------------------------------------------------
-- Daily P&L Summaries — materialized daily for fast dashboard queries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_pnl (
  date            DATE NOT NULL,
  mode            trading_mode NOT NULL,
  symbol          VARCHAR(32) NOT NULL,
  strategy        VARCHAR(64) NOT NULL,
  trades          INTEGER NOT NULL DEFAULT 0,
  wins            INTEGER NOT NULL DEFAULT 0,
  losses          INTEGER NOT NULL DEFAULT 0,
  total_staked    NUMERIC(20, 8) NOT NULL DEFAULT 0,
  total_profit    NUMERIC(20, 8) NOT NULL DEFAULT 0,
  win_rate        DOUBLE PRECISION,
  PRIMARY KEY (date, mode, symbol, strategy)
);

CREATE INDEX IF NOT EXISTS idx_daily_pnl_date ON daily_pnl (date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_pnl_mode ON daily_pnl (mode);

-- ---------------------------------------------------------------------------
-- Risk Events — audit log of all risk decisions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_events (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type      VARCHAR(64) NOT NULL,  -- SIGNAL_APPROVED | SIGNAL_REJECTED | KILL_SWITCH | COOLDOWN | etc.
  signal_id       UUID,
  symbol          VARCHAR(32),
  strategy        VARCHAR(64),
  details         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_risk_events_ts ON risk_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_event_type ON risk_events (event_type);

-- ---------------------------------------------------------------------------
-- Record this migration
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, description)
VALUES (1, 'Initial schema: symbols, ticks, tick_features, trades, signals, backtest_runs, walkforward_results, daily_pnl, risk_events')
ON CONFLICT (version) DO NOTHING;

COMMIT;
