#!/usr/bin/env node
/**
 * Entry Point: Research Mode
 *
 * Usage: npm run research
 *
 * What this does:
 *   1. Connects to Deriv WebSocket (demo account)
 *   2. Collects tick data for all configured symbols
 *   3. Computes features and descriptive statistics
 *   4. Runs autocorrelation tests, normality tests
 *   5. Outputs empirical analysis to console and database
 *   6. Does NOT place any trades
 *
 * Purpose: Before developing any strategy, understand the
 * statistical properties of the underlying instrument.
 * Without this step, you are guessing.
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
import type { Tick } from '../types/tick.js';
import type { DerivTick } from '../api/deriv/DerivTypes.js';

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('Research');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  console.log('📊 RESEARCH MODE — Data Collection & Statistical Analysis');
  console.log('   No trades will be placed in this mode.\n');

  const client = new DerivClient();

  await client.connect({ publicOnly: true });
  log.info('Connected to Deriv Public WebSocket Gateway');

  const symbols = env.SYMBOLS;
  const collectionSeconds = 300; // 5 minutes of data collection per symbol
  const minTicksForAnalysis = 100;

  for (const symbol of symbols) {
    log.info({ symbol }, `Starting data collection (${collectionSeconds}s)...`);

    const featureEngine = new FeatureEngine(symbol);
    const rawLogReturns: number[] = [];
    const ticks: Tick[] = [];

    await new Promise<void>((resolve) => {
      const handler = (tick: DerivTick) => {
        if (tick.symbol === symbol) {
          const t: Tick = {
            symbol: tick.symbol,
            epoch: tick.epoch,
            timestamp: new Date(tick.epoch * 1000),
            price: tick.quote,
          };
          ticks.push(t);
          const features = featureEngine.process(t);

          if (features.logReturn1 !== null) {
            rawLogReturns.push(features.logReturn1);
          }
        }
      };

      client.on('tick', handler);
      void client.subscribeTicks(symbol);

      setTimeout(() => {
        client.off('tick', handler);
        resolve();
      }, collectionSeconds * 1_000);
    });

    log.info({ symbol, tickCount: ticks.length }, 'Collection complete');

    if (rawLogReturns.length < minTicksForAnalysis) {
      log.warn(
        { symbol, count: rawLogReturns.length, min: minTicksForAnalysis },
        'Insufficient ticks for statistical analysis',
      );
      continue;
    }

    // ---------------------------------------------------------------------------
    // Statistical Analysis
    // ---------------------------------------------------------------------------

    console.log(`\n=== Statistical Analysis for ${symbol} (${rawLogReturns.length} ticks) ===`);

    // Basic return statistics
    const rMean = mean(rawLogReturns) ?? 0;
    const rStd = stddev(rawLogReturns) ?? 0;
    const rSkew = skewness(rawLogReturns) ?? 0;
    const rKurt = kurtosis(rawLogReturns) ?? 0;

    console.log('\n--- Distribution Moments ---');
    console.log(`Mean (per tick): ${rMean.toExponential(4)}`);
    console.log(`Std Dev:         ${rStd.toExponential(4)}`);
    console.log(`Skewness:        ${rSkew.toFixed(4)} ${rSkew < 0 ? '(left-skewed)' : '(right-skewed)'}`);
    console.log(`Kurtosis (ex):   ${rKurt.toFixed(4)} ${rKurt > 0 ? '(heavy-tailed)' : '(normal)'}`);

    const sharpe = computeSharpe(rawLogReturns);
    if (sharpe) {
      console.log('\n--- Risk-Adjusted Return ---');
      console.log(`Sharpe ratio:   ${sharpe.sharpe.toFixed(4)}`);
      console.log(`Interpretation: ${interpretSharpe(sharpe.sharpe)}`);
    }

    // Autocorrelation test
    const lb = ljungBoxTest(rawLogReturns, 5);
    console.log('\n--- Autocorrelation Test (Ljung-Box, 5 lags) ---');
    if (lb) {
      console.log(`Q-statistic:    ${lb.Q.toFixed(4)}`);
      console.log(`p-value:        ${lb.pValue.toFixed(4)}`);
      console.log(`Autocorrelated? ${lb.rejectH0 ? 'YES (p < 0.05)' : 'NO (random walk)'}`);
      if (lb.rejectH0) {
        console.log('  → Reject random walk null hypothesis at 5% level');
        console.log('  → Potential serial dependence detected — verify causality!');
      } else {
        console.log('  → Cannot reject random walk hypothesis — returns appear i.i.d.');
      }
    }

    // Normality test
    const jb = jarqueBera(rawLogReturns);
    console.log('\n--- Normality Test (Jarque-Bera) ---');
    if (jb) {
      console.log(`Test statistic:  ${jb.JB.toFixed(4)}`);
      console.log(`p-value:         ${jb.pValue.toFixed(4)}`);
      console.log(`Normal?:         ${jb.isNormal ? 'YES' : 'NO (non-normal returns)'}`);
      if (!jb.isNormal) {
        console.log('  → Fat tails / skewness present');
        console.log('  → Standard Sharpe ratio may underestimate tail risk');
      }
    }

    // Conditional probability: do up-ticks follow up-ticks?
    const condProb = conditionalProbability(
      rawLogReturns,
      (i) => (rawLogReturns[i] ?? 0) > 0,
      'previous_return_positive',
    );
    console.log('\n--- Conditional Probability Analysis ---');
    if (condProb) {
      console.log(`P(up):           ${(condProb.unconditional * 100).toFixed(2)}%`);
      console.log(`P(up | prev up): ${(condProb.conditional * 100).toFixed(2)}%`);
      console.log(`Lift:            ${condProb.lift.toFixed(4)}`);
      console.log(`p-value:         ${condProb.pValue.toFixed(4)}`);
      const hasEdge = condProb.lift > 1.05 && condProb.pValue < 0.05;
      console.log(
        `Momentum signal: ${
          hasEdge
            ? '⚠️  Potential momentum edge (verify out-of-sample!)'
            : '✓  No evidence of momentum edge'
        }`,
      );
    }

    console.log('\n--- EMPIRICAL VERDICT ---');
    console.log('DO NOT trade based on this 5-minute sample alone.');
    console.log('Collect at minimum 10,000 ticks before drawing conclusions.');
  }

  await client.disconnect();
  log.info('Research session complete');
  process.exit(0);
}

function interpretSharpe(sharpe: number): string {
  if (sharpe > 2) return 'Excellent (if real) — very likely overfit in short sample';
  if (sharpe > 1) return 'Good — needs walk-forward validation';
  if (sharpe > 0) return 'Positive — insufficient to claim edge';
  return 'Negative — strategy loses on average';
}

main().catch((err: unknown) => {
  console.error('Research failed:', err);
  process.exit(1);
});
