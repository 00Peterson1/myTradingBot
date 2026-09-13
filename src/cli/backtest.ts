#!/usr/bin/env node

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';
import { renderBanner, renderMetricsTable, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { MomentumStrategy } from '../strategies/momentum/MomentumStrategy.js';
import { VolAdjMomentumStrategy } from '../strategies/volatility-momentum/VolAdjMomentumStrategy.js';
import { MeanReversionStrategy } from '../strategies/mean-reversion/MeanReversionStrategy.js';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy.js';
import { WaveletStrategy } from '../strategies/signal/WaveletStrategy.js';
import { EWMSStrategy } from '../strategies/signal/EWMSStrategy.js';
// NOTE: TDQNStrategy and ActorCriticStrategy are intentionally excluded.
// Both have isOnlineLearner = true — they update weights inside generateSignal(),
// meaning they adapt to the test set while being scored on it. This invalidates
// OOS evaluation. A prequential (interleaved train-then-test) protocol is required.
import { WalkForwardRunner } from '../backtest/WalkForwardRunner.js';
import { getDb } from '../data/database/sqlite.js';
import { getTickCount, getRecentTicks } from '../data/repository/TickRepository.js';
import { FeatureEngine } from '../features/FeatureEngine.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import type { TickFeatures } from '../types/tick.js';

const MAX_TICKS = parseInt(process.env.BACKTEST_MAX_TICKS ?? '100000', 10);
const MIN_TICKS_REQUIRED = 200;

async function main(): Promise<void> {
  const env = getEnv();

  const symIdx = process.argv.indexOf('--symbols');
  const cliSymbols = symIdx !== -1 && process.argv[symIdx + 1]
    ? process.argv[symIdx + 1]!.split(',').map((s) => s.trim())
    : null;

  const logLevel = (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') ? env.LOG_LEVEL : 'warn';
  configureLogger(logLevel, env.LOG_PRETTY);
  const log = createLogger('Backtest');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  console.log('🔬 BACKTEST MODE — Walk-Forward Strategy Validation');
  console.log('   No trades will be placed in this mode.\n');

  // Hypothesis alignment: backtest evaluates the SAME contract duration as demo.
  const contractDuration = env.CONTRACT_DURATION;
  const contractDurationUnit = env.CONTRACT_DURATION_UNIT;
  const payoutMultiplier = env.BACKTEST_PAYOUT_MULTIPLIER;

  console.log('📐 Hypothesis (must match demo .env settings):');
  console.log(`   Duration:  ${contractDuration} ${contractDurationUnit === 't' ? 'tick(s)' : contractDurationUnit}`);
  console.log(`   Payout:    ${payoutMultiplier.toFixed(3)}x  (BACKTEST_PAYOUT_MULTIPLIER — verify against Deriv pricing)`);
  console.log('');

  try {
    getDb();
  } catch (err) {
    console.error('\n❌ Could not open data/trading.db:', (err as Error).message);
    console.error('   Run `npm run research` first to collect tick data.\n');
    process.exit(1);
  }

  const db = getDb();
  const dbSymbols = db
    .prepare('SELECT DISTINCT symbol FROM ticks GROUP BY symbol HAVING COUNT(*) >= ?')
    .all(MIN_TICKS_REQUIRED) as {symbol: string}[];
  const allSymbols = dbSymbols.length > 0 ? dbSymbols.map(r => r.symbol) : env.SYMBOLS;

  const symbols = cliSymbols
    ? allSymbols.filter((s) => cliSymbols.includes(s))
    : allSymbols;

  if (cliSymbols) {
    console.log(`🔍 Symbols filter: ${symbols.length > 0 ? symbols.join(', ') : '(none matched)'}`);
  }
  console.log(`\n📋 Symbols to backtest (${symbols.length}):`);
  symbols.forEach(s => { console.log(`   • ${s}`); });

  const walkForwardConfig = {
    trainFraction: 0.6,
    validateFraction: 0.2,
    testFraction: 0.2,
    numFolds: 5,
    minTradesPerFold: 10,
  };

  const runner = new WalkForwardRunner(walkForwardConfig);

  // ---------------------------------------------------------------------------
  // Strategy factories — each provides a FACTORY FUNCTION so BacktestEngine
  // creates a fresh instance per fold period (prevents state bleed).
  // ---------------------------------------------------------------------------
  interface StrategyFactory { name: string; factory: () => Strategy }

  const strategyFactories: StrategyFactory[] = [
    { name: 'Momentum(lookback=20,threshold=0.001)', factory: () => new MomentumStrategy({ lookback: 20, threshold: 0.001, momentumKey: 'mom20' }) },
    { name: 'Momentum(lookback=50,threshold=0.002)', factory: () => new MomentumStrategy({ lookback: 50, threshold: 0.002, momentumKey: 'mom50' }) },
    { name: 'VolAdjMomentum(zThreshold=1.0)',        factory: () => new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom20', zThreshold: 1.0 }) },
    { name: 'VolAdjMomentum(zThreshold=1.5)',        factory: () => new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom50', zThreshold: 1.5 }) },
    { name: 'MeanReversion(z=1.5,exit=0.5)',         factory: () => new MeanReversionStrategy({ zScoreKey: 'zScore20', entryThreshold: 1.5, exitThreshold: 0.5 }) },
    { name: 'MeanReversion(z=2.0,exit=0.5)',         factory: () => new MeanReversionStrategy({ zScoreKey: 'zScore50', entryThreshold: 2.0, exitThreshold: 0.5 }) },
    { name: 'Breakout(window=20,frac=0.001)',         factory: () => new BreakoutStrategy({ highKey: 'rollingHigh20', lowKey: 'rollingLow20', confirmationFraction: 0.001 }) },
    { name: 'Breakout(window=50,frac=0.002)',         factory: () => new BreakoutStrategy({ highKey: 'rollingHigh50', lowKey: 'rollingLow50', confirmationFraction: 0.002 }) },
    { name: 'Wavelet',                               factory: () => new WaveletStrategy() },
    { name: 'EWMS',                                  factory: () => new EWMSStrategy() },
  ];

  const numStrategiesTried = strategyFactories.length;

  const results: {
    strategy: string;
    symbol: string;
    passes: boolean;
    pbo: number | null;
    notes: string[];
    sharpe: number;
    winRate: number;
    trades: number;
  }[] = [];

  let errorsThisRun = 0;

  for (const symbol of symbols) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📊 Symbol: ${symbol}`);
    console.log('='.repeat(70));

    const count = getTickCount(symbol);
    console.log(`  📁 Ticks in database: ${count}`);

    if (count < MIN_TICKS_REQUIRED) {
      console.log(`  ⚠️  Insufficient data for ${symbol} (have ${count}, need ≥${MIN_TICKS_REQUIRED}).`);
      continue;
    }

    const rawTicks = getRecentTicks(symbol, MAX_TICKS);
    console.log(`  ✅ Loaded ${rawTicks.length} ticks — replaying through FeatureEngine...`);

    const featureEngine = new FeatureEngine(symbol);
    const features: TickFeatures[] = [];
    for (const tick of rawTicks) {
      features.push(featureEngine.process(tick));
    }
    console.log(`  ✅ Feature replay complete: ${features.length} rows\n`);

    for (const { name, factory } of strategyFactories) {
      log.info({ strategy: name, symbol }, 'Running walk-forward');

      try {
        const wfResult = await runner.run(
          features,
          {
            strategyFactory: factory,
            strategyName: name,
            symbol,
            payoutMultiplier,
            feePerTrade: 0,
            minConfidence: 0.3,
            contextWindow: 200,
            numTrials: numStrategiesTried,
            contractDuration,
            contractDurationUnit,
          },
          numStrategiesTried,
        );

        const sharpe = wfResult.aggregatedTestMetrics?.sharpeRatio ?? 0;
        const winRate = wfResult.aggregatedTestMetrics?.winRate ?? 0;
        const trades = wfResult.aggregatedTestMetrics?.totalTrades ?? 0;

        if (wfResult.aggregatedTestMetrics) {
          renderMetricsTable(
            wfResult.aggregatedTestMetrics,
            `Walk-Forward Test: ${name} on ${symbol}`,
          );
        }

        console.log(`\n  PBO: ${wfResult.pbo !== null ? `${(wfResult.pbo * 100).toFixed(1)}%` : 'N/A'}`);
        console.log(`  ${wfResult.pboInterpretation}`);
        console.log(`\n  Validation: ${wfResult.passesRigorousValidation ? '✅ PASSES' : '❌ FAILS'}`);
        for (const note of wfResult.validationNotes) {
          console.log(`    ${note}`);
        }

        results.push({ strategy: name, symbol, passes: wfResult.passesRigorousValidation, pbo: wfResult.pbo, notes: wfResult.validationNotes, sharpe, winRate, trades });
      } catch (err) {
        errorsThisRun++;
        const msg = (err as Error).message;
        log.error({ strategy: name, symbol, error: msg }, 'Strategy evaluation failed');
        console.error(`  ❌ ERROR: ${name} on ${symbol}: ${msg}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n${'='.repeat(70)}`);
  console.log('📋 BACKTEST SUMMARY');
  console.log(`${'='.repeat(70)}\n`);

  if (results.length > 0) {
    console.log(`┌──────────────────────────┬──────────┬──────────┬─────────┬───────┬──────────┐`);
    console.log(`│ Strategy                 │ Symbol   │  Sharpe  │ WinRate │Trades │ Verdict  │`);
    console.log(`├──────────────────────────┼──────────┼──────────┼─────────┼───────┼──────────┤`);
    const sorted = [...results].sort((a, b) => b.sharpe - a.sharpe);
    for (const r of sorted) {
      const s  = r.strategy.padEnd(24).substring(0, 24);
      const sy = r.symbol.padEnd(8).substring(0, 8);
      const sh = (r.sharpe ?? 0).toFixed(3).padStart(8);
      const wr = (r.winRate * 100).toFixed(1).padStart(6) + '%';
      const tr = String(r.trades).padStart(5);
      const v  = r.passes ? '✅ PASS' : '❌ FAIL';
      console.log(`│ ${s} │ ${sy} │ ${sh} │ ${wr} │ ${tr} │ ${v.padEnd(8)} │`);
    }
    console.log(`└──────────────────────────┴──────────┴──────────┴─────────┴───────┴──────────┘\n`);
  }

  const passing = results.filter(r => r.passes).length;
  console.log(`  Strategies evaluated: ${results.length}`);
  console.log(`  Passing validation:   ${passing}`);
  console.log(`  Errors:               ${errorsThisRun}`);
  console.log();

  if (results.length === 0 && symbols.length === 0) {
    console.error('❌ No symbols had sufficient data. Run `npm run research` to collect ticks.');
    process.exit(1);
  }

  if (results.length === 0 && errorsThisRun > 0) {
    console.error(`❌ All strategy evaluations failed (${errorsThisRun} errors). See log output above.`);
    process.exit(1);
  }

  if (passing === 0) {
    console.log('  ⚠️  NO EDGE FOUND — No strategy passes rigorous OOS validation.');
    console.log('  This is a valid research result. Collect more data or revise hypotheses.');
  }

  if (errorsThisRun > 0) {
    console.warn(`  ⚠️  ${errorsThisRun} evaluation(s) failed. Results exclude those runs.`);
  }

  console.log('\n  ⚠️  Backtest results are not guarantees of future performance.');
  console.log('  Payout assumptions and zero-latency execution cannot be exactly replicated.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
