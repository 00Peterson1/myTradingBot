import type { Signal } from '../types/signal.js';
import { getEnv, isLiveTradingEnabled } from '../config/env.js';
import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { getDb, closeDb } from '../data/database/sqlite.js';
import { OptionsLedger } from '../portfolio/OptionsLedger.js';
import { RiskEngine } from '../risk/RiskEngine.js';
import { StrategyStream, DEFAULT_CONTEXT_WINDOW, DEFAULT_WARMUP_TICKS } from '../pipeline/StrategyStream.js';
import { StrategyLifecycle } from '../research/experiments/StrategyLifecycle.js';
import { OptionsExecutionService } from './OptionsExecutionService.js';
import { loadEligibleStrategies } from './EligibleStrategies.js';
import { assertDefined } from '../utils/assertDefined.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { print } from '../monitoring/print.js';

/** Automated runner: only reconstructed eligible hypotheses, never exploratory rankings. */
export async function runEligibleTrading(mode: 'DEMO' | 'LIVE'): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('EligibleTrading');
  if (mode === 'LIVE' && !isLiveTradingEnabled()) throw new Error('LIVE TRADING IS DISABLED: explicit live flags are required');
  if (mode === 'DEMO' && (!env.DEMO_TRADING || isLiveTradingEnabled())) throw new Error('Demo runner requires demo mode and disabled live execution');
  const argument = (name: string): string[] | undefined => {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--') || value.split(',').some(item => !item.trim())) throw new Error(`${name} requires comma-separated values`);
    return value.split(',').map(item => item.trim());
  };
  const db = getDb();
  const lifecycle = new StrategyLifecycle(db);
  const loaded = loadEligibleStrategies(db, mode, argument('--symbols') ?? env.SYMBOLS, argument('--hypotheses'));
  const streams = new Map(loaded.map(row => [row.symbol, new StrategyStream(row.symbol, [row.strategy], DEFAULT_CONTEXT_WINDOW,
    DEFAULT_WARMUP_TICKS, env.MAX_TICK_GAP_SECONDS * 1000)]));
  const pendingSignals = new Map<string, Signal>();
  const client = new DerivClient();
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    await client.disconnect();
    closeDb();
  };
  try {
    await client.connectPublic();
    await client.connectTrading(mode === 'DEMO' ? 'demo' : 'real');
    const account = assertDefined(client.getTradingAccount());
    const balance = await client.getBalance();
    const ledger = new OptionsLedger(db, account.accountId, mode, balance.balance);
    const risk = new RiskEngine(balance.balance, balance.currency, ledger);
    const execution = new OptionsExecutionService(client, ledger, risk, mode, signal => {
      const hypothesis = loaded.find(row => row.id === signal.hypothesisId && row.symbol === signal.symbol);
      if (signal.strategy !== hypothesis?.strategy.name) throw new Error('Signal does not belong to an authorized hypothesis');
      hypothesis.assertEligible();
    });
    await execution.start();
    for (const hypothesis of loaded) {
      const state = lifecycle.state(hypothesis.id);
      if (state === 'DEMO_ELIGIBLE' || state === 'LIVE_ELIGIBLE') lifecycle.transition(hypothesis.id,
        mode === 'DEMO' ? 'DEMO_RUNNING' : 'LIVE', 'Runner authenticated and reconciled; starting exact registered hypothesis');
    }
    client.on('disconnected', () => {
      for (const stream of streams.values()) stream.suspend('Market feed disconnected; restart with fresh state required');
    });
    client.on('tick', asyncHandler(async tick => {
      if (stopping) return;
      const stream = streams.get(tick.symbol);
      if (!stream || stream.getBlockedReason()) return;
      try {
        const { signals } = stream.process({ symbol: tick.symbol, epoch: tick.epoch, timestamp: new Date(tick.epoch * 1000), price: tick.quote });
        // Catalogue backtests declare a one-tick entry delay. Consume a queued
        // decision once on this symbol's next tick, even if risk then rejects it.
        const signal = pendingSignals.get(tick.symbol);
        pendingSignals.delete(tick.symbol);
        const generated = signals[0];
        if (generated && generated.direction !== 'NONE' && generated.confidence >= env.MIN_CONSENSUS_CONFIDENCE) pendingSignals.set(tick.symbol, generated);
        if (!signal || !execution.isReady()) return;
        const trade = await execution.execute(signal);
        print(`${mode} contract ${String(trade.contractId)} opened: ${trade.symbol}, USD ${String(trade.stakeAmount)}`);
      } catch (error) {
        // Revoked eligibility and invalid/interrupted streams stop this hypothesis.
        const hypothesis = loaded.find(row => row.symbol === tick.symbol);
        try { hypothesis?.assertEligible(); } catch { stream.suspend('Eligibility revoked; settlement reconciliation remains active'); }
        log.warn({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Signal/order rejected');
      }
    }, error => { log.error({ error }, 'Tick handler failed'); }));
    timer = setInterval(asyncHandler(async () => {
      for (const { intent, state } of await execution.poll()) print(`Settled ${String(intent.contract_id)}: USD ${String(state.profit)}`);
    }, error => { log.error({ error }, 'Reconciliation failed; new purchases blocked'); }), 5000);
    const stop = asyncHandler(shutdown, error => { log.error({ error }, 'Shutdown failed'); process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    for (const hypothesis of loaded) await client.subscribeTicks(hypothesis.symbol);
    print(`${mode}: ${String(loaded.length)} eligible hypotheses loaded; waiting for warm-up and signals.`);
  } catch (error) {
    await shutdown();
    throw error;
  }
}
