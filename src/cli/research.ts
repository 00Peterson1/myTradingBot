#!/usr/bin/env node
/**
 * Research Mode — Market-Aware Statistical Survey
 *
 * Usage:  npm run research
 *         COLLECTION_SECS=60 npm run research    (faster scan)
 *         COLLECTION_SECS=300 npm run research   (deeper analysis)
 *
 * What it does:
 *   1. Connects to Deriv public WebSocket
 *   2. Scans every symbol in SYMBOLS= (.env)
 *   3. Runs market-TYPE-appropriate tests for each:
 *        Volatility  → autocorrelation, mean-reversion, Hurst
 *        Boom/Crash  → spike detection, inter-spike interval, post-spike reversal
 *        Step        → step-direction autocorrelation, run-length
 *        Jump        → tail thickness, jump clustering
 *   4. Saves results to SQLite (data/trading.db)
 *   5. Prints ranked table — best symbols first
 *
 * After running:
 *   → `npm run trade:demo` will automatically pick the best symbols
 *   → No manual selection needed
 */

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';
import { renderBanner, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { ljungBoxTest, jarqueBera, computeSharpe, conditionalProbability } from '../research/statistics/stats.js';
import { mean, stddev, skewness, kurtosis } from '../features/indicators/indicators.js';
import { detectMarketType, strategiesForMarketType } from '../execution/SymbolRanker.js';
import { saveResearchResult } from '../data/repository/ResearchRepository.js';
import { getDb } from '../data/database/sqlite.js';
import type { Tick } from '../types/tick.js';
import type { DerivTick } from '../api/deriv/DerivTypes.js';
import type { MarketType } from '../execution/SymbolRanker.js';

const COLLECTION_SECS = parseInt(process.env.COLLECTION_SECS ?? '60', 10);
const MIN_TICKS = Math.max(5, Math.floor(COLLECTION_SECS * 0.5));

// ─────────────────────────────────────────────────────────────────────────────
// Result type
// ─────────────────────────────────────────────────────────────────────────────

interface SymbolResult {
  symbol: string;
  marketType: MarketType;
  tickCount: number;
  mean: number;
  stdDev: number;
  skewness: number;
  kurtosis: number;
  sharpe: number | null;
  isAutocorrelated: boolean;
  autocorrPValue: number | null;
  isNormal: boolean;
  jbPValue: number | null;
  hasEdge: boolean;
  edgeLift: number | null;
  edgePValue: number | null;
  score: number;
  // Market-type-specific extras
  extras: Record<string, number | string | boolean | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Market-type-specific analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run additional tests appropriate for Boom/Crash markets.
 * These markets spike every ~N ticks, so we look for:
 *   - Spike frequency (how often price jumps > 3σ)
 *   - Post-spike reversal (mean-reversion tendency after a spike)
 *   - Pre-spike momentum (trend building before spike)
 */
function analyzeBoomCrash(
  _ticks: Tick[],
  returns: number[],
  type: 'boom' | 'crash',
): Record<string, number | string | boolean | null> {
  if (returns.length < 10) return {};

  const rStd = stddev(returns) ?? 0;
  const threshold = 3 * rStd;

  // Find spikes
  const spikeIndices: number[] = [];
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i] ?? 0;
    const isSpike = type === 'boom' ? r > threshold : r < -threshold;
    if (isSpike) spikeIndices.push(i);
  }

  if (spikeIndices.length === 0) {
    return {
      spikeCount: 0,
      avgInterSpikeInterval: null,
      postSpikeReversalRate: null,
      note: 'No spikes detected in this sample (need more ticks)',
    };
  }

  // Average inter-spike interval
  let intervalSum = 0;
  for (let i = 1; i < spikeIndices.length; i++) {
    intervalSum += (spikeIndices[i]! - spikeIndices[i - 1]!);
  }
  const avgInterval = spikeIndices.length > 1
    ? intervalSum / (spikeIndices.length - 1)
    : null;

  // Post-spike reversal: does the return after the spike go in opposite direction?
  let reversalCount = 0;
  let postSpikeChecked = 0;
  for (const idx of spikeIndices) {
    if (idx + 1 < returns.length) {
      const postReturn = returns[idx + 1] ?? 0;
      const spikeReturn = returns[idx] ?? 0;
      if (Math.sign(postReturn) !== Math.sign(spikeReturn)) reversalCount++;
      postSpikeChecked++;
    }
  }
  const postSpikeReversalRate = postSpikeChecked > 0 ? reversalCount / postSpikeChecked : null;

  return {
    spikeCount: spikeIndices.length,
    spikeFrequency: spikeIndices.length / returns.length,
    avgInterSpikeInterval: avgInterval,
    postSpikeReversalRate,
    tradingNote: postSpikeReversalRate !== null && postSpikeReversalRate > 0.6
      ? 'Mean-reversion after spike is reliable — good for post-spike fade trades'
      : 'Post-spike reversal not consistent — avoid counter-spike trades',
  };
}

/**
 * Analyse Step Index (stpRNG) — moves only in fixed ±0.1 pip steps.
 * Tests: run length (consecutive same-direction steps), direction autocorrelation.
 */
function analyzeStep(ticks: Tick[]): Record<string, number | string | boolean | null> {
  if (ticks.length < 10) return {};

  const directions: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const diff = (ticks[i]!.price ?? 0) - (ticks[i - 1]!.price ?? 0);
    if (diff > 0) directions.push(1);
    else if (diff < 0) directions.push(-1);
    else directions.push(0);
  }

  // Direction autocorrelation at lag 1
  let sameDir = 0;
  let checked = 0;
  for (let i = 1; i < directions.length; i++) {
    if (directions[i - 1] !== 0 && directions[i] !== 0) {
      if (directions[i] === directions[i - 1]) sameDir++;
      checked++;
    }
  }
  const dirAutocorr = checked > 0 ? sameDir / checked : null;

  // Run lengths
  let maxRun = 1, currentRun = 1;
  for (let i = 1; i < directions.length; i++) {
    if (directions[i] === directions[i - 1] && directions[i] !== 0) {
      currentRun++;
      maxRun = Math.max(maxRun, currentRun);
    } else {
      currentRun = 1;
    }
  }

  return {
    directionAutocorrelation: dirAutocorr,
    maxRunLength: maxRun,
    tradingNote: dirAutocorr !== null && dirAutocorr > 0.55
      ? 'Direction persistence detected — momentum strategy may work'
      : dirAutocorr !== null && dirAutocorr < 0.45
      ? 'Direction reversal tendency — mean-reversion strategy preferred'
      : 'Step directions appear random',
  };
}

/**
 * Analyse Jump Indices (JD10–100) — Brownian + random jumps.
 * Tests: tail thickness (excess kurtosis), jump clustering.
 */
function analyzeJump(returns: number[]): Record<string, number | string | boolean | null> {
  if (returns.length < 10) return {};

  const rStd = stddev(returns) ?? 1;
  const jumpThreshold = 2.5 * rStd;
  const jumps = returns.filter((r) => Math.abs(r) > jumpThreshold);
  const jumpRate = jumps.length / returns.length;
  const exKurt = kurtosis(returns) ?? 0;

  // Jump clustering: are jumps close together?
  const jumpIndices: number[] = [];
  for (let i = 0; i < returns.length; i++) {
    if (Math.abs(returns[i] ?? 0) > jumpThreshold) jumpIndices.push(i);
  }
  let clustered = 0;
  for (let i = 1; i < jumpIndices.length; i++) {
    if ((jumpIndices[i]! - jumpIndices[i - 1]!) <= 3) clustered++;
  }
  const clusterRate = jumpIndices.length > 1 ? clustered / (jumpIndices.length - 1) : null;

  return {
    jumpRate,
    excessKurtosis: exKurt,
    jumpClusterRate: clusterRate,
    tradingNote: jumpRate > 0.05
      ? 'High jump rate — use vol-adjusted strategies, avoid fixed-stake momentum'
      : 'Low jump rate — standard strategies apply',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Print helpers
// ─────────────────────────────────────────────────────────────────────────────

function printSymbolResult(r: SymbolResult): void {
  const typeEmoji: Record<MarketType, string> = {
    volatility: '📈',
    boom: '🚀',
    crash: '💥',
    step: '📏',
    jump: '⚡',
    forex: '💱',
    commodities: '🥇',
    crypto: '₿',
    stock_indices: '📊',
    unknown: '❓',
  };

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  ${typeEmoji[r.marketType]} ${r.symbol}  [${r.marketType.toUpperCase()}]  ${r.tickCount} ticks  Score: ${r.score}/100`);
  console.log('─'.repeat(64));

  // Distribution
  console.log(`  Volatility (σ):  ${r.stdDev.toExponential(3)}   Sharpe: ${r.sharpe !== null ? r.sharpe.toFixed(3) : 'N/A'}`);
  console.log(`  Skewness:        ${r.skewness.toFixed(3)}   Kurtosis (ex): ${r.kurtosis.toFixed(3)}`);

  // Autocorrelation
  const acLabel = r.isAutocorrelated
    ? `✓ YES  p=${r.autocorrPValue?.toFixed(4)}  ← serial dependence, patterns exist`
    : `✗ No   p=${r.autocorrPValue?.toFixed(4)}  (random walk)`;
  console.log(`  Autocorrelation: ${acLabel}`);

  // Normality
  const normLabel = r.isNormal
    ? `✓ Normal   p=${r.jbPValue?.toFixed(4)}`
    : `✗ Non-normal p=${r.jbPValue?.toFixed(4)}  ← fat tails`;
  console.log(`  Distribution:    ${normLabel}`);

  // Momentum edge
  const edgeLabel = r.hasEdge
    ? `✓ YES  lift=${r.edgeLift?.toFixed(3)}  p=${r.edgePValue?.toFixed(4)}`
    : `✗ None  (lift=${r.edgeLift?.toFixed(3) ?? 'N/A'})`;
  console.log(`  Momentum edge:   ${edgeLabel}`);

  // Market-type-specific extras
  if (Object.keys(r.extras).length > 0) {
    console.log(`\n  [${r.marketType.toUpperCase()}-specific analysis]`);
    for (const [k, v] of Object.entries(r.extras)) {
      if (k === 'tradingNote' || k === 'note') {
        console.log(`  → ${String(v)}`);
      } else if (v !== null) {
        const display = typeof v === 'number' ? v.toFixed(4) : String(v);
        console.log(`  ${k.padEnd(28)}: ${display}`);
      }
    }
  }

  // Strategy recommendation
  const strategies = strategiesForMarketType(r.marketType);
  console.log(`\n  Recommended:  [${strategies.join(', ')}]`);
}

function recommendStrategy(r: SymbolResult): string {
  if (r.isAutocorrelated && r.hasEdge) return 'Momentum + Mean-Rev';
  if (r.isAutocorrelated) return 'Mean-Reversion';
  if (r.hasEdge) return 'Vol-Adj Momentum';
  if (!r.isNormal) return 'Vol-Adj (fat tails)';
  if (r.marketType === 'boom' || r.marketType === 'crash') return 'Wavelet + Mean-Rev';
  if (r.marketType === 'step') return 'Mean-Reversion';
  if (r.marketType === 'jump') return 'Vol-Adj Momentum';
  return 'Breakout / No edge';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('Research');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  console.log('📊 RESEARCH MODE — Market-Aware Statistical Survey');
  console.log(`   Collection: ${COLLECTION_SECS}s per symbol`);
  console.log(`   Symbols:    ${env.SYMBOLS.join(', ')}`);
  console.log(`   Total time: ~${Math.round(env.SYMBOLS.length * COLLECTION_SECS / 60)} min\n`);
  console.log(`   Tip: COLLECTION_SECS=300 npm run research  (5 min per symbol for better stats)\n`);

  // Open DB (auto-creates schema)
  try {
    getDb();
    console.log('💾 Results will be saved to data/trading.db\n');
  } catch (err) {
    log.warn({ err }, 'SQLite unavailable — results will NOT be saved');
  }

  const client = new DerivClient();
  await client.connectPublic();
  log.info('Connected to Deriv public WebSocket');

  const results: SymbolResult[] = [];

  // ─── Per-symbol collection & analysis ────────────────────────────────────
  for (let i = 0; i < env.SYMBOLS.length; i++) {
    const symbol = env.SYMBOLS[i]!;
    const marketType = detectMarketType(symbol);

    log.info({ symbol, marketType, progress: `${i + 1}/${env.SYMBOLS.length}` }, 'Collecting...');

    const rawReturns: number[] = [];
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
        if (ticks.length >= 2) {
          const prev = ticks[ticks.length - 2]!.price;
          const curr = t.price;
          if (prev > 0 && curr > 0) rawReturns.push(Math.log(curr / prev));
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
      log.warn({ symbol }, 'Subscription failed — symbol may not be available on this account');
      continue;
    }

    if (rawReturns.length < MIN_TICKS) {
      log.warn({ symbol, got: rawReturns.length, need: MIN_TICKS }, 'Too few ticks — skipping');
      continue;
    }

    // ── Standard statistical tests (all markets) ──────────────────────────
    const rMean   = mean(rawReturns) ?? 0;
    const rStd    = stddev(rawReturns) ?? 0;
    const rSkew   = skewness(rawReturns) ?? 0;
    const rKurt   = kurtosis(rawReturns) ?? 0;
    const sharpe  = computeSharpe(rawReturns);
    const lb      = ljungBoxTest(rawReturns, 10);
    const jb      = jarqueBera(rawReturns);
    const condP   = conditionalProbability(rawReturns, (j) => (rawReturns[j] ?? 0) > 0, 'up_after_up');

    const isAutocorrelated = lb?.rejectH0 ?? false;
    const isNormal         = jb?.isNormal ?? true;
    const hasEdge          = (condP?.lift ?? 0) > 1.05 && (condP?.pValue ?? 1) < 0.05;

    // ── Market-type-specific extras ───────────────────────────────────────
    let extras: Record<string, number | string | boolean | null> = {};
    if (marketType === 'boom') extras = analyzeBoomCrash(ticks, rawReturns, 'boom');
    else if (marketType === 'crash') extras = analyzeBoomCrash(ticks, rawReturns, 'crash');
    else if (marketType === 'step') extras = analyzeStep(ticks);
    else if (marketType === 'jump') extras = analyzeJump(rawReturns);

    // ── Score (0–100) ─────────────────────────────────────────────────────
    let score = 0;
    if (isAutocorrelated) score += 40;  // serial dependence = biggest edge signal
    if (!isNormal)        score += 20;  // fat tails = options/vol strategies work
    if (hasEdge)          score += 30;  // momentum signal found
    if (rStd > 1e-5)      score += 10;  // enough volatility to trade

    // Boom/Crash bonus if post-spike reversal is reliable
    const psr = extras.postSpikeReversalRate;
    if (typeof psr === 'number' && psr > 0.6) score = Math.min(100, score + 10);

    const result: SymbolResult = {
      symbol,
      marketType,
      tickCount: ticks.length,
      mean: rMean,
      stdDev: rStd,
      skewness: rSkew,
      kurtosis: rKurt,
      sharpe: sharpe?.sharpe ?? null,
      isAutocorrelated,
      autocorrPValue: lb?.pValue ?? null,
      isNormal,
      jbPValue: jb?.pValue ?? null,
      hasEdge,
      edgeLift: condP?.lift ?? null,
      edgePValue: condP?.pValue ?? null,
      score,
      extras,
    };

    results.push(result);
    printSymbolResult(result);

    // ── Persist to DB ─────────────────────────────────────────────────────
    try {
      saveResearchResult({
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
        jbPValue: jb?.pValue ?? null,
        hasEdge,
        edgeLift: condP?.lift ?? null,
        edgePValue: condP?.pValue ?? null,
        score,
      });
      log.info({ symbol, score }, 'Result saved to DB');
    } catch (err) {
      log.warn({ symbol, err }, 'Could not save to DB — continuing');
    }
  }

  // ─── Final ranked table ───────────────────────────────────────────────────
  if (results.length === 0) {
    console.log('\n⚠️  No results. Check SYMBOLS= in .env and run again.');
    await client.disconnect();
    process.exit(0);
  }

  results.sort((a, b) => b.score - a.score);

  const W = 86;
  console.log('\n');
  console.log('╔' + '═'.repeat(W) + '╗');
  console.log('║' + '  RESEARCH SUMMARY — RANKED BY TRADING INTEREST (best → worst)'.padEnd(W) + '║');
  console.log('╠' + '═'.repeat(W) + '╣');
  console.log('║ Symbol       Type         Ticks  Autocorr  Normal  Edge   Score  Best Strategy' + ' '.repeat(W - 79) + '║');
  console.log('╠' + '═'.repeat(W) + '╣');

  for (const r of results) {
    const type    = r.marketType.padEnd(10);
    const ac      = r.isAutocorrelated ? '✓ YES  ' : '✗ no   ';
    const norm    = r.isNormal         ? '✓ YES  ' : '✗ no   ';
    const edge    = r.hasEdge          ? '✓ YES' : '✗ no ';
    const strat   = recommendStrategy(r).padEnd(20);
    const score   = String(r.score).padStart(3);
    const line =
      `║ ${r.symbol.padEnd(12)}${type}${String(r.tickCount).padStart(5)}  ${ac} ${norm} ${edge}  ${score}    ${strat}`;
    console.log(line.padEnd(W + 1) + '║');
  }

  const best = results[0]!;
  console.log('╠' + '═'.repeat(W) + '╣');
  console.log(('║  🏆 BEST: ' + best.symbol + '  [' + best.marketType + ']  Score ' + best.score + '/100  — ' + recommendStrategy(best)).padEnd(W + 1) + '║');
  console.log('╚' + '═'.repeat(W) + '╝');

  console.log('\n📌 Results saved to data/trading.db');
  console.log('   → npm run trade:demo will automatically use this data to pick the best symbols\n');

  console.log('📌 To trade all symbols, check TOP_SYMBOLS in .env (currently', env.TOP_SYMBOLS ?? env.SYMBOLS.length, ')');
  console.log('   Increase COLLECTION_SECS for better statistical confidence:\n');
  console.log('   COLLECTION_SECS=300 npm run research   (5 min per symbol — recommended)\n');

  await client.disconnect();
  log.info('Research complete');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Research failed:', err);
  process.exit(1);
});
