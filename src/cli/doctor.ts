#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('doctor', 'Read-only local diagnostics. --verbose --connectivity (public connection only)');
import { print } from '../monitoring/print.js';
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
import { fileURLToPath } from 'url';
import { inspectDatabase } from './databaseDiagnostic.js';
import { getEnv } from '../config/env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️ ';
const INFO = 'ℹ️ ';

function section(title: string): void {
  print(`\n${'─'.repeat(60)}`);
  print(`  ${title}`);
  print('─'.repeat(60));
}

function row(icon: string, label: string, value: string): void {
  print(`  ${icon}  ${label.padEnd(32)} ${value}`);
}

function redact(value: string | undefined): string {
  return value ? '(set; redacted)' : '(not set)';
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

let warnings = 0;
let errors = 0;

function check(pass: boolean, label: string, okMsg: string, failMsg: string): void {
  if (pass) {
    row(PASS, label, okMsg);
  } else {
    row(FAIL, label, failMsg);
    errors++;
  }
}

function warn(condition: boolean, label: string, msg: string): void {
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

  print('\n╔════════════════════════════════════════════════════════════╗');
  print('║   myTradingBot — System Diagnostic Report                  ║');
  print('╚════════════════════════════════════════════════════════════╝');

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
    print('\n  Fix .env before proceeding. See .env.example for reference.\n');
    process.exit(1);
  }

  // Key configuration values (safe to show)
  const keysToShow: [string, string][] = [
    ['DERIV_APP_ID',              env.DERIV_APP_ID],
    ['DERIV_API_TOKEN',           redact(env.DERIV_API_TOKEN)],
    ['DEMO_TRADING',              String(env.DEMO_TRADING)],
    ['LIVE_TRADING',              String(env.LIVE_TRADING)],
    ['LIVE_CONFIRMATION',         String(env.LIVE_CONFIRMATION)],
    ['CONTRACT_TYPE',             env.CONTRACT_TYPE],
    ['CONTRACT_DURATION',         `${String(env.CONTRACT_DURATION)} ${env.CONTRACT_DURATION_UNIT === 't' ? 'tick(s)' : env.CONTRACT_DURATION_UNIT}`],
    ['BACKTEST_PAYOUT_MULTIPLIER',String(env.BACKTEST_PAYOUT_MULTIPLIER)],
    ['STAKE_AMOUNT',              `$${String(env.STAKE_AMOUNT ?? 1.00)}`],
    ['SYMBOLS',                   env.SYMBOLS.join(', ')],
    ['LOG_LEVEL',                 env.LOG_LEVEL],
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
    env.DEMO_TRADING || !env.LIVE_TRADING,
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

  const dbPath = fileURLToPath(new URL('../../data/trading.db', import.meta.url));
  const dbExists = existsSync(dbPath);
  check(dbExists, 'Database file exists', dbPath, `Not found: ${dbPath} — run npm run migrate`);

  if (dbExists) {
    try {
      const { tables: tableNames, counts, integrity } = inspectDatabase(dbPath);
      check(integrity.length === 1 && integrity[0] === 'ok', 'SQLite integrity', 'ok', integrity.join('; '));
      check(tableNames.includes('ticks'), 'ticks table', 'present', 'missing — run npm run migrate');
      check(tableNames.includes('market_profiles'), 'market_profiles table', 'present', 'missing — run npm run migrate');

      if (tableNames.includes('ticks')) {
        // Per-symbol tick counts


        if (counts.length === 0) {
          row(WARN, 'Tick data', 'No ticks in database — run npm run migrate');
          warnings++;
        } else {
          row(INFO, 'Tick data', `${String(counts.length)} symbol(s) in database`);
          const belowMinimum = counts.filter(({ cnt }) => cnt < env.RESEARCH_MIN_OBSERVATIONS).length;
          warnings += belowMinimum;
          row(INFO, 'Below research minimum', String(belowMinimum));
          for (const { symbol, cnt } of counts.slice(0, 10)) {
            const quality = cnt >= env.RESEARCH_MIN_OBSERVATIONS ? INFO : WARN;
            row(quality, `  ${symbol}`, `${cnt.toLocaleString()} ticks${cnt < env.RESEARCH_MIN_OBSERVATIONS ? ' — below configured research minimum' : ' — count alone does not establish sufficiency'}`);
          }
          if (counts.length > 10) {
            row(INFO, '  ...and more', `${String(counts.length - 10)} additional symbols`);
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

  row(INFO, 'RL strategies in backtest', 'Standard engine rejects declared online learners; no frozen RL protocol implemented');
  row(INFO, 'Configured horizon', `Both use ${String(env.CONTRACT_DURATION)} ${env.CONTRACT_DURATION_UNIT === 't' ? 'tick(s)' : env.CONTRACT_DURATION_UNIT} (execution parity not verified)`);
  row(INFO, 'Payout assumption', `${String(env.BACKTEST_PAYOUT_MULTIPLIER)}x — verify against actual Deriv contract pricing`);
  row(WARN, 'Experiment registry', 'Not yet implemented — experiments are not versioned or hash-identified');
  warnings++;
  row(INFO, 'Risk engine persistence', 'Trading runners use the SQLite Options ledger; inspect account state before resuming');
  row(INFO, 'Settlement mechanism', 'Polls provider terminal state; unknown purchases and reconciliation drift block orders');
  row(INFO, 'Feature parity', 'Not checked by doctor; deterministic replay tests are required');

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

  print(`\n  Diagnostic errors: ${String(errors)}`);
  if (warnings > 0) print(`  ${WARN} ${String(warnings)} warning(s) — review items marked ⚠️`);
  if (errors > 0)   print(`  ${FAIL} ${String(errors)} error(s) — fix items marked ❌ before running`);

  print('\n  Run `npm run research:daemon` to persist tick data; research saves summary profiles.');
  print('  Run `npm run backtest` to evaluate strategies.');
  print('  Demo/live readiness is NOT established by these diagnostics.');
  print('  Run `npm run doctor -- --connectivity` to test Deriv WS connectivity.\n');

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('doctor failed:', err);
  process.exit(1);
});
