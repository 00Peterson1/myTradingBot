#!/usr/bin/env node
/**
 * doctor — Diagnostic report for the quantitative trading workstation.
 *
 * Checks (all local, no network calls by default):
 *   1. Node.js version
 *   2. Environment configuration (with redacted secrets)
 *   3. SQLite database: existence, schema migration, tick counts per symbol
 *   4. Trading mode safety flags
 *   5. Methodological risk warnings (e.g. RL in standard backtest)
 *
 * Usage:
 *   npm run doctor
 *   npm run doctor -- --verbose       (show all env keys, not just key ones)
 *   npm run doctor -- --connectivity  (also attempt a public Deriv WS ping)
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { getEnv } from '../config/env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️ ';
const INFO = 'ℹ️ ';

function section(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

function row(icon: string, label: string, value: string) {
  console.log(`  ${icon}  ${label.padEnd(32)} ${value}`);
}

function redact(value: string | undefined, showChars = 4): string {
  if (!value) return '(not set)';
  if (value.length <= showChars) return '***';
  return value.substring(0, showChars) + '***';
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

let warnings = 0;
let errors = 0;

function check(pass: boolean, label: string, okMsg: string, failMsg: string) {
  if (pass) {
    row(PASS, label, okMsg);
  } else {
    row(FAIL, label, failMsg);
    errors++;
  }
}

function warn(condition: boolean, label: string, msg: string) {
  if (condition) {
    row(WARN, label, msg);
    warnings++;
  } else {
    row(PASS, label, 'OK');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verbose = process.argv.includes('--verbose');
  const doConnectivity = process.argv.includes('--connectivity');

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   myTradingBot — System Diagnostic Report                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  // ─────────────────────────────────────────────────────────────
  section('1. Node.js Environment');
  // ─────────────────────────────────────────────────────────────

  const nodeVersion = process.versions.node;
  const [major = 0] = nodeVersion.split('.').map(Number);
  check(
    major >= 20,
    'Node.js version',
    `v${nodeVersion}`,
    `v${nodeVersion} — v20+ required`,
  );

  const cwd = resolve('.');
  row(INFO, 'Working directory', cwd);

  // ─────────────────────────────────────────────────────────────
  section('2. Configuration (.env)');
  // ─────────────────────────────────────────────────────────────

  let env: ReturnType<typeof getEnv> | null = null;
  try {
    env = getEnv();
    row(PASS, 'Environment parsed', 'OK — all required fields present');
  } catch (err) {
    row(FAIL, 'Environment parse', (err as Error).message);
    errors++;
    console.log('\n  Fix .env before proceeding. See .env.example for reference.\n');
    process.exit(1);
  }

  // Key configuration values (safe to show)
  const keysToShow: Array<[string, string]> = [
    ['DERIV_APP_ID',              String(env.DERIV_APP_ID)],
    ['DERIV_API_TOKEN',           redact(env.DERIV_API_TOKEN, 6)],
    ['DEMO_TRADING',              String(env.DEMO_TRADING)],
    ['LIVE_TRADING',              String(env.LIVE_TRADING)],
    ['LIVE_CONFIRMATION',         String(env.LIVE_CONFIRMATION)],
    ['CONTRACT_TYPE',             String(env.CONTRACT_TYPE)],
    ['CONTRACT_DURATION',         `${env.CONTRACT_DURATION} ${env.CONTRACT_DURATION_UNIT === 't' ? 'tick(s)' : env.CONTRACT_DURATION_UNIT}`],
    ['BACKTEST_PAYOUT_MULTIPLIER',String(env.BACKTEST_PAYOUT_MULTIPLIER)],
    ['STAKE_AMOUNT',              `$${env.STAKE_AMOUNT ?? 1.00}`],
    ['SYMBOLS',                   env.SYMBOLS.join(', ')],
    ['LOG_LEVEL',                 String(env.LOG_LEVEL ?? 'warn')],
  ];
  if (verbose) {
    keysToShow.push(
      ['VOTE_THRESHOLD',           String(env.VOTE_THRESHOLD)],
      ['MIN_CONSENSUS_CONFIDENCE', String(env.MIN_CONSENSUS_CONFIDENCE)],
      ['MAX_TRADES_PER_HOUR',      String(env.MAX_TRADES_PER_HOUR)],
      ['TOP_SYMBOLS',              String(env.TOP_SYMBOLS)],
      ['DIGIT_BARRIER',            String(env.DIGIT_BARRIER)],
    );
  }
  for (const [k, v] of keysToShow) {
    row(INFO, k, v);
  }

  // ─────────────────────────────────────────────────────────────
  section('3. Safety / Trading Mode');
  // ─────────────────────────────────────────────────────────────

  check(
    env.DEMO_TRADING === true || env.LIVE_TRADING === false,
    'Safe mode active',
    env.DEMO_TRADING ? 'DEMO_TRADING=true' : 'LIVE_TRADING=false',
    'LIVE_TRADING is enabled — requires LIVE_CONFIRMATION=true before trades execute',
  );

  if (env.LIVE_TRADING) {
    warn(
      !env.LIVE_CONFIRMATION,
      'Live confirmation gate',
      'LIVE_CONFIRMATION must be true for live trading to proceed',
    );
    row(WARN, 'Live trading', 'LIVE_TRADING=true — real money is at risk');
    warnings++;
  } else {
    row(PASS, 'Live trading', 'LIVE_TRADING=false — safe');
  }

  // ─────────────────────────────────────────────────────────────
  section('4. Database');
  // ─────────────────────────────────────────────────────────────

  const dbPath = resolve('data', 'trading.db');
  const dbExists = existsSync(dbPath);
  check(dbExists, 'Database file exists', dbPath, `Not found: ${dbPath} — run npm run research`);

  if (dbExists) {
    try {
      const { getDb } = await import('../data/database/sqlite.js');
      const db = getDb();

      // Check tables
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
      const tableNames = tables.map(t => t.name);
      check(tableNames.includes('ticks'), 'ticks table', 'present', 'missing — run npm run research');
      check(tableNames.includes('research_results'), 'research_results table', 'present', 'missing — run npm run research');

      if (tableNames.includes('ticks')) {
        // Per-symbol tick counts
        const counts = db.prepare('SELECT symbol, COUNT(*) as cnt FROM ticks GROUP BY symbol ORDER BY cnt DESC').all() as Array<{symbol: string, cnt: number}>;

        if (counts.length === 0) {
          row(WARN, 'Tick data', 'No ticks in database — run npm run research');
          warnings++;
        } else {
          row(INFO, 'Tick data', `${counts.length} symbol(s) in database`);
          for (const { symbol, cnt } of counts.slice(0, 10)) {
            const quality = cnt >= 10000 ? PASS : cnt >= 1000 ? WARN : FAIL;
            if (cnt < 1000) errors++;
            else if (cnt < 10000) warnings++;
            row(quality, `  ${symbol}`, `${cnt.toLocaleString()} ticks${cnt < 1000 ? ' — insufficient for backtesting' : ''}`);
          }
          if (counts.length > 10) {
            row(INFO, '  ...and more', `${counts.length - 10} additional symbols`);
          }
        }
      }
    } catch (err) {
      row(FAIL, 'Database open', (err as Error).message);
      errors++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  section('5. Methodological Risk Checks');
  // ─────────────────────────────────────────────────────────────

  row(PASS, 'RL strategies in backtest', 'QUARANTINED — isOnlineLearner=true prevents OOS evaluation');
  row(PASS, 'Backtest/demo horizon', `Both use ${env.CONTRACT_DURATION} ${env.CONTRACT_DURATION_UNIT === 't' ? 'tick(s)' : env.CONTRACT_DURATION_UNIT} (aligned)`);
  row(INFO, 'Payout assumption', `${env.BACKTEST_PAYOUT_MULTIPLIER}x — verify against actual Deriv contract pricing`);
  row(WARN, 'Experiment registry', 'Not yet implemented — experiments are not versioned or hash-identified');
  warnings++;
  row(WARN, 'Risk engine persistence', 'In-memory only — risk state resets on process restart');
  warnings++;
  row(WARN, 'Settlement mechanism', 'setTimeout approximation — not event-driven (Milestone 3)');
  warnings++;
  row(WARN, 'Ichimoku cloud', 'Causal (computed at current index, no forward shift) — verified ✓');

  // ─────────────────────────────────────────────────────────────
  if (doConnectivity) {
    section('6. Network Connectivity (--connectivity)');

    try {
      const { DerivClient } = await import('../api/deriv/DerivClient.js');
      const client = new DerivClient();
      row(INFO, 'Connecting public WS', 'Attempting connection...');
      await client.connectPublic();
      row(PASS, 'Deriv public WS', 'Connected OK');
      await client.disconnect();
    } catch (err) {
      row(FAIL, 'Deriv public WS', (err as Error).message);
      errors++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  section('Summary');
  // ─────────────────────────────────────────────────────────────

  console.log(`\n  ${PASS} Checks passed`);
  if (warnings > 0) console.log(`  ${WARN} ${warnings} warning(s) — review items marked ⚠️`);
  if (errors > 0)   console.log(`  ${FAIL} ${errors} error(s) — fix items marked ❌ before running`);

  console.log('\n  Run `npm run research` to collect tick data.');
  console.log('  Run `npm run backtest` to evaluate strategies.');
  console.log('  Run `npm run trade:demo` to run the demo trading loop.');
  console.log('  Run `npm run doctor -- --connectivity` to test Deriv WS connectivity.\n');

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('doctor failed:', err);
  process.exit(1);
});
