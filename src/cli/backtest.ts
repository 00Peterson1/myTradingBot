#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('backtest', 'Preliminary Options simulation. --symbols SYMBOL,...; no account orders.');
import { fileURLToPath } from 'node:url';
import { ExperimentRegistry, captureResearchCode } from '../research/experiments/ExperimentRegistry.js';
import { print } from '../monitoring/print.js';
import { assertDefined } from '../utils/assertDefined.js';

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
import { ValidationStudy } from '../backtest/ValidationStudy.js';
import { getDb } from '../data/database/sqlite.js';
import { getTickCount, getRecentTicks } from '../data/repository/TickRepository.js';
import { FeatureEngine } from '../features/FeatureEngine.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import type { TickFeatures } from '../types/tick.js';

const MAX_TICKS = parseInt(process.env.BACKTEST_MAX_TICKS ?? '100000', 10);
const MIN_TICKS_REQUIRED = 500;

async function main(): Promise<void> {
  const env = getEnv();
  const verbose = process.argv.includes('--verbose');

  const symIdx = process.argv.indexOf('--symbols');
  const cliSymbols = symIdx !== -1 && process.argv[symIdx + 1]
    ? assertDefined(process.argv[symIdx + 1]).split(',').map((s) => s.trim())
    : null;

  const logLevel = (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') ? env.LOG_LEVEL : 'warn';
  configureLogger(logLevel, env.LOG_PRETTY);
  const log = createLogger('Backtest');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  print('🔬 BACKTEST MODE — Walk-Forward Strategy Validation');
  print('   No trades will be placed in this mode.\n');

  // Hypothesis alignment: backtest evaluates the SAME contract duration as demo.
  const contractDuration = env.CONTRACT_DURATION;
  const contractDurationUnit = env.CONTRACT_DURATION_UNIT;
  const payoutMultiplier = env.BACKTEST_PAYOUT_MULTIPLIER;

  print('📐 Hypothesis (must match demo .env settings):');
  print(`   Duration:  ${String(contractDuration)} ${contractDurationUnit === 't' ? 'tick(s)' : contractDurationUnit}`);
  print(`   Payout:    ${payoutMultiplier.toFixed(3)}x  (BACKTEST_PAYOUT_MULTIPLIER — verify against Deriv pricing)`);
  print('');

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
    print(`🔍 Symbols filter: ${symbols.length > 0 ? symbols.join(', ') : '(none matched)'}`);
  }
  print(`\n📋 Symbols to backtest (${String(symbols.length)}):`);
  symbols.forEach(s => { print(`   • ${s}`); });

  const walkForwardConfig = {
    trainFraction: 0.6,
    validateFraction: 0.2,
    testFraction: 0.2,
    numFolds: 5,
    minTradesPerFold: 10,
  };

  const registry = new ExperimentRegistry(getDb(), captureResearchCode(fileURLToPath(new URL('../../', import.meta.url))));

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
    print(`\n${'='.repeat(70)}`);
    print(`📊 Symbol: ${symbol}`);
    print('='.repeat(70));

    const count = getTickCount(symbol);
    print(`  📁 Ticks in database: ${String(count)}`);

    if (count < MIN_TICKS_REQUIRED) {
      print(`  ⚠️  Insufficient data for ${symbol} (have ${String(count)}, need ≥${String(MIN_TICKS_REQUIRED)}).`);
      continue;
    }

    const rawTicks = getRecentTicks(symbol, MAX_TICKS);
    print(`  ✅ Loaded ${String(rawTicks.length)} ticks — replaying through FeatureEngine...`);

    const featureEngine = new FeatureEngine(symbol);
    const features: TickFeatures[] = [];
    for (const tick of rawTicks) {
      features.push(featureEngine.process(tick));
    }
    print(`  ✅ Feature replay complete: ${String(features.length)} rows\n`);

    try {
      const study = await new ValidationStudy(registry, walkForwardConfig).run(features, strategyFactories.map(({ name, factory }) => ({
        id: name, family: name.split('(')[0] ?? name,
        config: { strategyFactory: factory, registry, strategyDeclaration: { name, factorySource: factory.toString() },
          strategyName: name, symbol, payoutMultiplier, feePerTrade: 0, minConfidence: env.MIN_CONSENSUS_CONFIDENCE,
          contextWindow: 200, contractDuration, contractDurationUnit },
      })));
      print(`  Study: ${study.verdict}; recorded hypotheses: ${String(study.trials)}; selected: ${study.selectedId ?? 'none'}`);
      for (const candidate of study.candidates) {
        const metrics = candidate.development.aggregatedTestMetrics;
        const supported = study.verdict === 'HOLDOUT_SUPPORTED' && study.selectedId === candidate.id;
        results.push({ strategy: candidate.id, symbol, passes: supported, pbo: null,
          notes: candidate.development.validationNotes, sharpe: metrics?.sharpeRatio ?? 0,
          winRate: metrics?.winRate ?? 0, trades: metrics?.totalTrades ?? 0 });
        if (verbose && metrics) {
          renderMetricsTable(metrics, `Development walk-forward: ${candidate.id}`);
          print(`  BY-adjusted selection p-value: ${String(candidate.adjustedPValue)}`);
          for (const fold of candidate.development.folds) print(`  Experiment ${fold.run.experimentId ?? 'unregistered'}`);
        }
      }
      if (study.finalRun && verbose) renderMetricsTable(study.finalRun.testMetrics, 'One-time final holdout');
    } catch (error) {
      errorsThisRun++;
      log.error({ symbol, error: error instanceof Error ? error.message : 'Unknown study failure' }, 'Validation study failed');
      console.error(`Study failed for ${symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  print(`\n${'='.repeat(70)}`);
  print('📋 BACKTEST SUMMARY');
  print(`${'='.repeat(70)}\n`);

  if (results.length > 0) {
    print(`┌──────────────────────────┬──────────┬──────────┬─────────┬───────┬──────────┐`);
    print(`│ Strategy                 │ Symbol   │  Sharpe  │ WinRate │Trades │ Verdict  │`);
    print(`├──────────────────────────┼──────────┼──────────┼─────────┼───────┼──────────┤`);
    const sorted = results;
    for (const r of sorted) {
      const s  = r.strategy.padEnd(24).substring(0, 24);
      const sy = r.symbol.padEnd(8).substring(0, 8);
      const sh = r.sharpe.toFixed(3).padStart(8);
      const wr = (r.winRate * 100).toFixed(1).padStart(6) + '%';
      const tr = String(r.trades).padStart(5);
      const v  = r.passes ? '✅ PASS' : '❌ FAIL';
      print(`│ ${s} │ ${sy} │ ${sh} │ ${wr} │ ${tr} │ ${v.padEnd(8)} │`);
    }
    print(`└──────────────────────────┴──────────┴──────────┴─────────┴───────┴──────────┘\n`);
  }

  const passing = results.filter(r => r.passes).length;
  print(`  Strategies evaluated: ${String(results.length)}`);
  print(`  Passing validation:   ${String(passing)}`);
  print(`  Errors:               ${String(errorsThisRun)}`);
  print();

  if (results.length === 0 && errorsThisRun === 0) {
    console.error('❌ INSUFFICIENT_DATA — No experiments completed. Collect ticks with npm run research:daemon.');
    process.exit(1);
  }

  if (results.length === 0 && errorsThisRun > 0) {
    console.error(`❌ All strategy evaluations failed (${String(errorsThisRun)} errors). See log output above.`);
    process.exit(1);
  }

  if (passing === 0) {
    print('  ⚠️  INSUFFICIENT_EVIDENCE — No candidate passed the preliminary simulation checks.');
    print('  This is a valid research result. Collect more data or revise hypotheses.');
  }

  if (errorsThisRun > 0) {
    console.warn(`  ⚠️  ${String(errorsThisRun)} evaluation(s) failed. Results exclude those runs.`);
  }

  print('\n  ⚠️  Backtest results are not guarantees of future performance.');
  print('  Fixed payouts and declared entry delay are simulation assumptions, not historical broker quotes.');
  process.exit(errorsThisRun > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
