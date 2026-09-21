#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('research:daemon', 'Continuous public tick collection in MARKET_SCOPE. Uses COLLECT_SYMBOLS or SYMBOLS; refreshes market availability every 5 minutes. --duration SECONDS runs a bounded collection.');
import { print } from '../monitoring/print.js';
import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { getDb, closeDb } from '../data/database/sqlite.js';
import { MarketCatalogue } from '../markets/MarketCatalogue.js';
import { selectMarkets } from '../markets/MarketScope.js';
import { ContinuousTickBuffer } from '../research/ContinuousTickBuffer.js';
import { bulkInsertTicks } from '../data/repository/TickRepository.js';

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);
  const log = createLogger('ResearchDaemon');
  const index = process.argv.indexOf('--duration');
  const duration = index < 0 ? null : Number(process.argv[index + 1]);
  if (duration !== null && (!Number.isInteger(duration) || duration < 1)) throw new Error('--duration requires positive integer seconds');
  getDb();
  const client = new DerivClient();
  const subscribed = new Set<string>();
  const buffer = new ContinuousTickBuffer(rows => bulkInsertTicks(rows));
  let stopping = false;
  let refreshing = false;
  const isStopping = (): boolean => stopping;
  let flushTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let saved = 0;
  const flush = (): void => { saved += buffer.flush(); };
  const stop = async (): Promise<void> => {
    if (isStopping()) return;
    stopping = true;
    if (flushTimer) clearInterval(flushTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    if (stopTimer) clearTimeout(stopTimer);
    await client.disconnect();
    try { flush(); print(`Collection stopped: ${String(saved)} raw ticks saved; ${String(buffer.size)} buffered.`); }
    finally { closeDb(); }
  };
  const failed = (error: unknown): void => {
    process.exitCode = 1;
    log.error({ error: error instanceof Error ? error.message : 'Unknown collection error' }, 'Collector failed');
    void stop().catch((shutdownError: unknown) => { console.error(shutdownError); });
  };
  const refresh = async (): Promise<void> => {
    if (isStopping() || refreshing) return;
    refreshing = true;
    try {
      const markets = await MarketCatalogue.discoverAll(client);
      if (isStopping()) return;
      const requested = env.COLLECT_SYMBOLS.length ? env.COLLECT_SYMBOLS : env.SYMBOLS;
      buffer.setSymbols(selectMarkets(markets, env.MARKET_SCOPE, requested).map(market => market.symbol));
      const active = selectMarkets(markets, env.MARKET_SCOPE, requested, true);
      const desired = new Set(active.map(market => market.symbol));
      for (const symbol of subscribed) if (!desired.has(symbol)) { await client.unsubscribeTicks(symbol); subscribed.delete(symbol); }
      for (const symbol of desired) if (!subscribed.has(symbol)) {
        if (isStopping()) return;
        await client.subscribeTicks(symbol);
        subscribed.add(symbol);
      }
      print(`${env.MARKET_SCOPE}: continuously collecting ${String(subscribed.size)} open instruments. Closed markets will be checked again in 5 minutes.`);
    } finally { refreshing = false; }
  };
  client.on('tick', tick => {
    if (isStopping()) return;
    // subscribeTicks emits its first tick before resolving; classify against the
    // discovered catalogue and scope rather than losing that first observation.
    try {
      if (!buffer.accepts(tick.symbol)) return;
      buffer.push({ symbol: tick.symbol, epoch: tick.epoch, price: tick.quote });
      if (buffer.size >= 1000) flush();
    } catch (error) { failed(error); }
  });
  client.on('disconnected', () => { if (!isStopping()) log.warn('Feed disconnected; missing observations remain explicit gaps in stored data'); });
  try {
    await client.connectPublic();
    await refresh();
    flushTimer = setInterval(() => { try { flush(); } catch (error) { failed(error); } }, 5000);
    refreshTimer = setInterval(() => { void refresh().catch(failed); }, 300_000);
    process.once('SIGINT', () => { void stop().catch(failed); });
    process.once('SIGTERM', () => { void stop().catch(failed); });
    if (duration !== null) stopTimer = setTimeout(() => { void stop().catch(failed); }, duration * 1000);
  } catch (error) { await stop(); throw error; }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Collection failed'); process.exitCode = 1; });
