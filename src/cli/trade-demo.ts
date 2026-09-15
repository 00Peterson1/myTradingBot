#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('trade:demo', 'Options demo runner. --symbols SYMBOL,... --list-markets. Trading readiness remains unverified.');
import { print } from '../monitoring/print.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { assertDefined } from '../utils/assertDefined.js';
/**
 * Demo Trading — Vote-based, market-aware, self-configuring.
 *
 * HOW IT WORKS:
 *   1. Reads your .env SYMBOLS list
 *   2. Loads research scores from DB (run `npm run research` first)
 *   3. Ranks symbols best-to-worst based on statistical properties
 *   4. Assigns market-type-appropriate strategies per symbol
 *   5. On each tick: ALL strategies vote
 *   6. Trade fires ONLY when ≥60% of strategies agree (configurable)
 *   7. Contract is placed on your Deriv DEMO account
 *   8. Waits for result → prints WIN/LOSS + updates P&L
 *
 * CONFIGURE in .env:
 *   SYMBOLS=1HZ10V,1HZ25V,BOOM500,CRASH500   ← which markets to watch
 *   STAKE_AMOUNT=1.00                          ← $ per trade
 *   CONTRACT_DURATION=5                        ← ticks per contract
 *   VOTE_THRESHOLD=0.60                        ← fraction that must agree (60%)
 *   MIN_CONSENSUS_CONFIDENCE=0.55              ← min avg confidence
 *   MAX_TRADES_PER_HOUR=10                     ← rate limit
 *   TOP_SYMBOLS=3                              ← how many top-ranked symbols to trade
 *
 * Press Ctrl+C to stop and see session summary.
 */

import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';
import { renderBanner, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { StrategyStream, DEFAULT_CONTEXT_WINDOW, DEFAULT_WARMUP_TICKS } from '../pipeline/StrategyStream.js';
import { RiskEngine } from '../risk/RiskEngine.js';
import { OptionsExecutionService } from '../execution/OptionsExecutionService.js';
import { OptionsLedger } from '../portfolio/OptionsLedger.js';
import { getDb } from '../data/database/sqlite.js';
import { VotingEngine } from '../execution/VotingEngine.js';
import { SymbolRanker } from '../execution/SymbolRanker.js';

// Strategies
import { MomentumStrategy } from '../strategies/momentum/MomentumStrategy.js';
import { VolAdjMomentumStrategy } from '../strategies/volatility-momentum/VolAdjMomentumStrategy.js';
import { MeanReversionStrategy } from '../strategies/mean-reversion/MeanReversionStrategy.js';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy.js';
import { WaveletStrategy } from '../strategies/signal/WaveletStrategy.js';
import { EWMSStrategy } from '../strategies/signal/EWMSStrategy.js';
import { EvenOddStrategy } from '../strategies/digit/EvenOddStrategy.js';
import { OverUnderStrategy } from '../strategies/digit/OverUnderStrategy.js';
import { MatchesDiffersStrategy } from '../strategies/digit/MatchesDiffersStrategy.js';

import type { Strategy } from '../strategies/base/Strategy.js';
import type { Tick } from '../types/tick.js';
import type { DerivTick } from '../api/deriv/DerivTypes.js';


// ---------------------------------------------------------------------------
// Strategy factory — builds the suite for a symbol based on market type
// ---------------------------------------------------------------------------

function buildStrategiesForSymbol(
  _symbol: string,
  strategyNames: string[],
): Strategy[] {
  const env = getEnv();
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
    'digit-even-odd': new EvenOddStrategy(),
    'digit-over-under': new OverUnderStrategy({ barrier: env.DIGIT_BARRIER }),
    'digit-matches-differs': new MatchesDiffersStrategy(),
  };

  let namesToLoad = [...strategyNames];

  if (env.CONTRACT_TYPE === 'RISE_FALL') {
    namesToLoad = namesToLoad.filter((n) => !n.startsWith('digit-'));
  } else if (env.CONTRACT_TYPE === 'EVEN_ODD') {
    namesToLoad = ['digit-even-odd'];
  } else if (env.CONTRACT_TYPE === 'OVER_UNDER') {
    namesToLoad = ['digit-over-under'];
  } else if (env.CONTRACT_TYPE === 'MATCHES_DIFFERS') {
    namesToLoad = ['digit-matches-differs'];
  }

  const strategies: Strategy[] = [];
  for (const name of namesToLoad) {
    const key = Object.keys(all).find((k) => k === name || k.startsWith(name));
    if (key && all[key]) {
      strategies.push(all[key]);
      const slowKey = key + '-slow';
      if (all[slowKey]) strategies.push(all[slowKey]);
    }
  }

  // Deduplicate by name
  const seen = new Set<string>();
  return strategies.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = getEnv();

  // ---------------------------------------------------------------------------
  // CLI flags
  //   --symbols BOOM500,CRASH500   override .env SYMBOLS (comma-separated)
  //   --list-markets               print catalog and exit
  // ---------------------------------------------------------------------------
  const symIdx = process.argv.indexOf('--symbols');
  if (symIdx !== -1 && process.argv[symIdx + 1]) {
    env.SYMBOLS = assertDefined(process.argv[symIdx + 1]).split(',').map((s) => s.trim());
  }

  // Logger: default is 'warn' (quiet). Only enable verbose if user explicitly
  // set LOG_LEVEL=debug or LOG_LEVEL=trace in .env.
  const logLevel = (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') ? env.LOG_LEVEL : 'warn';
  configureLogger(logLevel, env.LOG_PRETTY);
  const log = createLogger('DemoTrading');

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  if (!env.DEMO_TRADING) {
    console.error('❌ DEMO_TRADING=false in .env — set DEMO_TRADING=true to run demo trading.');
    process.exit(1);
  }

  if (process.argv.includes('--list-markets')) {
    print('\n📊 DERIV MARKET CATALOG');
    print('Market definitions are loaded dynamically from the Deriv active_symbols API.');
    print('Run `npm run markets` to discover and display all available instruments.\n');
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Read vote config from env
  // ---------------------------------------------------------------------------
  const voteThreshold = env.VOTE_THRESHOLD;
  const minConfidence = env.MIN_CONSENSUS_CONFIDENCE;
  const maxTradesPerHour = env.MAX_TRADES_PER_HOUR;
  const topSymbols = env.TOP_SYMBOLS ?? env.SYMBOLS.length;

  print('\n✅ DEMO MODE — virtual money, real market data, real contracts on Deriv demo\n');
  print('📐 Trade Configuration:');
  print(`   Stake per trade:    $${(env.STAKE_AMOUNT ?? 1.00).toFixed(2)} USD`);
  print(`   Contract type:      ${env.CONTRACT_TYPE} ${env.CONTRACT_TYPE === 'OVER_UNDER' ? `(Barrier: ${String(env.DIGIT_BARRIER)})` : ''}`);
  print(`   Contract duration:  ${String(env.CONTRACT_DURATION)} ${env.CONTRACT_DURATION_UNIT === 't' ? 'ticks' : env.CONTRACT_DURATION_UNIT}`);
  print(`   Vote threshold:     ${(voteThreshold * 100).toFixed(0)}% of strategies must agree`);
  print(`   Min confidence:     ${(minConfidence * 100).toFixed(0)}%`);
  print(`   Max trades/hour:    ${String(maxTradesPerHour)} per symbol`);
  print(`   Watching:           ${env.SYMBOLS.join(', ')}`);
  print(`   Trading top:        ${String(topSymbols)} symbol(s) by research score`);
  print('\n   Press Ctrl+C to stop.\n');

  // ---------------------------------------------------------------------------
  // Rank symbols using research data
  // ---------------------------------------------------------------------------
  const ranker = new SymbolRanker();
  await ranker.load(env.SYMBOLS);
  const ranked = ranker.getTop(topSymbols);

  if (ranked.length === 0) {
    console.error('❌ No symbols to trade. Check SYMBOLS= in .env');
    process.exit(1);
  }

  const symbolsToTrade = ranked.map((p) => p.symbol);

  print('🏆 Symbol Ranking (based on research data):');
  for (const p of ranked) {
    print(
      `   ${p.symbol.padEnd(12)} score=${String(p.score)}/100  type=${p.marketType.padEnd(10)}  ` +
      `strategies=[${p.recommendedStrategies.join(', ')}]`,
    );
    print(`   └─ ${p.reason}`);
  }
  print();

  // ---------------------------------------------------------------------------
  // Build per-symbol strategy suites
  // ---------------------------------------------------------------------------
  const symbolStrategies = new Map<string, Strategy[]>();
  for (const profile of ranked) {
    const suite = buildStrategiesForSymbol(profile.symbol, profile.recommendedStrategies);
    symbolStrategies.set(profile.symbol, suite);
    log.info(
      { symbol: profile.symbol, strategies: suite.map((s) => s.name) },
      'Strategy suite assigned',
    );
  }

  // ---------------------------------------------------------------------------
  // Connect public WS (market data — ticks, proposals)
  // ---------------------------------------------------------------------------
  const client = new DerivClient();
  print('📡 Connecting to Deriv market data feed...');
  await client.connectPublic();
  print('✅ Market data connected\n');

  // ---------------------------------------------------------------------------
  // Authenticate for trading via OTP flow:
  //   REST GET  /accounts         → find demo account
  //   REST POST /accounts/{id}/otp → get authenticated WS URL
  //   WS connect to that URL      → ready to buy/sell
  // ---------------------------------------------------------------------------
  let demoBalance: number;
  let accountCurrency: string;
  try {
    print('🔑 Authenticating trading account (demo)...');
    await client.connectTrading('demo');
    // Fetch the real demo account balance — this is the authoritative starting
    // balance for the risk engine. Using a hard-coded value would decouple risk
    // limits from the actual account state.
    const bal = await client.subscribeBalance();
    demoBalance = bal.balance;
    accountCurrency = bal.currency;
    if (!Number.isFinite(demoBalance) || demoBalance <= 0) {
      console.error('❌ Demo account balance is $0 or invalid. Fund the demo account before trading.');
      await client.disconnect();
      process.exit(1);
    }
    print(`✅ Authenticated! Demo balance: $${demoBalance.toFixed(2)} ${bal.currency}`);
    print('   Orders will appear at app.deriv.com → Reports → Statement\n');
  } catch (err) {
    console.error('Trading account connection failed:', err instanceof Error ? err.message : 'Unknown connection error');
    await client.disconnect();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Per-symbol state
  // ---------------------------------------------------------------------------
  const streams = new Map<string, StrategyStream>();

  for (const symbol of symbolsToTrade) {
    streams.set(symbol, new StrategyStream(symbol, assertDefined(symbolStrategies.get(symbol)), DEFAULT_CONTEXT_WINDOW, DEFAULT_WARMUP_TICKS, env.MAX_TICK_GAP_SECONDS * 1000));
  }

  // ---------------------------------------------------------------------------
  // Engines
  // ---------------------------------------------------------------------------
  const votingEngine = new VotingEngine({
    minVoteFraction: voteThreshold,
    minConsensusConfidence: minConfidence,
    weightByConfidence: true,
  });

  // RiskEngine is initialised with the ACTUAL demo account balance fetched above.
  // This ensures risk limits (max daily loss, drawdown) are computed against the
  // real account state, not a fictional fixed amount.
  const ledger = new OptionsLedger(getDb(), assertDefined(client.getTradingAccount()).accountId, 'DEMO', demoBalance);
  const riskEngine = new RiskEngine(demoBalance, accountCurrency, ledger);
  const execution = new OptionsExecutionService(client, ledger, riskEngine, 'DEMO');
  await execution.start();

  // ---------------------------------------------------------------------------
  // P&L tracking per symbol
  // ---------------------------------------------------------------------------
  const pnl = new Map<string, number>();
  const tradeCounts = new Map<string, { wins: number; losses: number }>();
  for (const s of symbolsToTrade) {
    pnl.set(s, 0);
    tradeCounts.set(s, { wins: 0, losses: 0 });
  }

  let totalSignals = 0;
  let consensusHits = 0;
  let ordersPlaced = 0;

  // ---------------------------------------------------------------------------
  // Main trading loop
  // ---------------------------------------------------------------------------
  log.info({ symbols: symbolsToTrade }, 'Demo trading loop started');

  client.on('disconnected', (reason: string) => {
    for (const stream of streams.values()) stream.suspend('Market feed disconnected; restart required with fresh strategy state');
    log.error({ reason }, 'Market feed interrupted: new signals blocked; settlement reconciliation remains active');
  });

  client.on('tick', asyncHandler(async (rawTick: DerivTick) => {
    const symbol = rawTick.symbol;
    if (!symbolsToTrade.includes(symbol)) return;

    const tick: Tick = {
      symbol,
      epoch: rawTick.epoch,
      timestamp: new Date(rawTick.epoch * 1000),
      price: rawTick.quote,
    };

    const stream = assertDefined(streams.get(symbol));
    if (stream.getBlockedReason()) return;
    const { features, signals } = stream.process(tick);
    if (!signals.length) return;
    totalSignals += signals.length;

    // --- Vote ---
    const vote = votingEngine.vote(symbol, signals);

    if (!vote.hasConsensus) return;

    consensusHits++;

    if (!execution.isReady()) return;

    // --- Risk check ---
    const syntheticSignal = votingEngine.toSignal(features, signals);
    try {
      const trade = await execution.execute(syntheticSignal);
      ordersPlaced++;
      print(`Contract #${String(trade.contractId)} opened: ${symbol}, stake $${trade.stakeAmount.toFixed(2)}; awaiting confirmed settlement`);
    } catch (err) {
      print(`   ↳ ❌ Order failed: ${(err as Error).message}`);
    }
  }, (error: unknown) => { log.error({ error }, 'Asynchronous handler failed'); process.exitCode = 1; }));

  const settlementTimer = setInterval(asyncHandler(async () => {
    for (const { intent, state } of await execution.poll()) {
      const profit = assertDefined(state.profit);
      pnl.set(intent.symbol, (pnl.get(intent.symbol) ?? 0) + profit);
      const counts = tradeCounts.get(intent.symbol) ?? { wins: 0, losses: 0 };
      if (profit > 0) counts.wins++; else if (profit < 0) counts.losses++;
      tradeCounts.set(intent.symbol, counts);
      print(`Settled #${String(intent.contract_id)} ${intent.symbol}: $${profit.toFixed(2)}`);
    }
  }, (error: unknown) => { log.error({ error }, 'Reconciliation failed; new orders blocked'); }), 5000);

  // Subscribe to all symbols
  for (const symbol of symbolsToTrade) {
    await client.subscribeTicks(symbol);
    log.info({ symbol }, 'Subscribed to tick stream');
  }

  // ---------------------------------------------------------------------------
  // Status every 60 seconds
  // ---------------------------------------------------------------------------
  setInterval(() => {
    const state = riskEngine.getState();
    const totalPnl = [...pnl.values()].reduce((a, b) => a + b, 0);
    const pnlSign = totalPnl >= 0 ? '+' : '';

    print('\n' + '─'.repeat(60));
    print('📊 Status Report');
    print('─'.repeat(60));
    print(`   Balance:     $${state.currentBalance.toFixed(2)}  (P&L: ${pnlSign}$${totalPnl.toFixed(2)})`);
    print(`   Orders:      ${String(ordersPlaced)} placed`);
    print(`   Consensus:   ${String(consensusHits)} / ${String(totalSignals)} ticks had consensus`);
    print(`   Kill switch: ${state.killSwitchActive ? '🔴 ACTIVE' : '✅ OK'}`);
    print('\n   Per-symbol breakdown:');
    for (const s of symbolsToTrade) {
      const c = tradeCounts.get(s) ?? { wins: 0, losses: 0 };
      const sPnl = pnl.get(s) ?? 0;
      const total = c.wins + c.losses;
      const wr = total > 0 ? `${((c.wins / total) * 100).toFixed(0)}% WR` : 'no trades';
      const profile = ranker.getProfile(s);
      print(
        `   ${s.padEnd(12)} ${(sPnl >= 0 ? '+' : '')}$${sPnl.toFixed(2).padStart(7)}` +
        `  W:${String(c.wins)} L:${String(c.losses)}  ${wr}` +
        `  remaining: ${String(Math.max(0, maxTradesPerHour - ledger.countPurchasesSince(s, new Date(Date.now() - 3600_000))))}/hr` +
        `  [type: ${profile?.marketType ?? '?'}]`,
      );
    }
    print('─'.repeat(60));
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  process.on('SIGINT', asyncHandler(async () => {
    log.info('Shutting down...');
    clearInterval(settlementTimer);
    await client.disconnect();
    const state = riskEngine.getState();
    const totalPnl = [...pnl.values()].reduce((a, b) => a + b, 0);
    const pnlSign = totalPnl >= 0 ? '+' : '';

    print('\n' + '═'.repeat(60));
    print('📊 Session Summary');
    print('═'.repeat(60));
    print(`   Stake:         $${(env.STAKE_AMOUNT ?? 1.00).toFixed(2)} per trade`);
    print(`   Vote threshold: ${(voteThreshold * 100).toFixed(0)}%`);
    print(`   Orders placed: ${String(ordersPlaced)}`);
    print(`   Total P&L:     ${pnlSign}$${totalPnl.toFixed(2)}`);
    print(`   Final balance: $${state.currentBalance.toFixed(2)}`);
    print('\n   Per symbol:');
    for (const s of symbolsToTrade) {
      const c = tradeCounts.get(s) ?? { wins: 0, losses: 0 };
      const sPnl = pnl.get(s) ?? 0;
      const total = c.wins + c.losses;
      const wr = total > 0 ? `${((c.wins / total) * 100).toFixed(0)}%` : 'n/a';
      print(
        `   ${s.padEnd(12)} ${(sPnl >= 0 ? '+' : '')}$${sPnl.toFixed(2).padStart(7)}` +
        `  W=${String(c.wins)} L=${String(c.losses)}  WR=${wr}`,
      );
    }
    print('\n   Profits visible at: https://app.deriv.com → Reports → Statement');
    print('═'.repeat(60));
    process.exit(0);
  }, (error: unknown) => { log.error({ error }, 'Asynchronous handler failed'); process.exitCode = 1; }));

  await new Promise<never>(() => { /* Event subscriptions keep the process active. */ });
}

main().catch((err: unknown) => {
  console.error('Demo trading failed:', err);
  process.exit(1);
});
