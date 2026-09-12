#!/usr/bin/env node
/**
 * Research Mode — Full Synthetic Market Survey
 *
 * Usage: npm run research
 *
 * 1. Auto-discovers ALL Deriv synthetic indices from the live API
 * 2. Collects tick data for every symbol
 * 3. Runs statistical tests: autocorrelation, normality, momentum signal
 * 4. Produces a ranked table — best symbols to trade first
 * 5. Does NOT place trades
 *
 * After running this, pick the symbol(s) with the most interesting properties
 * and set SYMBOLS= in .env for live trading / backtesting.
 *
 * Strategies implemented in this bot (see src/strategies/):
 *   • Momentum          — Time-series momentum (Moskowitz, Ooi & Pedersen 2012)
 *   • VolAdjMomentum    — Volatility-scaled momentum (Barroso & Santa-Clara 2015)
 *   • Regime-Aware      — HMM regime detection + momentum (Lo 2004)
 *   • Mean-Reversion    — Contrarian on autocorrelated markets
 *   • Breakout          — Range breakout on low-noise markets
 *
 * Symbol naming on Deriv (developers.deriv.com):
 *   1HZ10V   = Volatility 10 Index    (fast, ~1 tick/s, low volatility)
 *   1HZ25V   = Volatility 25 Index
 *   1HZ50V   = Volatility 50 Index
 *   1HZ75V   = Volatility 75 Index
 *   1HZ100V  = Volatility 100 Index   (fast, ~1 tick/s, high volatility)
 *   1HZ150V  = Volatility 150 Index
 *   1HZ250V  = Volatility 250 Index
 *   BOOM300N = Boom 300 Index         (spike UP every ~300 ticks)
 *   BOOM500  = Boom 500 Index         (spike UP every ~500 ticks)
 *   BOOM1000 = Boom 1000 Index        (spike UP every ~1000 ticks)
 *   CRASH300N= Crash 300 Index        (spike DOWN every ~300 ticks)
 *   CRASH500 = Crash 500 Index        (spike DOWN every ~500 ticks)
 *   CRASH1000= Crash 1000 Index       (spike DOWN every ~1000 ticks)
 *   stpRNG   = Step Index             (moves only in fixed steps, no spikes)
 *   JD10–100 = Jump Indices           (random jumps added on top of Brownian)
 */

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';
import { renderBanner, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { FeatureEngine } from '../features/FeatureEngine.js';
import {
  ljungBoxTest,
  jarqueBera,
  computeSharpe,
  conditionalProbability,
} from '../research/statistics/stats.js';
import { mean, stddev, skewness, kurtosis } from '../features/indicators/indicators.js';
import { getDb } from '../data/database/sqlite.js';
import {
  bulkInsertTicks,
  bulkUpsertTickFeatures,
  upsertSymbol,
  type TickInsert,
} from '../data/repository/TickRepository.js';
import type { Tick } from '../types/tick.js';
import type { DerivTick } from '../api/deriv/DerivTypes.js';

// ---------------------------------------------------------------------------
// Configuration — change these to control the research run
// ---------------------------------------------------------------------------

/**
 * How many seconds of ticks to collect per symbol.
 * 30  = quick scan (~2.5 min for 5 symbols)
 * 300 = proper analysis (5 min per symbol)
 * Set via CLI: COLLECTION_SECS=60 npm run research
 */
const COLLECTION_SECS = parseInt(process.env['COLLECTION_SECS'] ?? '60', 10);

/**
 * Minimum ticks needed before running statistics.
 * Lower collection times will have fewer ticks.
 */
const MIN_TICKS = Math.max(20, Math.floor(COLLECTION_SECS * 0.5));

/**
 * Which symbol categories to include.
 * Set to [] to include ALL synthetic markets from the API.
 */
const CATEGORIES = {
  volatility: true,   // 1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V, 1HZ150V, 1HZ250V
  boom: true,         // BOOM300N, BOOM500, BOOM1000
  crash: true,        // CRASH300N, CRASH500, CRASH1000
  step: true,         // stpRNG (Step Index)
  jump: true,         // JD10–100 (Jump Indices)
  range_break: false, // Range Break Indices (less liquid)
};

// ---------------------------------------------------------------------------
// Known Deriv synthetic index symbols (as of 2025)
// The API will confirm which are available on your account
// ---------------------------------------------------------------------------
const KNOWN_SYNTHETIC_SYMBOLS = [
  // Volatility Indices (most popular — 1 tick per second)
  '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', '1HZ150V', '1HZ250V',
  // Boom Indices (spike UP at ~N tick intervals)
  'BOOM300N', 'BOOM500', 'BOOM500N', 'BOOM1000', 'BOOM1000N',
  // Crash Indices (spike DOWN at ~N tick intervals)
  'CRASH300N', 'CRASH500', 'CRASH500N', 'CRASH1000', 'CRASH1000N',
  // Step Index (moves only in 0.1 pip steps — very different dynamics)
  'stpRNG',
  // Jump Indices (Brownian + random jumps)
  'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
  // Range Break Indices
  'R_B100', 'R_B200',
];

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------
interface SymbolResult {
  symbol: string;
  displayName: string;
  tickCount: number;
  mean: number;
  stdDev: number;
  skewness: number;
  kurtosis: number;
  sharpe: number | null;
  isAutocorrelated: boolean;
  autocorrPValue: number | null;
  isNormal: boolean;
  hasEdge: boolean;
  edgeLift: number | null;
  edgePValue: number | null;
  score: number; // 0–100 research interest score
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('Research');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  console.log('📊 RESEARCH MODE — Full Synthetic Market Survey');
  console.log(`   Collection time: ${COLLECTION_SECS}s per symbol`);
  console.log('   No trades will be placed.\n');
  console.log(`   Tip: COLLECTION_SECS=300 npm run research  (5-min per symbol)\n`);

  // Open SQLite database (creates data/trading.db + schema on first run)
  try {
    getDb();
    console.log('💾 Database: data/trading.db (ticks will be saved for backtesting)\n');
  } catch (err) {
    log.warn({ err }, 'Could not open SQLite DB — ticks will NOT be saved');
  }

  const client = new DerivClient();
  await client.connectPublic();

  // ---------------------------------------------------------------------------
  // Discover which of the known symbols are actually available
  // ---------------------------------------------------------------------------
  let symbolsToScan: string[];

  try {
    log.info('Fetching available symbols from Deriv API...');
    const activeSymbols = await client.getActiveSymbols();
    const activeSet = new Set(activeSymbols.map((s) => s.symbol));

    // Check which of our known symbols are live
    const available = KNOWN_SYNTHETIC_SYMBOLS.filter((s) => activeSet.has(s));

    if (available.length > 0) {
      symbolsToScan = available;
      log.info({ count: symbolsToScan.length }, 'Symbols confirmed available on Deriv');
    } else {
      // API didn't return matching symbols — use configured SYMBOLS instead
      log.warn('Could not match known symbols via API. Using SYMBOLS= from .env');
      symbolsToScan = env.SYMBOLS;
    }
  } catch {
    log.warn('Could not fetch active symbols. Using SYMBOLS= from .env');
    symbolsToScan = env.SYMBOLS;
  }

  // Apply category filter
  symbolsToScan = symbolsToScan.filter((s) => {
    if (s.startsWith('1HZ')) return CATEGORIES.volatility;
    if (s.startsWith('BOOM')) return CATEGORIES.boom;
    if (s.startsWith('CRASH')) return CATEGORIES.crash;
    if (s === 'stpRNG') return CATEGORIES.step;
    if (s.startsWith('JD')) return CATEGORIES.jump;
    if (s.startsWith('R_B')) return CATEGORIES.range_break;
    return true;
  });

  console.log('\n📋 Symbols to scan:');
  symbolsToScan.forEach((s) => console.log(`   ${s}`));
  console.log(`\n   Total: ${symbolsToScan.length} symbols × ${COLLECTION_SECS}s = ~${Math.round(symbolsToScan.length * COLLECTION_SECS / 60)} minutes\n`);

  const results: SymbolResult[] = [];

  // ---------------------------------------------------------------------------
  // Collect & Analyse each symbol
  // ---------------------------------------------------------------------------
  for (let i = 0; i < symbolsToScan.length; i++) {
    const symbol = symbolsToScan[i]!;
    log.info({ symbol, progress: `${i + 1}/${symbolsToScan.length}` }, `Collecting ticks...`);

    const rawLogReturns: number[] = [];
    const ticks: Tick[] = [];
    let subFailed = false;

    await new Promise<void>((resolve) => {
      const handler = (tick: DerivTick): void => {
        if (tick.symbol !== symbol) return;
        const t: Tick = {
          symbol: tick.symbol,
          epoch: tick.epoch,
          timestamp: new Date(tick.epoch * 1000),
          price: tick.quote,
        };
        ticks.push(t);
        // Compute log-return for in-memory stats (feature replay happens after collection)
        if (ticks.length >= 2) {
          const prev = ticks[ticks.length - 2]!.price;
          const curr = t.price;
          if (prev > 0 && curr > 0) rawLogReturns.push(Math.log(curr / prev));
        }
      };

      client.on('tick', handler);

      client.subscribeTicks(symbol).catch(() => {
        subFailed = true;
        resolve();
      });

      setTimeout(() => {
        client.off('tick', handler);
        resolve();
      }, COLLECTION_SECS * 1_000);
    });

    if (subFailed) {
      log.warn({ symbol }, 'Subscription failed — symbol may not be available');
      continue;
    }

    if (rawLogReturns.length < MIN_TICKS) {
      log.warn({ symbol, got: rawLogReturns.length, need: MIN_TICKS }, 'Too few ticks');
      continue;
    }

    // -------------------------------------------------------------------------
    // Persist to SQLite
    // -------------------------------------------------------------------------
    try {
      // 1. Register symbol
      upsertSymbol({
        symbol,
        displayName: symbol,
        market: 'synthetic_index',
        submarket: 'random_index',
        instrumentType: 'synthetic',
      });

      // 2. Save raw ticks
      const tickInserts: TickInsert[] = ticks.map((t) => {
        const base = { symbol: t.symbol, epoch: t.epoch, price: t.price };
        const tid = (t as { tickId?: number }).tickId;
        return tid !== undefined ? { ...base, tickId: tid } : base;
      });
      const inserted = bulkInsertTicks(tickInserts);

      // 3. Replay through FeatureEngine to compute + save features
      // We need the DB row IDs, so we re-query the just-inserted ticks
      const db = getDb();
      const featureEngine = new FeatureEngine(symbol);
      const featurePairs: Array<{ rowId: bigint; features: ReturnType<FeatureEngine['process']> }> = [];

      for (const tick of ticks) {
        const features = featureEngine.process(tick);
        // Look up the rowid for this tick
        const row = db
          .prepare<[string, number], { id: number }>(
            'SELECT id FROM ticks WHERE symbol = ? AND epoch = ? LIMIT 1',
          )
          .get(tick.symbol, tick.epoch);
        if (row) {
          featurePairs.push({ rowId: BigInt(row.id), features });
        }
      }

      bulkUpsertTickFeatures(featurePairs);

      console.log(
        `  💾 Saved ${inserted} new ticks (${ticks.length} total) + ${featurePairs.length} feature rows for ${symbol}`,
      );
      log.info({ symbol, inserted, features: featurePairs.length }, 'Persisted to SQLite');
    } catch (err) {
      log.warn({ symbol, err }, 'Failed to save to SQLite — continuing with in-memory analysis');
    }

    // Run statistics
    const rMean = mean(rawLogReturns) ?? 0;
    const rStd = stddev(rawLogReturns) ?? 0;
    const rSkew = skewness(rawLogReturns) ?? 0;
    const rKurt = kurtosis(rawLogReturns) ?? 0;
    const sharpe = computeSharpe(rawLogReturns);
    const lb = ljungBoxTest(rawLogReturns, 10);
    const jb = jarqueBera(rawLogReturns);
    const condProb = conditionalProbability(
      rawLogReturns,
      (i) => (rawLogReturns[i] ?? 0) > 0,
      'up_after_up',
    );

    const isAutocorrelated = lb?.rejectH0 ?? false;
    const isNormal = jb?.isNormal ?? true;
    const hasEdge = (condProb?.lift ?? 0) > 1.05 && (condProb?.pValue ?? 1) < 0.05;

    // Scoring: higher = more interesting for strategy development
    // Points for: autocorrelation (exploitable), non-normality (options edge),
    // visible momentum signal, and adequate volatility
    let score = 0;
    if (isAutocorrelated) score += 40; // biggest signal — serial dependence
    if (!isNormal) score += 20;         // fat tails = options edge
    if (hasEdge) score += 30;           // momentum signal
    if (rStd > 1e-5) score += 10;       // enough volatility to trade

    const result: SymbolResult = {
      symbol,
      displayName: symbol,
      tickCount: ticks.length,
      mean: rMean,
      stdDev: rStd,
      skewness: rSkew,
      kurtosis: rKurt,
      sharpe: sharpe?.sharpe ?? null,
      isAutocorrelated,
      autocorrPValue: lb?.pValue ?? null,
      isNormal,
      hasEdge,
      edgeLift: condProb?.lift ?? null,
      edgePValue: condProb?.pValue ?? null,
      score,
    };

    results.push(result);
    printSymbolSummary(result);
  }

  // ---------------------------------------------------------------------------
  // Final ranked table
  // ---------------------------------------------------------------------------
  if (results.length > 0) {
    results.sort((a, b) => b.score - a.score);

    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                    RESEARCH SUMMARY — RANKED BY TRADING INTEREST                ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
    console.log('║ Symbol       Ticks  Autocorr  Normal  Edge   Score  Recommended Strategy        ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');

    for (const r of results) {
      const autocorr = r.isAutocorrelated ? '✓ YES  ' : '✗ no   ';
      const normal   = r.isNormal         ? '✓ YES  ' : '✗ no   ';
      const edge     = r.hasEdge          ? '✓ YES' : '✗ no ';
      const strategy = recommendStrategy(r);
      const scoreStr = r.score.toString().padStart(3);
      console.log(
        `║ ${r.symbol.padEnd(12)}${String(r.tickCount).padStart(5)}  ${autocorr} ${normal} ${edge}  ${scoreStr}    ${strategy.padEnd(27)}║`,
      );
    }

    console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
    const best = results[0]!;
    console.log(`║ 🏆 BEST SYMBOL: ${best.symbol.padEnd(12)} Score: ${best.score}/100                                   ║`);
    console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');

    console.log('\n📌 To trade the best symbol, update .env:');
    console.log(`   SYMBOLS=${results.slice(0, 3).map((r) => r.symbol).join(',')}\n`);

    console.log('📌 Available strategies to run (npm run trade:demo):');
    console.log('   momentum         — Time-series momentum (Moskowitz et al. 2012)');
    console.log('   vol-adj-momentum — Volatility-scaled momentum (Barroso & Santa-Clara 2015)');
    console.log('   regime           — HMM regime detection + momentum (Lo 2004)');
    console.log('   mean-reversion   — Best on autocorrelated symbols');
    console.log('   breakout         — Range breakout on stable symbols\n');

    console.log('⚠  All results from a short sample. Collect 10,000+ ticks before trading live.\n');
  }

  await client.disconnect();
  log.info('Research complete');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printSymbolSummary(r: SymbolResult): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${r.symbol}  (${r.tickCount} ticks)  Score: ${r.score}/100`);
  console.log('─'.repeat(60));
  console.log(`  Std Dev:       ${r.stdDev.toExponential(3)}  (volatility)`);
  console.log(`  Skewness:      ${r.skewness.toFixed(3)}  Kurtosis: ${r.kurtosis.toFixed(3)}`);
  console.log(`  Autocorr:      ${r.isAutocorrelated ? '✓ YES — serial dependence found!' : '✗ No (random walk)'}`);
  console.log(`  Normal dist:   ${r.isNormal ? '✓ Yes' : '✗ No (fat tails)'}`);
  console.log(`  Momentum edge: ${r.hasEdge ? `✓ YES  Lift=${r.edgeLift?.toFixed(3)}  p=${r.edgePValue?.toFixed(3)}` : '✗ None detected'}`);
  console.log(`  Strategy rec:  ${recommendStrategy(r)}`);
}

function recommendStrategy(r: SymbolResult): string {
  if (r.isAutocorrelated && r.hasEdge) return 'Momentum + Mean-Reversion';
  if (r.isAutocorrelated && !r.hasEdge) return 'Mean-Reversion';
  if (!r.isAutocorrelated && r.hasEdge) return 'Vol-Adj Momentum';
  if (!r.isNormal) return 'Vol-Adj Momentum (fat tails)';
  return 'Breakout / No clear edge';
}

main().catch((err: unknown) => {
  console.error('Research failed:', err);
  process.exit(1);
});
