import { handleHelp } from './help.js';
handleHelp('cfd:execution', 'Inspect actual CFD account/contracts with --symbol BTCUSD. --verify-demo performs ONE protected minimum-volume demo round trip with physical reconnect. --max-loss 1 bounds planned loss in account currency (maximum 5); gaps can exceed stops. --reconcile recovers durable intents without placing orders. --out receipt.json is required for demo verification. Never uses live accounts.');
import 'dotenv/config';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { CTraderDemoConnection, ctraderConfigSchema } from '../cfd/ctrader/DemoConnection.js';
import { CTraderDemoBroker } from '../cfd/ctrader/Broker.js';
import { CfdLedger } from '../cfd/CfdLedger.js';
import { CfdExecutionController } from '../cfd/CfdExecutionController.js';
import { verifyCfdDemo } from '../cfd/CfdDemoVerification.js';
import { approveCfdOrder, type CfdRiskPolicy } from '../cfd/CfdRisk.js';
import type { CfdOrder } from '../cfd/types.js';
import { ExperimentRegistry, captureResearchCode } from '../research/experiments/ExperimentRegistry.js';
import { writeNewJson } from '../cfd/history/CfdCsvImport.js';
import { getDb, closeDb } from '../data/database/sqlite.js';
import { print } from '../monitoring/print.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { symbol: { type: 'string' }, 'verify-demo': { type: 'boolean' }, reconcile: { type: 'boolean' }, 'close-position': { type: 'string' }, 'max-loss': { type: 'string', default: '1' }, out: { type: 'string' } }, strict: true });
  const verify = values['verify-demo'] ?? false, maxLoss = Number(values['max-loss']);
  if (!Number.isFinite(maxLoss) || maxLoss <= 0 || maxLoss > 5) throw new Error('Planned demo loss limit must be greater than zero and at most 5 account-currency units');
  if (verify && (!values.out || existsSync(values.out))) throw new Error('Demo verification requires --out pointing to a new receipt file');
  if ((verify && values['close-position']) || (values.reconcile && values['close-position'])) throw new Error('Choose only one operation');
  if (verify && values.reconcile) throw new Error('Reconcile and verify must be separate invocations');
  const config = ctraderConfigSchema.parse({ clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET, accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: process.env.CTRADER_DEMO_ACCOUNT_ID });
  const connection = new CTraderDemoConnection(config, { allowDemoOrders: verify || Boolean(values['close-position']) });
  const db = getDb(), ledger = new CfdLedger(db, { provider: 'CTRADER', id: config.accountId, mode: 'DEMO' });
  const broker = new CTraderDemoBroker(connection, db, ledger);
  let controller: CfdExecutionController | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await connection.connect(); await broker.initialize();
    const snapshot = await broker.snapshot();
    const policy: CfdRiskPolicy = { maxRiskFraction: Math.min(0.01, maxLoss / snapshot.account.equity), maxMarginFraction: 0.1,
      maxSpreadFraction: 0.01, maxQuoteAgeMs: 15000, commissionPerLotRoundTrip: 0, maxPositions: 1, maxDailyLossFraction: 0.02 };
    // This authorization is restricted to one operator-requested connectivity test, not a strategy permit.
    const hypothesisId = `DEMO_CONNECTIVITY_ONLY:${randomUUID()}`;
    controller = new CfdExecutionController(broker, ledger, policy, snapshot.account.equity, { demoAccountId: config.accountId, externalPositions: 'COEXIST', now: Date.now,
      authorizeHypothesis: (order): Promise<void> => {
        if (!verify || order.hypothesisId !== hypothesisId) return Promise.reject(new Error('No validated CFD strategy permit'));
        return Promise.resolve();
      } });
    const activeController = controller;
    unsubscribe = connection.onDisconnect(() => { activeController.disconnected(); });
    if (values.reconcile) {
      const result = await controller.reconcile(); print(JSON.stringify({ accountId: config.accountId, ...result, liveEligible: false }));
      if (result.unresolved) process.exitCode = 2;
      return;
    }
    if (values['close-position']) {
      await controller.reconcile();
      const current = await broker.snapshot(), position = current.positions.find(row => row.id === values['close-position']);
      if (!position) throw new Error('Requested position is not open');
      const closed = await controller.close(position.id, position.volumeLots);
      const reconciled = await controller.reconcile();
      print(JSON.stringify({ closed, reconciled, accountId: config.accountId, liveEligible: false }));
      if (reconciled.unresolved || (await broker.snapshot()).positions.some(row => activeController.ownsPosition(row.id))) process.exitCode = 2;
      return;
    }
    if (!values.symbol) throw new Error('--symbol must be an exact CFD catalogue name');
    const instrument = await broker.instrument(values.symbol), quote = await broker.quote(values.symbol);
    if (!verify) { print(JSON.stringify({ account: snapshot.account, positions: snapshot.positions, instrument, quote, unresolved: ledger.unresolved().length, strategyEligible: false, liveEligible: false }, null, 2)); return; }
    await controller.reconcile();
    const fresh = await broker.quote(values.symbol), tick = instrument.priceTick;
    const distance = Math.max(instrument.minStopDistance, fresh.ask * (instrument.minStopDistanceFraction ?? 0), (fresh.ask - fresh.bid) * 3, tick * 20) * 1.5;
    const order: CfdOrder = { product: 'CFD', clientOrderId: randomUUID(), hypothesisId, symbol: values.symbol, side: 'LONG', volumeLots: instrument.volumeMin,
      stopLoss: Number((Math.floor((fresh.bid - distance) / tick) * tick).toFixed(10)), takeProfit: null,
      maxSlippagePoints: Math.max(5, Math.ceil((fresh.ask - fresh.bid) / tick)), createdAtMs: Date.now() };
    const approval = await approveCfdOrder(broker, order, (await broker.snapshot()).account, policy, { positions: 0, reservedMargin: 0, reservedRisk: 0, dailyStartEquity: snapshot.account.equity });
    if (approval.plannedLoss > maxLoss) throw new Error('Minimum broker volume exceeds the demo planned-loss cap');
    print(JSON.stringify({ action: 'ONE_DEMO_ROUND_TRIP', accountId: config.accountId, symbol: order.symbol, lots: order.volumeLots, plannedLoss: approval.plannedLoss, currency: snapshot.account.currency }));
    const registry = new ExperimentRegistry(db, captureResearchCode(fileURLToPath(new URL('../../', import.meta.url))));
    const result = await verifyCfdDemo(broker, controller, order, { accountId: config.accountId, maxVolumeLots: instrument.volumeMin,
      reconnect: async () => { connection.close(); await connection.connect(); await broker.initialize(); await broker.quote(order.symbol); } }, registry);
    if (!values.out) throw new Error('Missing receipt path');
    await writeNewJson(values.out, result);
    print(JSON.stringify({ status: result.status, receipt: values.out, accountId: config.accountId, liveEligible: false }));
    if (result.status !== 'ROUND_TRIP_CONFIRMED') process.exitCode = 2;
  } finally { unsubscribe?.(); controller?.dispose(); broker.dispose(); connection.close(); closeDb(); }
}
main().catch((error: unknown) => { print(error instanceof z.ZodError ? 'Invalid configuration, risk limits or broker metadata' : error instanceof Error ? error.message : 'CFD check failed'); print('CFD execution check failed. No automatic retry: inspect the local ledger and run cfd:execution --reconcile before another verification. Credentials and raw broker errors are suppressed.'); process.exitCode = 1; });
