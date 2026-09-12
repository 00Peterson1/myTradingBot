#!/usr/bin/env node
/**
 * Entry Point: Demo Trading
 *
 * Usage: npm run trade:demo
 *
 * SAFETY: This uses your Deriv DEMO account (virtual money).
 * Live trading is DISABLED and requires explicit env flag + confirmation.
 *
 * What this does:
 *   1. Validates configuration and safety flags
 *   2. Connects to Deriv WebSocket (demo account)
 *   3. Subscribes to tick data for configured symbols
 *   4. Runs approved strategies (those that passed backtesting)
 *   5. Generates signals → risk engine → execution (demo orders only)
 *   6. Logs all trades and P&L to database
 *   7. Prints live dashboard every 30 seconds
 *
 * PREREQUISITE:
 *   - npm run research (collect data, understand market)
 *   - npm run backtest (validate strategy — must PASS)
 *   - Only strategies that passed walk-forward should be traded
 */

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv, isLiveTradingEnabled } from '../config/env.js';
import { renderBanner, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { FeatureEngine } from '../features/FeatureEngine.js';
import { RiskEngine } from '../risk/RiskEngine.js';
import { DerivExecutionEngine } from '../execution/DerivExecutionEngine.js';
import { MomentumStrategy } from '../strategies/momentum/MomentumStrategy.js';
import type { Strategy } from '../strategies/base/Strategy.js';
import type { TickFeatures } from '../types/tick.js';
import type { Tick } from '../types/tick.js';

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('DemoTrading');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  // ---------------------------------------------------------------------------
  // Safety checks
  // ---------------------------------------------------------------------------

  if (!env.DEMO_TRADING) {
    console.error('❌ DEMO_TRADING=false in environment. Refusing to start.');
    process.exit(1);
  }

  if (isLiveTradingEnabled()) {
    console.error(
      '⚠️  LIVE_TRADING is enabled! This CLI is for demo only.\n' +
        '   To trade live, use a separate, dedicated live trading script.',
    );
    process.exit(1);
  }

  console.log('✅ Running in DEMO mode (virtual money — no real funds at risk)');
  console.log('   Press Ctrl+C to stop.\n');

  // ---------------------------------------------------------------------------
  // Strategy selection
  // WARNING: Only use strategies that have PASSED walk-forward validation.
  // Hardcoding a strategy here without validation evidence is gambling.
  // ---------------------------------------------------------------------------

  const strategies: Strategy[] = [
    // TODO: Load only strategies that have passed walk-forward validation
    // Replace this placeholder with your validated strategy
    new MomentumStrategy({ lookback: 20, threshold: 0.001, momentumKey: 'mom20' }),
  ];

  log.warn(
    { strategies: strategies.map((s) => s.name) },
    '⚠️  Using placeholder strategy — must replace with walk-forward validated strategy',
  );

  // ---------------------------------------------------------------------------
  // Connect to Deriv
  // ---------------------------------------------------------------------------

  const client = new DerivClient();

  await client.connect();
  log.info('Connected to Deriv WebSocket (demo account)');

  // ---------------------------------------------------------------------------
  // Initialize per-symbol state
  // ---------------------------------------------------------------------------

  const featureEngines = new Map<string, FeatureEngine>();
  const featureHistory = new Map<string, TickFeatures[]>();
  const CONTEXT_WINDOW = 200;

  for (const symbol of env.SYMBOLS) {
    featureEngines.set(symbol, new FeatureEngine(symbol));
    featureHistory.set(symbol, []);
  }

  // ---------------------------------------------------------------------------
  // Risk engine — single instance per session
  // ---------------------------------------------------------------------------

  const initialBalance = 10_000; // TODO: fetch real demo balance from Deriv
  const riskEngine = new RiskEngine(initialBalance);

  // ---------------------------------------------------------------------------
  // Execution engine — DEMO only
  // ---------------------------------------------------------------------------

  const executor = new DerivExecutionEngine(client);
  if (executor.getMode() !== 'DEMO') {
    log.error('CRITICAL: Execution engine is not in DEMO mode — aborting');
    await client.disconnect();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Main trading loop
  // ---------------------------------------------------------------------------

  let signalsGenerated = 0;
  let signalsApproved = 0;
  let signalsRejected = 0;

  log.info({ symbols: env.SYMBOLS }, 'Starting demo trading loop');

  client.on('tick', async (rawTick) => {
    const tick: Tick = {
      symbol: rawTick.symbol,
      epoch: rawTick.epoch,
      timestamp: new Date(rawTick.epoch * 1000),
      price: rawTick.quote,
    };
    const symbol = tick.symbol;
    const featureEngine = featureEngines.get(symbol);
    const history = featureHistory.get(symbol);

    if (!featureEngine || !history) return;

      const features = featureEngine.process(tick);

      // Maintain context window
      history.push(features);
      if (history.length > CONTEXT_WINDOW) {
        history.shift();
      }

      // Generate signals from all strategies
      for (const strategy of strategies) {
        const signal = strategy.generateSignal(features, history.slice(0, -1));
        signalsGenerated++;

        if (signal.direction === 'NONE') continue;

        // Risk engine evaluation
        const decision = riskEngine.evaluate(signal, 'DEMO');

        if (!decision.approved) {
          signalsRejected++;
          log.debug(
            { reason: decision.reason, signal: signal.id },
            'Signal rejected by risk engine',
          );
          continue;
        }

        signalsApproved++;
        log.info(
          {
            symbol,
            direction: signal.direction,
            strategy: strategy.name,
            stake: decision.approvedSignal.stakeAmount,
            confidence: signal.confidence,
          },
          '[DEMO] Signal approved — placing order',
        );

        try {
          const trade = await executor.execute(decision.approvedSignal);

          // TODO: Wait for contract expiry then fetch result
          // For now, log the open trade
          log.info(
            { contractId: trade.contractId, entryPrice: trade.entryPrice },
            '[DEMO] Contract opened',
          );

          // TODO: Store trade in database
          // TODO: After expiry, call executor.settle(trade) and riskEngine.recordTradeResult(profit)
        } catch (err) {
          log.error(
            { error: (err as Error).message, symbol, strategy: strategy.name },
            '[DEMO] Order placement failed',
          );
        }
      }
  });

  for (const symbol of env.SYMBOLS) {
    void client.subscribeTicks(symbol);
  }

  // ---------------------------------------------------------------------------
  // Status reporter
  // ---------------------------------------------------------------------------

  setInterval(() => {
    const state = riskEngine.getState();
    console.log('\n📊 Demo Trading Status:');
    console.log(`   Balance:       $${state.currentBalance.toFixed(2)}`);
    console.log(`   Peak:          $${state.peakBalance.toFixed(2)}`);
    console.log(`   Total trades:  ${state.totalTrades}`);
    console.log(
      `   Signals:       ${signalsGenerated} generated, ${signalsApproved} approved, ${signalsRejected} rejected`,
    );
    console.log(`   Loss streak:   ${state.consecutiveLosses}`);
    console.log(`   Kill switch:   ${state.killSwitchActive ? '🔴 ACTIVE' : '✅ OK'}`);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  process.on('SIGINT', async () => {
    log.info('Shutting down demo trading...');
    await client.disconnect();
    const state = riskEngine.getState();
    console.log('\n📊 Final Session Summary:');
    console.log(`   Total trades: ${state.totalTrades}`);
    console.log(`   Final balance: $${state.currentBalance.toFixed(2)}`);
    console.log(`   P&L: $${(state.currentBalance - state.sessionStartBalance).toFixed(2)}`);
    process.exit(0);
  });

  // Keep process alive
  await new Promise<never>(() => {
    /* infinite */
  });
}

main().catch((err: unknown) => {
  console.error('Demo trading failed:', err);
  process.exit(1);
});
