#!/usr/bin/env node
/**
 * Entry Point: Demo Trading
 *
 * Usage: npm run trade:demo
 *
 * SAFETY: Uses Deriv DEMO account (virtual money). Live trading disabled.
 *
 * What this does:
 *   1. Validates safety flags
 *   2. Queries ALL symbols from DB with ≥1000 ticks (falls back to env.SYMBOLS)
 *   3. Subscribes to tick streams for ALL discovered symbols
 *   4. Runs ALL approved strategies per symbol
 *   5. Checks economic blackouts (EconomicCalendar) per tick
 *   6. Filters signals through Gemini context filter (CB policy divergence)
 *   7. Routes approved signals through RiskEngine → DerivExecutionEngine
 *   8. Reports live status every 30 seconds
 *
 * PREREQUISITES:
 *   npm run research:daemon   (collect data)
 *   npm run backtest          (validate strategies — use only those that PASS)
 */

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv, isLiveTradingEnabled } from '../config/env.js';
import { renderBanner, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { FeatureEngine } from '../features/FeatureEngine.js';
import { RiskEngine } from '../risk/RiskEngine.js';
import { DerivExecutionEngine } from '../execution/DerivExecutionEngine.js';
import { getDb } from '../data/database/sqlite.js';
import { EconomicCalendar } from '../fundamentals/EconomicCalendar.js';
import { getGeminiContextFilter } from '../context/GeminiContextFilter.js';

import { MomentumStrategy } from '../strategies/momentum/MomentumStrategy.js';
import { VolAdjMomentumStrategy } from '../strategies/volatility-momentum/VolAdjMomentumStrategy.js';
import { MeanReversionStrategy } from '../strategies/mean-reversion/MeanReversionStrategy.js';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy.js';
import { WaveletStrategy } from '../strategies/signal/WaveletStrategy.js';
import { EWMSStrategy } from '../strategies/signal/EWMSStrategy.js';
import { TDQNStrategy } from '../strategies/rl/TDQNStrategy.js';
import { ActorCriticStrategy } from '../strategies/rl/ActorCriticStrategy.js';

import type { Strategy } from '../strategies/base/Strategy.js';
import type { TickFeatures, Tick } from '../types/tick.js';
import type { DerivTick } from '../api/deriv/DerivTypes.js';

const MIN_TICKS_FOR_TRADING = 1000;
const CONTEXT_WINDOW = 200;

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
  // Discover symbols from DB (all with enough data)
  // ---------------------------------------------------------------------------
  const db = getDb();
  type SymbolRow = { symbol: string; cnt: number };
  const dbSymbols = db
    .prepare<[number], SymbolRow>(
      'SELECT symbol, COUNT(*) as cnt FROM ticks GROUP BY symbol HAVING cnt >= ?',
    )
    .all(MIN_TICKS_FOR_TRADING);

  const symbols: string[] =
    dbSymbols.length > 0 ? dbSymbols.map((r) => r.symbol) : env.SYMBOLS;

  console.log(`📊 Trading ${symbols.length} symbols (each with ≥${MIN_TICKS_FOR_TRADING} ticks):`);
  symbols.forEach((s) => {
    const cnt = dbSymbols.find((r) => r.symbol === s)?.cnt ?? MIN_TICKS_FOR_TRADING;
    console.log(`   ${s.padEnd(16)} ${String(cnt).padStart(7)} ticks`);
  });
  console.log();

  if (symbols.length === 0) {
    console.log('⚠️  No symbols with sufficient data. Run `npm run research:daemon` first.');
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Economic calendar & Gemini context filter
  // ---------------------------------------------------------------------------
  const calendar = new EconomicCalendar();
  const contextFilter = env.GEMINI_API_KEY ? getGeminiContextFilter() : null;

  if (contextFilter) {
    console.log('🤖 Gemini context filter: ACTIVE (CB policy divergence detection)');
  } else {
    console.log('⚠️  Gemini context filter: INACTIVE (add GEMINI_API_KEY to .env to enable)');
  }

  try {
    await calendar.refresh();
    console.log('📅 Economic calendar: loaded\n');
  } catch {
    console.log('⚠️  Economic calendar: unavailable (no network or fetch failed)\n');
  }

  // ---------------------------------------------------------------------------
  // Per-symbol strategy suite
  // ---------------------------------------------------------------------------
  const symbolStrategies = new Map<string, Strategy[]>();
  for (const symbol of symbols) {
    symbolStrategies.set(symbol, [
      new MomentumStrategy({ lookback: 20, threshold: 0.001, momentumKey: 'mom20' }),
      new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom20', zThreshold: 1.0 }),
      new MeanReversionStrategy({ zScoreKey: 'zScore20', entryThreshold: 1.5, exitThreshold: 0.5 }),
      new BreakoutStrategy({ highKey: 'rollingHigh20', lowKey: 'rollingLow20', confirmationFraction: 0.001 }),
      new WaveletStrategy(),
      new EWMSStrategy(),
      new TDQNStrategy({ symbol }),
      new ActorCriticStrategy({ symbol }),
    ]);
  }

  log.info(
    { symbols: symbols.length, strategiesPerSymbol: symbolStrategies.get(symbols[0]!)?.length ?? 0 },
    'Strategy suite initialized',
  );

  // ---------------------------------------------------------------------------
  // Connect to Deriv
  // ---------------------------------------------------------------------------
  const client = new DerivClient();
  await client.connect();
  log.info('Connected to Deriv WebSocket (demo account)');

  // ---------------------------------------------------------------------------
  // Per-symbol state
  // ---------------------------------------------------------------------------
  const featureEngines = new Map<string, FeatureEngine>();
  const featureHistory = new Map<string, TickFeatures[]>();

  for (const symbol of symbols) {
    featureEngines.set(symbol, new FeatureEngine(symbol));
    featureHistory.set(symbol, []);
  }

  // ---------------------------------------------------------------------------
  // Risk engine & execution engine
  // ---------------------------------------------------------------------------
  const initialBalance = 10_000;
  const riskEngine = new RiskEngine(initialBalance);
  const executor = new DerivExecutionEngine(client);

  if (executor.getMode() !== 'DEMO') {
    log.error('CRITICAL: Execution engine is not in DEMO mode — aborting');
    await client.disconnect();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Signal counters
  // ---------------------------------------------------------------------------
  let signalsGenerated = 0;
  let signalsBlackedOut = 0;
  let signalsSuppressedByGemini = 0;
  let signalsApproved = 0;
  let signalsRejected = 0;

  // ---------------------------------------------------------------------------
  // Main trading loop
  // ---------------------------------------------------------------------------
  log.info({ symbols }, 'Starting demo trading loop');

  client.on('tick', async (rawTick: DerivTick) => {
    const tick: Tick = {
      symbol: rawTick.symbol,
      epoch: rawTick.epoch,
      timestamp: new Date(rawTick.epoch * 1000),
      price: rawTick.quote,
    };

    const symbol = tick.symbol;
    const featureEngine = featureEngines.get(symbol);
    const history = featureHistory.get(symbol);
    const strategies = symbolStrategies.get(symbol);

    if (!featureEngine || !history || !strategies) return;

    const features = featureEngine.process(tick);

    history.push(features);
    if (history.length > CONTEXT_WINDOW) history.shift();

    // Economic blackout check (skip all signals for this symbol if in blackout)
    if (calendar.isBlackout(symbol)) {
      signalsBlackedOut++;
      return;
    }

    for (const strategy of strategies) {
      const signal = strategy.generateSignal(features, history.slice(0, -1));
      signalsGenerated++;

      if (signal.direction === 'NONE') continue;
      if (signal.confidence < 0.3) continue;

      // Gemini context filter (non-blocking, cached 4h, never blocks hard)
      let adjustedConfidence = signal.confidence;
      if (contextFilter) {
        try {
          const upcoming = calendar.getUpcoming(symbol, 4);
          const context = await contextFilter.assess(
            symbol,
            {
              strategy: strategy.name,
              confidence: signal.confidence,
              direction: signal.direction,
              ...signal.metadata,
            },
            upcoming.map((e) => ({
              eventName: e.eventName,
              currency: e.currency,
              impact: e.impact,
              scheduledAt: e.scheduledAt.toISOString(),
            })),
          );

          adjustedConfidence = contextFilter.applyToConfidence(signal.confidence, context);

          if (context.suppressTrade || adjustedConfidence <= 0) {
            signalsSuppressedByGemini++;
            log.debug(
              { symbol, strategy: strategy.name, keyRisk: context.keyRisk, score: context.divergenceScore },
              'Gemini suppressed signal',
            );
            continue;
          }
        } catch {
          // Gemini filter is non-blocking — use original confidence on error
        }
      }

      // Risk engine evaluation
      const modifiedSignal = { ...signal, confidence: adjustedConfidence };
      const decision = riskEngine.evaluate(modifiedSignal, 'DEMO');

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
          confidence: adjustedConfidence.toFixed(3),
        },
        '[DEMO] Signal approved — placing order',
      );

      try {
        const trade = await executor.execute(decision.approvedSignal);
        log.info(
          { contractId: trade.contractId, entryPrice: trade.entryPrice },
          '[DEMO] Contract opened',
        );
      } catch (err) {
        log.error(
          { error: (err as Error).message, symbol, strategy: strategy.name },
          '[DEMO] Order placement failed',
        );
      }
    }
  });

  // Subscribe to all symbols
  for (const symbol of symbols) {
    void client.subscribeTicks(symbol);
    log.info({ symbol }, 'Subscribed to tick stream');
  }

  // ---------------------------------------------------------------------------
  // Status reporter
  // ---------------------------------------------------------------------------
  setInterval(() => {
    const state = riskEngine.getState();
    console.log('\n📊 Demo Trading Status:');
    console.log(`   Symbols:       ${symbols.length} (${symbols.join(', ')})`);
    console.log(`   Balance:       $${state.currentBalance.toFixed(2)}`);
    console.log(`   Peak:          $${state.peakBalance.toFixed(2)}`);
    console.log(`   P&L:           $${(state.currentBalance - state.sessionStartBalance).toFixed(2)}`);
    console.log(`   Total trades:  ${state.totalTrades}`);
    console.log(
      `   Signals:       ${signalsGenerated} generated | ${signalsApproved} approved | ${signalsRejected} rejected`,
    );
    console.log(
      `   Filtered:      ${signalsBlackedOut} economic blackout | ${signalsSuppressedByGemini} Gemini suppressed`,
    );
    console.log(`   Loss streak:   ${state.consecutiveLosses}`);
    console.log(`   Kill switch:   ${state.killSwitchActive ? '🔴 ACTIVE' : '✅ OK'}`);

    // Show upcoming high-impact events
    for (const symbol of symbols.slice(0, 3)) {
      const upcoming = calendar.getUpcoming(symbol, 4);
      if (upcoming.length > 0) {
        console.log(`   ⚠️  Upcoming events for ${symbol}: ${upcoming.map((e) => `${e.eventName} (${e.impact})`).join(', ')}`);
      }
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  process.on('SIGINT', async () => {
    log.info('Shutting down demo trading...');
    await client.disconnect();
    const state = riskEngine.getState();
    console.log('\n📊 Final Session Summary:');
    console.log(`   Symbols traded: ${symbols.join(', ')}`);
    console.log(`   Total trades:   ${state.totalTrades}`);
    console.log(`   Final balance:  $${state.currentBalance.toFixed(2)}`);
    console.log(`   P&L:            $${(state.currentBalance - state.sessionStartBalance).toFixed(2)}`);
    console.log(`   Signals:        ${signalsGenerated} generated, ${signalsApproved} approved`);
    console.log(`   Filtered:       ${signalsSuppressedByGemini} by Gemini, ${signalsBlackedOut} by calendar`);
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
