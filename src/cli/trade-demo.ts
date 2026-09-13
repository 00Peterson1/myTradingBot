#!/usr/bin/env node
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
import { FeatureEngine } from '../features/FeatureEngine.js';
import { RiskEngine } from '../risk/RiskEngine.js';
import { DerivExecutionEngine } from '../execution/DerivExecutionEngine.js';
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
import type { TickFeatures, Tick } from '../types/tick.js';
import type { DerivTick } from '../api/deriv/DerivTypes.js';

const CONTEXT_WINDOW = 200;

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
// Rate limiter — max N trades per symbol per hour
// ---------------------------------------------------------------------------

class RateLimiter {
  private timestamps = new Map<string, number[]>();

  constructor(private readonly maxPerHour: number) {}

  isAllowed(symbol: string): boolean {
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    const times = (this.timestamps.get(symbol) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.maxPerHour) return false;
    times.push(now);
    this.timestamps.set(symbol, times);
    return true;
  }

  remaining(symbol: string): number {
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    const times = (this.timestamps.get(symbol) ?? []).filter((t) => t > cutoff);
    return Math.max(0, this.maxPerHour - times.length);
  }
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
    env.SYMBOLS = process.argv[symIdx + 1]!.split(',').map((s) => s.trim());
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
    console.log('\n📊 DERIV MARKET CATALOG');
    console.log('Market definitions are loaded dynamically from the Deriv active_symbols API.');
    console.log('Run `npm run markets` to discover and display all available instruments.\n');
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Read vote config from env
  // ---------------------------------------------------------------------------
  const voteThreshold = env.VOTE_THRESHOLD ?? 0.6;
  const minConfidence = env.MIN_CONSENSUS_CONFIDENCE ?? 0.55;
  const maxTradesPerHour = env.MAX_TRADES_PER_HOUR ?? 10;
  const topSymbols = env.TOP_SYMBOLS ?? env.SYMBOLS.length;

  console.log('\n✅ DEMO MODE — virtual money, real market data, real contracts on Deriv demo\n');
  console.log('📐 Trade Configuration:');
  console.log(`   Stake per trade:    $${(env.STAKE_AMOUNT ?? 1.00).toFixed(2)} USD`);
  console.log(`   Contract type:      ${env.CONTRACT_TYPE} ${env.CONTRACT_TYPE === 'OVER_UNDER' ? `(Barrier: ${env.DIGIT_BARRIER})` : ''}`);
  console.log(`   Contract duration:  ${env.CONTRACT_DURATION} ${env.CONTRACT_DURATION_UNIT === 't' ? 'ticks' : env.CONTRACT_DURATION_UNIT}`);
  console.log(`   Vote threshold:     ${(voteThreshold * 100).toFixed(0)}% of strategies must agree`);
  console.log(`   Min confidence:     ${(minConfidence * 100).toFixed(0)}%`);
  console.log(`   Max trades/hour:    ${maxTradesPerHour} per symbol`);
  console.log(`   Watching:           ${env.SYMBOLS.join(', ')}`);
  console.log(`   Trading top:        ${topSymbols} symbol(s) by research score`);
  console.log('\n   Press Ctrl+C to stop.\n');

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

  console.log('🏆 Symbol Ranking (based on research data):');
  for (const p of ranked) {
    console.log(
      `   ${p.symbol.padEnd(12)} score=${p.score}/100  type=${p.marketType.padEnd(10)}  ` +
      `strategies=[${p.recommendedStrategies.join(', ')}]`,
    );
    console.log(`   └─ ${p.reason}`);
  }
  console.log();

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
  console.log('📡 Connecting to Deriv market data feed...');
  await client.connectPublic();
  console.log('✅ Market data connected\n');

  // ---------------------------------------------------------------------------
  // Authenticate for trading via OTP flow:
  //   REST GET  /accounts         → find demo account
  //   REST POST /accounts/{id}/otp → get authenticated WS URL
  //   WS connect to that URL      → ready to buy/sell
  // ---------------------------------------------------------------------------
  let demoBalance: number;
  try {
    console.log('🔑 Authenticating trading account (demo)...');
    await client.connectTrading('demo');
    // Fetch the real demo account balance — this is the authoritative starting
    // balance for the risk engine. Using a hard-coded value would decouple risk
    // limits from the actual account state.
    const bal = await client.subscribeBalance();
    demoBalance = bal.balance;
    if (!Number.isFinite(demoBalance) || demoBalance <= 0) {
      console.error('❌ Demo account balance is $0 or invalid. Fund the demo account before trading.');
      await client.disconnect();
      process.exit(1);
    }
    console.log(`✅ Authenticated! Demo balance: $${demoBalance.toFixed(2)} ${bal.currency}`);
    console.log('   Orders will appear at app.deriv.com → Reports → Statement\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuthErr = /401|403|unauthorized|forbidden|invalid.*token|token.*invalid/i.test(msg);

    console.log();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  ❌  AUTHENTICATION FAILED                                ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    if (isAuthErr) {
      console.log('║  Token rejected by Deriv API.                            ║');
      console.log('║                                                          ║');
      console.log('║  Check .env:                                             ║');
      console.log('║    DERIV_API_TOKEN=pat_...   (your PAT from Deriv)        ║');
      console.log('║    DERIV_APP_ID=<your app id>                            ║');
    } else {
      const lines = msg.match(/.{1,54}/g) ?? [msg];
      for (const line of lines.slice(0, 3)) {
        console.log(`║  ${line.padEnd(56)}║`);
      }
    }
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log();
    await client.disconnect();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Per-symbol state
  // ---------------------------------------------------------------------------
  const featureEngines = new Map<string, FeatureEngine>();
  const featureHistory = new Map<string, TickFeatures[]>();

  for (const symbol of symbolsToTrade) {
    featureEngines.set(symbol, new FeatureEngine(symbol));
    featureHistory.set(symbol, []);
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
  const riskEngine = new RiskEngine(demoBalance);
  const executor = new DerivExecutionEngine(client);
  const rateLimiter = new RateLimiter(maxTradesPerHour);

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

  client.on('tick', async (rawTick: DerivTick) => {
    const symbol = rawTick.symbol;
    if (!symbolsToTrade.includes(symbol)) return;

    const tick: Tick = {
      symbol,
      epoch: rawTick.epoch,
      timestamp: new Date(rawTick.epoch * 1000),
      price: rawTick.quote,
    };

    const featureEngine = featureEngines.get(symbol)!;
    const history = featureHistory.get(symbol)!;
    const strategies = symbolStrategies.get(symbol);
    if (!strategies || strategies.length === 0) return;

    const features = featureEngine.process(tick);
    history.push(features);
    if (history.length > CONTEXT_WINDOW) history.shift();

    // Need at least 50 bars of history for reliable signals
    if (history.length < 50) return;

    const prevHistory = history.slice(0, -1);

    // --- Run all strategies, collect signals ---
    const signals = strategies.map((s) => s.generateSignal(features, prevHistory));
    totalSignals += signals.length;

    // --- Vote ---
    const vote = votingEngine.vote(symbol, signals);

    if (!vote.hasConsensus) return;

    consensusHits++;

    // --- Rate limit ---
    if (!rateLimiter.isAllowed(symbol)) {
      log.debug({ symbol, remaining: rateLimiter.remaining(symbol) }, 'Rate limit — skipping');
      return;
    }

    // --- Risk check ---
    const syntheticSignal = {
      id: crypto.randomUUID(),
      symbol,
      price: tick.price,
      direction: vote.direction,
      confidence: vote.consensusConfidence,
      strategy: `Vote(${vote.tally.buy}↑${vote.tally.sell}↓/${vote.tally.total})`,
      timestamp: tick.timestamp,
      metadata: { voteFraction: vote.voteFraction },
    };
    const decision = riskEngine.evaluate(syntheticSignal, 'DEMO');

    if (!decision.approved) {
      log.debug({ reason: decision.reason, symbol }, 'Risk engine rejected');
      return;
    }

    // --- Log consensus ---
    const tally = vote.tally;
    const bar = '█'.repeat(Math.round(vote.voteFraction * 10)) + '░'.repeat(10 - Math.round(vote.voteFraction * 10));
    console.log(
      `\n🗳  CONSENSUS  ${symbol}  ${vote.direction === 'BUY' ? '📈 BUY ' : '📉 SELL'}` +
      `  [${bar}] ${tally.buy}↑${tally.sell}↓${tally.none}— / ${tally.total}` +
      `  conf=${vote.consensusConfidence.toFixed(3)}` +
      `  stake=$${decision.approvedSignal.stakeAmount.toFixed(2)}`,
    );


    // --- Place order ---
    ordersPlaced++;
    try {
      const trade = await executor.execute(decision.approvedSignal);
      console.log(
        `   ↳ ✅ Contract #${trade.contractId} opened  entry=${trade.entryPrice}`,
      );

      // Wait for contract to settle, then show P&L.
      // Duration is approximated from CONTRACT_DURATION_UNIT; Deriv synthetic tick
      // rate is ~1s/tick. This is a best-effort heuristic — not event-driven.
      // TODO Milestone 3: replace with proposal_open_contract subscription.
      const unitMs: Record<string, number> = { t: 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 };
      const durationMs = env.CONTRACT_DURATION * (unitMs[env.CONTRACT_DURATION_UNIT] ?? 1000);

      setTimeout(async () => {
        try {
          const result = await executor.settle(trade);
          const symPnl = pnl.get(symbol) ?? 0;
          pnl.set(symbol, symPnl + result.profit);
          const counts = tradeCounts.get(symbol) ?? { wins: 0, losses: 0 };
          if (result.won) counts.wins++; else counts.losses++;
          tradeCounts.set(symbol, counts);
          riskEngine.recordTradeResult(result.profit);

          const sign = result.profit >= 0 ? '+' : '';
          const emoji = result.won ? '✅ WON ' : '❌ LOST';
          const totalPnl = [...pnl.values()].reduce((a, b) => a + b, 0);

          console.log(
            `   ↳ ${emoji}  ${symbol}  ${sign}$${result.profit.toFixed(2)}` +
            `  (session P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)})`,
          );
        } catch {
          // Contract may still be open — ignore
        }
      }, durationMs + 2000);

    } catch (err) {
      console.log(`   ↳ ❌ Order failed: ${(err as Error).message}`);
    }
  });

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

    console.log('\n' + '─'.repeat(60));
    console.log('📊 Status Report');
    console.log('─'.repeat(60));
    console.log(`   Balance:     $${state.currentBalance.toFixed(2)}  (P&L: ${pnlSign}$${totalPnl.toFixed(2)})`);
    console.log(`   Orders:      ${ordersPlaced} placed`);
    console.log(`   Consensus:   ${consensusHits} / ${totalSignals} ticks had consensus`);
    console.log(`   Kill switch: ${state.killSwitchActive ? '🔴 ACTIVE' : '✅ OK'}`);
    console.log('\n   Per-symbol breakdown:');
    for (const s of symbolsToTrade) {
      const c = tradeCounts.get(s) ?? { wins: 0, losses: 0 };
      const sPnl = pnl.get(s) ?? 0;
      const total = c.wins + c.losses;
      const wr = total > 0 ? `${((c.wins / total) * 100).toFixed(0)}% WR` : 'no trades';
      const profile = ranker.getProfile(s);
      console.log(
        `   ${s.padEnd(12)} ${(sPnl >= 0 ? '+' : '')}$${sPnl.toFixed(2).padStart(7)}` +
        `  W:${c.wins} L:${c.losses}  ${wr}` +
        `  remaining: ${rateLimiter.remaining(s)}/hr` +
        `  [type: ${profile?.marketType ?? '?'}]`,
      );
    }
    console.log('─'.repeat(60));
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  process.on('SIGINT', async () => {
    log.info('Shutting down...');
    await client.disconnect();
    const state = riskEngine.getState();
    const totalPnl = [...pnl.values()].reduce((a, b) => a + b, 0);
    const pnlSign = totalPnl >= 0 ? '+' : '';

    console.log('\n' + '═'.repeat(60));
    console.log('📊 Session Summary');
    console.log('═'.repeat(60));
    console.log(`   Stake:         $${(env.STAKE_AMOUNT ?? 1.00).toFixed(2)} per trade`);
    console.log(`   Vote threshold: ${(voteThreshold * 100).toFixed(0)}%`);
    console.log(`   Orders placed: ${ordersPlaced}`);
    console.log(`   Total P&L:     ${pnlSign}$${totalPnl.toFixed(2)}`);
    console.log(`   Final balance: $${state.currentBalance.toFixed(2)}`);
    console.log('\n   Per symbol:');
    for (const s of symbolsToTrade) {
      const c = tradeCounts.get(s) ?? { wins: 0, losses: 0 };
      const sPnl = pnl.get(s) ?? 0;
      const total = c.wins + c.losses;
      const wr = total > 0 ? `${((c.wins / total) * 100).toFixed(0)}%` : 'n/a';
      console.log(
        `   ${s.padEnd(12)} ${(sPnl >= 0 ? '+' : '')}$${sPnl.toFixed(2).padStart(7)}` +
        `  W=${c.wins} L=${c.losses}  WR=${wr}`,
      );
    }
    console.log('\n   Profits visible at: https://app.deriv.com → Reports → Statement');
    console.log('═'.repeat(60));
    process.exit(0);
  });

  await new Promise<never>(() => {});
}

main().catch((err: unknown) => {
  console.error('Demo trading failed:', err);
  process.exit(1);
});
