#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('trade:live', 'Real-account Options runner. Requires explicit live flags; readiness remains unverified.');
import { print } from '../monitoring/print.js';
import { asyncHandler } from '../utils/asyncHandler.js';
/**
 * Live Trading — REAL MONEY Execution with Safety Controls.
 *
 * REQUIREMENTS FOR LIVE TRADING:
 *   1. DERIV_API_TOKEN must be set to a REAL account PAT token
 *   2. DEMO_TRADING=false
 *   3. LIVE_TRADING=true
 *   4. LIVE_CONFIRMATION=true
 *
 * SAFETY PRINCIPLES:
 *   - Verifies real account token authorization on startup
 *   - Checks real balance and enforces hard risk limits
 *   - Multi-strategy consensus voting (requires ≥60% agreement by default)
 *   - Kill switch auto-triggers if max drawdown is reached
 *   - Press Ctrl+C at any time to emergency stop
 */

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv, isLiveTradingEnabled } from '../config/env.js';
import { renderBanner, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { StrategyStream, DEFAULT_CONTEXT_WINDOW, DEFAULT_WARMUP_TICKS } from '../pipeline/StrategyStream.js';
import { RiskEngine } from '../risk/RiskEngine.js';
import { OptionsExecutionService } from '../execution/OptionsExecutionService.js';
import { OptionsLedger } from '../portfolio/OptionsLedger.js';
import { getDb } from '../data/database/sqlite.js';
import { assertDefined } from '../utils/assertDefined.js';
import { VotingEngine } from '../execution/VotingEngine.js';
import { SymbolRanker } from '../execution/SymbolRanker.js';

import { MomentumStrategy } from '../strategies/momentum/MomentumStrategy.js';
import { VolAdjMomentumStrategy } from '../strategies/volatility-momentum/VolAdjMomentumStrategy.js';
import { MeanReversionStrategy } from '../strategies/mean-reversion/MeanReversionStrategy.js';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy.js';
import { WaveletStrategy } from '../strategies/signal/WaveletStrategy.js';
import { EWMSStrategy } from '../strategies/signal/EWMSStrategy.js';

import type { Strategy } from '../strategies/base/Strategy.js';
import type { Tick } from '../types/tick.js';
import type { DerivTick } from '../api/deriv/DerivTypes.js';

function buildStrategiesForSymbol(
  _symbol: string,
  strategyNames: string[],
): Strategy[] {
  const all: Record<string, Strategy> = {
    'momentum': new MomentumStrategy({ lookback: 20, threshold: 0.001, momentumKey: 'mom20' }),
    'momentum-slow': new MomentumStrategy({ lookback: 50, threshold: 0.002, momentumKey: 'mom50' }),
    'vol-adj-momentum': new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom20', zThreshold: 1.0 }),
    'vol-adj-momentum-slow': new VolAdjMomentumStrategy({ momentumKey: 'volAdjMom50', zThreshold: 1.5 }),
    'mean-reversion': new MeanReversionStrategy({ zScoreKey: 'zScore20', entryThreshold: 1.5, exitThreshold: 0.5 }),
    'mean-reversion-slow': new MeanReversionStrategy({ zScoreKey: 'zScore50', entryThreshold: 2.0, exitThreshold: 0.5 }),
    'breakout': new BreakoutStrategy({ highKey: 'rollingHigh20', lowKey: 'rollingLow20', confirmationFraction: 0.001 }),
    'wavelet': new WaveletStrategy(),
    'ewms': new EWMSStrategy(),
  };

  const strategies: Strategy[] = [];
  for (const name of strategyNames) {
    const key = Object.keys(all).find((k) => k === name || k.startsWith(name));
    if (key && all[key]) {
      strategies.push(all[key]);
      const slowKey = key + '-slow';
      if (all[slowKey]) strategies.push(all[slowKey]);
    }
  }

  const seen = new Set<string>();
  return strategies.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('LiveTrading');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  if (!isLiveTradingEnabled()) {
    console.error('\n❌ LIVE TRADING IS DISABLED IN YOUR .env FILE!\n');
    console.error('To enable LIVE TRADING with real money, set:');
    console.error('  DEMO_TRADING=false');
    console.error('  LIVE_TRADING=true');
    console.error('  LIVE_CONFIRMATION=true');
    console.error('  DERIV_API_TOKEN=pat_your_real_account_token\n');
    process.exit(1);
  }

  print('\n⚠️  WARNING: LIVE TRADING MODE IS ACTIVE — REAL MONEY AT RISK! ⚠️\n');

  // Connect public WS for market data, then trading WS (real account) via OTP
  const client = new DerivClient();
  await client.connectPublic();
  await client.connectTrading('real');

  log.info('Live trading WebSocket connection authorized successfully.');

  const ranker = new SymbolRanker();
  await ranker.load(env.SYMBOLS);

  const topSymbols = env.TOP_SYMBOLS ?? env.SYMBOLS.length;
  const activeProfiles = ranker.getTop(topSymbols);
  const activeSymbols = activeProfiles.map((p) => p.symbol);

  print(`\n📊 Trading Active Symbols (${String(activeSymbols.length)}): ${activeSymbols.join(', ')}`);

  const streams = new Map<string, StrategyStream>();
  const votingEngines = new Map<string, VotingEngine>();

  for (const profile of activeProfiles) {
    const strats = buildStrategiesForSymbol(profile.symbol, profile.recommendedStrategies);
    streams.set(profile.symbol, new StrategyStream(profile.symbol, strats, DEFAULT_CONTEXT_WINDOW, DEFAULT_WARMUP_TICKS, env.MAX_TICK_GAP_SECONDS * 1000));
    votingEngines.set(
      profile.symbol,
      new VotingEngine({ minVoteFraction: env.VOTE_THRESHOLD, minConsensusConfidence: env.MIN_CONSENSUS_CONFIDENCE }),
    );
  }

  const accountBalance = await client.subscribeBalance();
  const ledger = new OptionsLedger(getDb(), assertDefined(client.getTradingAccount()).accountId, 'LIVE', accountBalance.balance);
  const riskEngine = new RiskEngine(accountBalance.balance, accountBalance.currency, ledger);
  const execution = new OptionsExecutionService(client, ledger, riskEngine, 'LIVE');
  await execution.start();
  const settlementTimer = setInterval(asyncHandler(async () => {
    for (const { intent, state } of await execution.poll()) log.info({ contractId: intent.contract_id, profit: state.profit }, 'Confirmed settlement');
  }, (error: unknown) => { log.error({ error }, 'Reconciliation failed; new orders blocked'); }), 5000);
  const shutdown = asyncHandler(async () => { clearInterval(settlementTimer); await client.disconnect(); process.exit(0); },
    (error: unknown) => { log.error({ error }, 'Shutdown failed'); process.exitCode = 1; });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.on('disconnected', (reason: string) => {
    for (const stream of streams.values()) stream.suspend('Market feed disconnected; restart required with fresh strategy state');
    log.error({ reason }, 'Market feed interrupted: new signals blocked; settlement reconciliation remains active');
  });

  client.on('tick', asyncHandler(async (derivTick: DerivTick) => {
    const symbol = derivTick.symbol;
    if (!activeSymbols.includes(symbol)) return;

    const tick: Tick = {
      symbol,
      epoch: derivTick.epoch,
      timestamp: new Date(derivTick.epoch * 1000),
      price: derivTick.quote,
    };

    const stream = streams.get(symbol);
    const ve = votingEngines.get(symbol);
    if (!stream || !ve || stream.getBlockedReason()) return;
    const { features, signals } = stream.process(tick);
    if (!signals.length) return;
    const vote = ve.vote(symbol, signals);

    if (execution.isReady() && vote.hasConsensus && vote.direction !== 'NONE') {
      const syntheticSignal = ve.toSignal(features, signals);

      {
        try {
          const trade = await execution.execute(syntheticSignal);
          print(`\n🚀 [LIVE ORDER PLACED] ${trade.symbol} ${trade.direction} Stake=$${String(trade.stakeAmount)}`);
        } catch (err) {
          log.error({ error: err instanceof Error ? err.message : 'Unknown execution error' }, 'Failed to place live order');
        }
      }
    }
  }, (error: unknown) => { log.error({ error }, 'Asynchronous handler failed'); process.exitCode = 1; }));

  for (const symbol of activeSymbols) {
    await client.subscribeTicks(symbol);
  }

  print('\n🟢 Live trading runner connected and listening to market ticks...\n');
}

main().catch((err: unknown) => {
  console.error('Fatal live trading error:', err);
  process.exit(1);
});
