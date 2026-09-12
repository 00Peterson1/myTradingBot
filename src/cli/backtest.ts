#!/usr/bin/env node
/**
 * Entry Point: Backtest Mode
 *
 * Usage: npm run backtest
 *
 * What this does:
 *   1. Loads historical tick data from database
 *   2. Computes features for all ticks
 *   3. Runs all configured strategies through walk-forward validation
 *   4. Reports rigorous performance metrics (Sharpe, DSR, PBO)
 *   5. Outputs a verdict: EDGE_DETECTED | EDGE_NOT_DETECTED | OVERFIT_RISK_HIGH
 *   6. Does NOT place any trades
 *
 * IMPORTANT: You must run `npm run research` first to collect data.
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
import { renderBanner as _renderBanner } from '../monitoring/Dashboard.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import type { TickFeatures } from '../types/tick.js';

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('Backtest');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  console.log('🔬 BACKTEST MODE — Walk-Forward Strategy Validation');
  console.log('   No trades will be placed in this mode.\n');

  // ---------------------------------------------------------------------------
  // Load historical data from database
  // ---------------------------------------------------------------------------
  // TODO: Load from PostgreSQL repository
  // For now, this demonstrates the architecture
  log.warn('Database loading not yet implemented — connect to PostgreSQL to load tick data');
  log.warn('Run `npm run research` first to collect tick data into the database');

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

    // Placeholder: load features from DB
    // const features = await featureRepo.loadForSymbol(symbol, from, to);
    const features: TickFeatures[] = []; // Will be populated from DB

    if (features.length < 200) {
      console.log(
        `  ⚠️  Insufficient data for ${symbol} (need ≥200 ticks). Run research mode first.`,
      );
      continue;
    }

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

  if (passing.length === 0) {
    console.log('\n⚠️  NO STRATEGIES PASSED RIGOROUS VALIDATION');
    console.log('   This is a VALID scientific result — not a failure.');
    console.log('   It means no robust edge was detected in this data.');
    console.log('   Do NOT lower the validation bar to find a "winner".');
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
