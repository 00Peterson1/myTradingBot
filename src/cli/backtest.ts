#!/usr/bin/env node
/**
 * Entry Point: Backtest Mode
 *
 * Usage: npm run backtest
 *
 * What this does:
 *   1. Opens data/trading.db (created by `npm run research`)
 *   2. Loads historical tick data for each configured symbol
 *   3. Replays ticks through FeatureEngine to reconstruct all features
 *   4. Runs all configured strategies through walk-forward validation
 *   5. Reports rigorous performance metrics (Sharpe, DSR, PBO)
 *   6. Outputs a verdict: EDGE_DETECTED | EDGE_NOT_DETECTED | OVERFIT_RISK_HIGH
 *   7. Does NOT place any trades
 *
 * IMPORTANT: You must run `npm run research` first to collect data.
 *
 * DATA REQUIREMENTS:
 *   - Minimum: 200 ticks per symbol (about 3–4 minutes of collection)
 *   - Recommended: 5,000+ ticks (COLLECTION_SECS=5000 npm run research)
 *   - For all 5 walk-forward folds to run: ~500+ ticks per symbol
 *
 * EMPIRICAL PHILOSOPHY:
 * The goal is NOT to find strategies that backtest well.
 * The goal is to TEST whether a strategy has a real edge
 * that is unlikely to be due to chance or overfitting.
 * A negative result (no edge) is a valid and valuable result.
 */

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';
import { renderBanner, renderMetricsTable, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { MomentumStrategy } from '../strategies/momentum/MomentumStrategy.js';
import { VolAdjMomentumStrategy } from '../strategies/volatility-momentum/VolAdjMomentumStrategy.js';
import { MeanReversionStrategy } from '../strategies/mean-reversion/MeanReversionStrategy.js';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy.js';
import { WalkForwardRunner } from '../backtest/WalkForwardRunner.js';
import { getDb } from '../data/database/sqlite.js';
import { getTickCount, getRecentTicks } from '../data/repository/TickRepository.js';
import { FeatureEngine } from '../features/FeatureEngine.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import type { TickFeatures } from '../types/tick.js';

// Maximum ticks to load per symbol for backtesting.
// Higher = better statistical power, slower replay.
// Override via env: BACKTEST_MAX_TICKS=50000 npm run backtest
const MAX_TICKS = parseInt(process.env['BACKTEST_MAX_TICKS'] ?? '100000', 10);
const MIN_TICKS_REQUIRED = 200;

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('Backtest');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  console.log('🔬 BACKTEST MODE — Walk-Forward Strategy Validation');
  console.log('   No trades will be placed in this mode.\n');

  // ---------------------------------------------------------------------------
  // Open SQLite database
  // ---------------------------------------------------------------------------
  try {
    getDb(); // auto-creates data/trading.db + schema if missing
    log.info('SQLite database opened: data/trading.db');
  } catch (err) {
    console.error('\n❌ Could not open data/trading.db:', (err as Error).message);
    console.error('   Run `npm run research` first to collect tick data.\n');
    process.exit(1);
  }

  const symbols = env.SYMBOLS;

  // ---------------------------------------------------------------------------
  // Define strategy candidates to evaluate
  // ---------------------------------------------------------------------------
  const strategies: Strategy[] = [
    new MomentumStrategy({ lookback: 20, threshold: 0.001, momentumKey: 'mom20' }),
    new MomentumStrategy({ lookback: 50, threshold: 0.002, momentumKey: 'mom50' }),
    new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom20', zThreshold: 1.0 }),
    new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom50', zThreshold: 1.5 }),
    new MeanReversionStrategy({ zScoreKey: 'zScore20', entryThreshold: 1.5, exitThreshold: 0.5 }),
    new MeanReversionStrategy({ zScoreKey: 'zScore50', entryThreshold: 2.0, exitThreshold: 0.5 }),
    new BreakoutStrategy({
      highKey: 'rollingHigh20',
      lowKey: 'rollingLow20',
      confirmationFraction: 0.001,
    }),
    new BreakoutStrategy({
      highKey: 'rollingHigh50',
      lowKey: 'rollingLow50',
      confirmationFraction: 0.002,
    }),
  ];

  const numStrategiesTried = strategies.length;
  log.info(
    { strategies: strategies.map((s) => s.name), count: numStrategiesTried },
    'Strategies to evaluate',
  );

  const walkForwardConfig = {
    trainFraction: 0.6,
    validateFraction: 0.2,
    testFraction: 0.2,
    numFolds: 5,
    minTradesPerFold: 10,
  };

  const runner = new WalkForwardRunner(walkForwardConfig);

  // ---------------------------------------------------------------------------
  // Results collection
  // ---------------------------------------------------------------------------
  const results: Array<{
    strategy: string;
    symbol: string;
    passes: boolean;
    pbo: number | null;
    notes: string[];
  }> = [];

  for (const symbol of symbols) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📊 Symbol: ${symbol}`);
    console.log(`${'='.repeat(70)}`);

    // -------------------------------------------------------------------------
    // Load ticks from SQLite
    // -------------------------------------------------------------------------
    const count = getTickCount(symbol);
    console.log(`  📁 Ticks in database: ${count}`);

    if (count < MIN_TICKS_REQUIRED) {
      console.log(
        `  ⚠️  Insufficient data for ${symbol} (have ${count}, need ≥${MIN_TICKS_REQUIRED} ticks).`,
      );
      console.log(
        `      Run: COLLECTION_SECS=300 npm run research   (5-min collection ≈ ~300 ticks)\n`,
      );
      continue;
    }

    const rawTicks = getRecentTicks(symbol, MAX_TICKS);
    console.log(`  ✅ Loaded ${rawTicks.length} ticks — replaying through FeatureEngine...`);

    // -------------------------------------------------------------------------
    // Replay ticks through FeatureEngine to reconstruct TickFeatures[]
    // -------------------------------------------------------------------------
    const featureEngine = new FeatureEngine(symbol);
    const features: TickFeatures[] = [];

    for (const tick of rawTicks) {
      const f = featureEngine.process(tick);
      features.push(f);
    }

    console.log(`  ✅ Feature replay complete: ${features.length} feature rows ready\n`);

    // -------------------------------------------------------------------------
    // Run walk-forward validation for each strategy
    // -------------------------------------------------------------------------
    for (const strategy of strategies) {
      log.info({ strategy: strategy.name, symbol }, 'Running walk-forward validation');

      try {
        const wfResult = await runner.run(
          features,
          {
            strategy,
            symbol,
            payoutMultiplier: 0.85, // Standard Deriv binary payout
            feePerTrade: 0,
            minConfidence: 0.3,
            contextWindow: 200,
            numTrials: numStrategiesTried,
          },
          numStrategiesTried,
        );

        if (wfResult.aggregatedTestMetrics) {
          renderMetricsTable(
            wfResult.aggregatedTestMetrics,
            `Walk-Forward Test: ${strategy.name} on ${symbol}`,
          );
        }

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

        results.push({
          strategy: strategy.name,
          symbol,
          passes: wfResult.passesRigorousValidation,
          pbo: wfResult.pbo,
          notes: wfResult.validationNotes,
        });
      } catch (err) {
        log.error(
          { strategy: strategy.name, symbol, error: (err as Error).message },
          'Strategy evaluation failed',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n${'='.repeat(70)}`);
  console.log('📋 BACKTEST SUMMARY');
  console.log(`${'='.repeat(70)}`);

  const passing = results.filter((r) => r.passes);
  const failing = results.filter((r) => !r.passes);

  console.log(`\nTotal strategies evaluated: ${results.length}`);
  console.log(`✅ Passing rigorous validation: ${passing.length}`);
  console.log(`❌ Failing validation: ${failing.length}`);

  if (results.length === 0) {
    console.log('\n⚠️  NO STRATEGIES EVALUATED');
    console.log('   Run `npm run research` to collect tick data first.');
    console.log('   Recommended: COLLECTION_SECS=300 npm run research (5 min per symbol)\n');
  } else if (passing.length === 0) {
    console.log('\n⚠️  NO STRATEGIES PASSED RIGOROUS VALIDATION');
    console.log('   This is a VALID scientific result — not a failure.');
    console.log('   It means no robust edge was detected in this data.');
    console.log('   Do NOT lower the validation bar to find a "winner".');
    console.log('   Collect more data and try again: COLLECTION_SECS=3600 npm run research\n');
  } else {
    console.log('\n✅ Strategies that passed:');
    for (const r of passing) {
      console.log(
        `   - ${r.strategy} on ${r.symbol} (PBO: ${r.pbo !== null ? `${(r.pbo * 100).toFixed(1)}%` : 'N/A'})`,
      );
    }
    console.log('\n  Next step: Run demo trading for these strategies ONLY');
    console.log('  Command: npm run trade:demo');
  }

  console.log('\n⚠️  Remember: Backtest results are not guarantees of future performance.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
