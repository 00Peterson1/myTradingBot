#!/usr/bin/env node
/**
 * Entry Point: Backtest Mode
 *
 * Usage: npm run backtest
 *
 * What this does:
 *   1. Opens data/trading.db — queries ALL symbols with enough ticks
 *   2. Loads historical tick data for each symbol
 *   3. Replays ticks through FeatureEngine to reconstruct all features
 *   4. Runs ALL strategy candidates through walk-forward validation
 *   5. Reports rigorous performance metrics (Sharpe, DSR, PBO)
 *   6. Outputs a ranked leaderboard + verdict per strategy/symbol pair
 *   7. Does NOT place any trades
 *
 * Strategies tested:
 *   Momentum, VolAdjMomentum, MeanReversion, Breakout (classical)
 *   Wavelet (Haar DWT), EWMS (LSTM approximation)
 *   TDQN (tabular deep Q-network), ActorCritic (linear function approximation)
 *
 * DATA REQUIREMENTS:
 *   - Minimum: 200 ticks per symbol
 *   - Recommended: 5,000+ ticks
 *   - Source: run `npm run research` or `npm run research:daemon`
 */

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';
import { renderBanner, renderMetricsTable, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { MomentumStrategy } from '../strategies/momentum/MomentumStrategy.js';
import { VolAdjMomentumStrategy } from '../strategies/volatility-momentum/VolAdjMomentumStrategy.js';
import { MeanReversionStrategy } from '../strategies/mean-reversion/MeanReversionStrategy.js';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy.js';
import { WaveletStrategy } from '../strategies/signal/WaveletStrategy.js';
import { EWMSStrategy } from '../strategies/signal/EWMSStrategy.js';
import { TDQNStrategy } from '../strategies/rl/TDQNStrategy.js';
import { ActorCriticStrategy } from '../strategies/rl/ActorCriticStrategy.js';
import { WalkForwardRunner } from '../backtest/WalkForwardRunner.js';
import { getDb } from '../data/database/sqlite.js';
import { getTickCount, getRecentTicks } from '../data/repository/TickRepository.js';
import { FeatureEngine } from '../features/FeatureEngine.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import type { TickFeatures } from '../types/tick.js';

const MAX_TICKS = parseInt(process.env['BACKTEST_MAX_TICKS'] ?? '100000', 10);
const MIN_TICKS_REQUIRED = 200;

// ---------------------------------------------------------------------------
// Leaderboard entry
// ---------------------------------------------------------------------------
interface LeaderboardEntry {
  strategy: string;
  symbol: string;
  sharpe: number | null;
  winRate: number | null;
  passes: boolean;
  pbo: number | null;
  notes: string[];
}

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('Backtest');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  console.log('🔬 BACKTEST MODE — Walk-Forward Strategy Validation');
  console.log('   Tests ALL strategies across ALL symbols in the database.');
  console.log('   No trades will be placed.\n');

  // ---------------------------------------------------------------------------
  // Open SQLite and discover symbols with sufficient data
  // ---------------------------------------------------------------------------
  const db = (() => {
    try {
      return getDb();
    } catch (err) {
      console.error('\n❌ Could not open data/trading.db:', (err as Error).message);
      console.error('   Run `npm run research` or `npm run research:daemon` first.\n');
      process.exit(1);
    }
  })();

  // Query all symbols from DB that have enough ticks
  type SymbolRow = { symbol: string; cnt: number };
  const dbSymbols = db
    .prepare<[number], SymbolRow>(
      'SELECT symbol, COUNT(*) as cnt FROM ticks GROUP BY symbol HAVING cnt >= ?',
    )
    .all(MIN_TICKS_REQUIRED);

  const symbols: string[] =
    dbSymbols.length > 0 ? dbSymbols.map((r) => r.symbol) : env.SYMBOLS;

  if (symbols.length === 0) {
    console.log('⚠️  No symbols with sufficient data found.');
    console.log('   Run: npm run research:daemon   to start collecting data.');
    console.log('   Run: npm run markets            to browse available markets.\n');
    process.exit(0);
  }

  console.log(
    `📊 Symbols to backtest: ${symbols.length} (all with ≥${MIN_TICKS_REQUIRED} ticks in DB)`,
  );
  symbols.forEach((s) => {
    const cnt = dbSymbols.find((r) => r.symbol === s)?.cnt ?? getTickCount(s);
    console.log(`   ${s.padEnd(16)} ${String(cnt).padStart(7)} ticks`);
  });
  console.log();

  const walkForwardConfig = {
    trainFraction: 0.6,
    validateFraction: 0.2,
    testFraction: 0.2,
    numFolds: 5,
    minTradesPerFold: 10,
  };
  const runner = new WalkForwardRunner(walkForwardConfig);
  const leaderboard: LeaderboardEntry[] = [];

  // ---------------------------------------------------------------------------
  // Per-symbol evaluation
  // ---------------------------------------------------------------------------
  for (const symbol of symbols) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`📊 Symbol: ${symbol}`);
    console.log(`${'='.repeat(72)}`);

    const rawTicks = getRecentTicks(symbol, MAX_TICKS);
    if (rawTicks.length < MIN_TICKS_REQUIRED) {
      console.log(`  ⚠️  Skipping ${symbol} — only ${rawTicks.length} ticks`);
      continue;
    }

    console.log(`  ✅ Loaded ${rawTicks.length} ticks — replaying through FeatureEngine...`);

    const featureEngine = new FeatureEngine(symbol);
    const features: TickFeatures[] = rawTicks.map((t) => featureEngine.process(t));
    console.log(`  ✅ ${features.length} feature rows ready\n`);

    // Build per-symbol strategy suite (RL strategies need symbol parameter)
    const strategies: Strategy[] = [
      new MomentumStrategy({ lookback: 20, threshold: 0.001, momentumKey: 'mom20' }),
      new MomentumStrategy({ lookback: 50, threshold: 0.002, momentumKey: 'mom50' }),
      new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom20', zThreshold: 1.0 }),
      new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom50', zThreshold: 1.5 }),
      new MeanReversionStrategy({ zScoreKey: 'zScore20', entryThreshold: 1.5, exitThreshold: 0.5 }),
      new MeanReversionStrategy({ zScoreKey: 'zScore50', entryThreshold: 2.0, exitThreshold: 0.5 }),
      new BreakoutStrategy({ highKey: 'rollingHigh20', lowKey: 'rollingLow20', confirmationFraction: 0.001 }),
      new BreakoutStrategy({ highKey: 'rollingHigh50', lowKey: 'rollingLow50', confirmationFraction: 0.002 }),
      new WaveletStrategy(),
      new EWMSStrategy(),
      new TDQNStrategy({ symbol }),
      new ActorCriticStrategy({ symbol }),
    ];

    const numStrategies = strategies.length;

    for (const strategy of strategies) {
      log.info({ strategy: strategy.name, symbol }, 'Walk-forward validation');

      try {
        const wfResult = await runner.run(
          features,
          {
            strategy,
            symbol,
            payoutMultiplier: 0.85,
            feePerTrade: 0,
            minConfidence: 0.3,
            contextWindow: 200,
            numTrials: numStrategies,
          },
          numStrategies,
        );

        if (wfResult.aggregatedTestMetrics) {
          renderMetricsTable(
            wfResult.aggregatedTestMetrics,
            `${strategy.name} on ${symbol}`,
          );
        }

        const sharpe = wfResult.aggregatedTestMetrics?.sharpeRatio ?? null;
        const winRate = wfResult.aggregatedTestMetrics?.winRate ?? null;

        console.log(
          `\n  PBO: ${wfResult.pbo !== null ? `${(wfResult.pbo * 100).toFixed(1)}%` : 'N/A'}`,
        );
        console.log(`  ${wfResult.pboInterpretation}`);
        console.log(
          `\n  Validation: ${wfResult.passesRigorousValidation ? '✅ PASSES' : '❌ FAILS'}`,
        );
        for (const note of wfResult.validationNotes) {
          console.log(`    ${note}`);
        }

        leaderboard.push({
          strategy: strategy.name,
          symbol,
          sharpe,
          winRate,
          passes: wfResult.passesRigorousValidation,
          pbo: wfResult.pbo,
          notes: wfResult.validationNotes,
        });
      } catch (err) {
        log.error({ strategy: strategy.name, symbol, error: (err as Error).message }, 'Evaluation failed');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy Leaderboard
  // ---------------------------------------------------------------------------
  if (leaderboard.length > 0) {
    leaderboard.sort((a, b) => {
      // Passing first, then by Sharpe
      if (a.passes !== b.passes) return a.passes ? -1 : 1;
      return (b.sharpe ?? -999) - (a.sharpe ?? -999);
    });

    const col = (s: string, w: number) => s.padEnd(w).slice(0, w);

    console.log(`\n${'='.repeat(72)}`);
    console.log('📋 STRATEGY LEADERBOARD — Sorted by Sharpe Ratio');
    console.log('='.repeat(72));
    console.log(
      `  ${'Strategy'.padEnd(32)} ${'Symbol'.padEnd(14)} ${'Sharpe'.padEnd(8)} ${'WinRate'.padEnd(9)} Verdict`,
    );
    console.log('  ' + '─'.repeat(70));

    for (const e of leaderboard) {
      const sharpeStr = e.sharpe !== null ? e.sharpe.toFixed(2).padStart(6) : '  N/A';
      const wrStr = e.winRate !== null ? `${(e.winRate * 100).toFixed(1)}%`.padStart(7) : '    N/A';
      const verdict = e.passes ? '✅ PASS' : '❌ FAIL';
      console.log(
        `  ${col(e.strategy, 32)} ${col(e.symbol, 14)} ${sharpeStr}   ${wrStr}   ${verdict}`,
      );
    }

    const passing = leaderboard.filter((r) => r.passes);
    console.log('  ' + '─'.repeat(70));
    console.log(`  ${passing.length}/${leaderboard.length} strategy/symbol pairs passed rigorous validation`);

    if (passing.length > 0) {
      console.log('\n✅ Recommended for demo trading:');
      for (const r of passing.slice(0, 5)) {
        console.log(
          `   • ${r.strategy} on ${r.symbol} (Sharpe: ${r.sharpe?.toFixed(2) ?? 'N/A'}, PBO: ${r.pbo !== null ? `${(r.pbo * 100).toFixed(1)}%` : 'N/A'})`,
        );
      }
      console.log('\n  Next: npm run trade:demo');
      console.log('  More data: npm run research:daemon');
      console.log('  Browse markets: npm run markets');
    } else {
      console.log('\n⚠️  No strategies passed — collect more data:');
      console.log('   npm run research:daemon  (let it run for several hours)');
      console.log('   npm run markets          (browse all available markets)');
    }
  }

  console.log('\n⚠️  Backtest results are not guarantees of future performance.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
