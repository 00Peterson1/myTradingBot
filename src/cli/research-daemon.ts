#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('research:daemon', 'Public tick collector; persists batches. Configure SYMBOLS and collection slots.');
import { print } from '../monitoring/print.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { configureLogger, createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';
import { renderBanner, renderSafetyStatus } from '../monitoring/Dashboard.js';
import { DerivClient } from '../api/deriv/DerivClient.js';
import { getDb, closeDb } from '../data/database/sqlite.js';
import { MarketCatalogue } from '../markets/MarketCatalogue.js';
import { MarketScheduler } from '../research/MarketScheduler.js';
import { FeatureEngine } from '../features/FeatureEngine.js';
import {
  bulkInsertTicks,
  bulkUpsertTickFeatures,
  type TickInsert,
} from '../data/repository/TickRepository.js';
import type { Tick } from '../types/tick.js';
import type { DerivTick } from '../api/deriv/DerivTypes.js';

const log = createLogger('ResearchDaemon');

let isShuttingDown = false;

async function collectForSymbol(client: DerivClient, symbol: string, durationSecs: number): Promise<void> {
  const ticks: Tick[] = [];


  const subscribed = await new Promise<boolean>((resolve) => {
    const handler = (tick: DerivTick): void => {
      if (tick.symbol !== symbol) return;
      ticks.push({
        symbol: tick.symbol,
        epoch: tick.epoch,
        timestamp: new Date(tick.epoch * 1000),
        price: tick.quote,
        ...(tick.id !== undefined ? { tickId: tick.id } : {})
      });
    };

    client.on('tick', handler);

    client.subscribeTicks(symbol).catch((err: unknown) => {
      log.warn({ symbol, err }, 'Subscription failed');
      clearTimeout(timer);
      client.off('tick', handler);
      resolve(false);
    });

    const timer = setTimeout(() => {
      client.off('tick', handler);
      client.unsubscribeTicks(symbol).catch((error: unknown) => { log.warn({ error, symbol }, 'Unsubscribe failed'); });
      resolve(true);
    }, durationSecs * 1000);
  });

  if (!subscribed || ticks.length === 0) return;

  try {
    const tickInserts: TickInsert[] = ticks.map((t) => ({
      symbol: t.symbol,
      epoch: t.epoch,
      price: t.price,
      ...(t.tickId !== undefined ? { tickId: t.tickId } : {}),
    }));
    bulkInsertTicks(tickInserts);

    const db = getDb();
    const featureEngine = new FeatureEngine(symbol);
    const featurePairs: { rowId: bigint; features: ReturnType<FeatureEngine['process']> }[] = [];

    for (const tick of ticks) {
      const features = featureEngine.process(tick);
      const row = db
        .prepare<[string, number], { id: number }>(
          'SELECT id FROM ticks WHERE symbol = ? AND epoch = ? LIMIT 1',
        )
        .get(tick.symbol, tick.epoch);
      if (row) {
        featurePairs.push({ rowId: BigInt(row.id), features });
      }
    }

    bulkUpsertTickFeatures(featurePairs);
  } catch (err) {
    log.error({ symbol, err }, 'Failed to save ticks/features');
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  configureLogger(env.LOG_LEVEL, env.LOG_PRETTY);

  renderBanner();
  renderSafetyStatus(env.DEMO_TRADING, env.LIVE_TRADING);

  print('Daemon initializing database...');
  getDb();

  const client = new DerivClient();
  await client.connectPublic();

  print('Discovering markets...');
  let markets = await MarketCatalogue.discoverAll(client);

  const categories = new Set(markets.map((m) => m.marketCategory));
  print(`Discovered ${String(markets.length)} markets across ${String(categories.size)} categories`);

  setInterval(asyncHandler(async () => {
    try {
      log.info('Running periodic market discovery...');
      markets = await MarketCatalogue.discoverAll(client);
    } catch (err) {
      log.error({ err }, 'Failed periodic discovery');
    }
  }, (error: unknown) => { log.error({ error }, 'Asynchronous handler failed'); process.exitCode = 1; }), 6 * 60 * 60 * 1000); // 6 hours

  const scheduler = new MarketScheduler();

  let activeFast: string[] = [];
  let activeSlow: string | null = null;
  let fastElapsed = 0;
  let slowElapsed = 0;

  // Live progress
  setInterval(() => {
    if (isShuttingDown) return;
    try {
      const row = getDb().prepare('SELECT COUNT(*) as count FROM ticks').get() as { count: number };
      const currentTicks = row.count;

      const fastStr = activeFast.length > 0 ? `${activeFast.join(',')} ${String(fastElapsed)}/${String(env.SLOT_SECS_FAST)}s` : 'none';
      const slowStr = activeSlow ? `${activeSlow} ${String(slowElapsed)}/${String(env.SLOT_SECS_SLOW)}s` : 'none';

      process.stdout.write(`\r[DAEMON] fast: ${fastStr} | slow: ${slowStr} | DB: ${String(currentTicks)} ticks total\x1b[K`);
    } catch {
      // ignore
    }
  }, 5000);

  // Fast loop
  const runFastLoop = async (): Promise<void> => {
    while (!isShuttingDown) {
      try {
        const { fast } = scheduler.nextBatch(markets);
        if (fast.length === 0) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        activeFast = fast;
        fastElapsed = 0;

        const timer = setInterval(() => fastElapsed++, 1000);
        await Promise.all(fast.map(sym => collectForSymbol(client, sym, env.SLOT_SECS_FAST)));
        clearInterval(timer);

        for (const sym of fast) {
          scheduler.markCollected(sym);
        }
      } catch (err) {
        log.error({ err }, 'Fast loop error');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  // Slow loop
  const runSlowLoop = async (): Promise<void> => {
    while (!isShuttingDown) {
      try {
        const { slow } = scheduler.nextBatch(markets);
        if (!slow) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        activeSlow = slow;
        slowElapsed = 0;

        const timer = setInterval(() => slowElapsed++, 1000);
        await collectForSymbol(client, slow, env.SLOT_SECS_SLOW);
        clearInterval(timer);

        scheduler.markCollected(slow);
      } catch (err) {
        log.error({ err }, 'Slow loop error');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  void runFastLoop().catch((error: unknown) => { log.fatal({ error }, 'Fast loop stopped'); process.exitCode = 1; });
  void runSlowLoop().catch((error: unknown) => { log.fatal({ error }, 'Slow loop stopped'); process.exitCode = 1; });

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    print('\nShutting down gracefully...');
    await client.disconnect();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', asyncHandler(shutdown, (error: unknown) => { log.error({ error }, 'Shutdown failed'); process.exitCode = 1; }));
  process.on('SIGTERM', asyncHandler(shutdown, (error: unknown) => { log.error({ error }, 'Shutdown failed'); process.exitCode = 1; }));
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'Daemon crashed');
  process.exit(1);
});
