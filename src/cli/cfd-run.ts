import { z } from 'zod';
import { readCTraderTokens, saveCTraderTokens } from '../cfd/ctrader/TokenStore.js';
import { handleHelp } from './help.js';
handleHelp('cfd:run', 'Continuous CFD DEMO workflow. --status checks evidence without networking. --symbol EURUSD --observe --cycles 10 records observed quotes without orders. Execution requires --deployment approved.json --execute-demo. --stop-file data/CFD_STOP pauses new work. --cycles N bounds a run; default continues until SIGINT/SIGTERM. --interval-ms 1000 controls polling; quote cadence must be reviewed against research data. Live accounts are never accepted.');
import 'dotenv/config';
import { parse as parseEnv } from 'dotenv';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../data/database/sqlite.js';
import { captureResearchCode, contentHash } from '../research/experiments/ExperimentRegistry.js';
import { ensureCfdRunnerSchema, loadCfdDeployment, type ApprovedCfdStrategy } from '../cfd/CfdDeployment.js';
import { CfdDemoRunner } from '../cfd/CfdDemoRunner.js';
import { CfdExecutionController } from '../cfd/CfdExecutionController.js';
import { CfdLedger } from '../cfd/CfdLedger.js';
import { CTraderDemoConnection, ctraderConfigSchema } from '../cfd/ctrader/DemoConnection.js';
import { CTraderDemoBroker } from '../cfd/ctrader/Broker.js';
import { print } from '../monitoring/print.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { status: { type: 'boolean' }, observe: { type: 'boolean' }, symbol: { type: 'string' }, deployment: { type: 'string' },
    'execute-demo': { type: 'boolean' }, cycles: { type: 'string' }, 'interval-ms': { type: 'string', default: '1000' },
    'stop-file': { type: 'string', default: 'data/CFD_STOP' }, out: { type: 'string', default: 'data/cfd-observed-quotes.jsonl' } }, strict: true });
  const interval = Number(values['interval-ms']), cycles = values.cycles === undefined ? Infinity : Number(values.cycles);
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 60000 || (cycles !== Infinity && (!Number.isSafeInteger(cycles) || cycles < 1))) throw new Error('Invalid runner interval or cycle limit');
  if (values.observe && values['execute-demo']) throw new Error('Observation and execution modes are mutually exclusive');
  const db = getDb(); ensureCfdRunnerSchema(db);
  let shuttingDown = false;
  const stop = (): void => { shuttingDown = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let connection: CTraderDemoConnection | undefined, broker: CTraderDemoBroker | undefined, controller: CfdExecutionController | undefined;
  let unsubscribe: (() => void) | undefined, runner: CfdDemoRunner | undefined;
  const dispose = (): void => { unsubscribe?.(); controller?.dispose(); broker?.dispose(); connection?.close(); connection = undefined; broker = undefined; controller = undefined; runner = undefined; };
  try {
    if (values.status || (!values.observe && !values['execute-demo'])) {
      const records = db.prepare('SELECT content FROM experiment_outcomes WHERE status=\'COMPLETED\'').all() as { content: string }[];
      const supported = records.filter(row => (JSON.parse(row.content) as { verdict?: string }).verdict === 'HOLDOUT_SUPPORTED_PENDING_BROKER_VERIFICATION').length;
      print(JSON.stringify({ mode: 'STATUS', supportedStudies: supported, executionEnabled: false, requirements: ['Matching deployment and immutable holdout/batch evidence', 'Historical cost, contract, quote cadence and demo execution review', 'Current source hash and unexpired demo approval'], liveEligible: false })); return;
    }
    if (values.observe && !values.symbol) throw new Error('Observation requires an exact CFD --symbol');
    if (values['execute-demo'] && !values.deployment) throw new Error('Execution requires a validated --deployment file; no strategy is approved by default');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const codeId = contentHash(captureResearchCode(root));
    const isShuttingDown = (): boolean => shuttingDown;
    const stopped = (): boolean => isShuttingDown() || existsSync(values['stop-file']);
    let count = 0, failures = 0, day = -1;
    let previousEquity: number | undefined;
    let cached: ApprovedCfdStrategy | undefined, deploymentBytes = '';
    function approved(accountId: string): ApprovedCfdStrategy {
      if (!values.deployment) throw new Error('Missing approved deployment');
      const bytes = readFileSync(values.deployment, 'utf8');
      if (!cached || bytes !== deploymentBytes) { cached = loadCfdDeployment(db, JSON.parse(bytes) as unknown, accountId, codeId); deploymentBytes = bytes; }
      if (Date.parse(cached.deployment.expiresAt) <= Date.now() || db.prepare('SELECT 1 FROM cfd_strategy_suspensions WHERE hypothesis_id=?').get(cached.deployment.hypothesisId)) throw new Error('CFD approval expired or suspended');
      return cached;
    }
    while (!isShuttingDown() && count++ < cycles) {
      try {
        if (stopped()) { runner?.reset(); print(JSON.stringify({ state: 'PAUSED', action: 'Remove stop file to resume; existing broker protection remains active' })); }
        else {
          // Re-read saved credentials on reconnect; token renewal failures never trigger an order retry.
          if (!connection || day !== Math.floor(Date.now() / 86400000)) {
            dispose(); cached = undefined;
            const local = existsSync(resolve(root, '.env')) ? parseEnv(readFileSync(resolve(root, '.env'))) : {};
            const env = { ...process.env, ...local };
            const config = ctraderConfigSchema.parse({ clientId: env.CTRADER_CLIENT_ID, clientSecret: env.CTRADER_CLIENT_SECRET, accessToken: env.CTRADER_ACCESS_TOKEN, accountId: env.CTRADER_DEMO_ACCOUNT_ID, ...(env.CTRADER_REFRESH_TOKEN ? { refreshToken: env.CTRADER_REFRESH_TOKEN } : {}) });
            const tokenPath = resolve(root, 'data/.ctrader-session.json');
            const tokens = readCTraderTokens(tokenPath, config.accountId, config.clientId);
            if (tokens) { config.accessToken = tokens.accessToken; config.refreshToken = tokens.refreshToken; }
            // Validate all evidence before opening a network connection in execution mode.
            const strategy = values['execute-demo'] ? approved(config.accountId) : undefined;
            if (strategy && strategy.deployment.pollIntervalMs !== interval) throw new Error('Runner quote interval differs from reviewed deployment');
            connection = new CTraderDemoConnection(config, { allowDemoOrders: Boolean(strategy), saveTokens: tokens => {
              saveCTraderTokens(tokenPath, { accountId: config.accountId, clientId: config.clientId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAtMs: Date.now() + tokens.expiresIn * 1000 });
              return Promise.resolve();
            } });
            const ledger = new CfdLedger(db, { provider: 'CTRADER', id: config.accountId, mode: 'DEMO' });
            broker = new CTraderDemoBroker(connection, db, ledger);
            await connection.connect(); await broker.initialize();
            day = Math.floor(Date.now() / 86400000);
            if (strategy) {
              const snapshot = await broker.snapshot();
              const activeBroker = broker;
              controller = new CfdExecutionController(broker, ledger, strategy.config.risk, previousEquity ?? snapshot.account.equity,
                { demoAccountId: config.accountId, externalPositions: 'COEXIST', now: Date.now, authorizeHypothesis: async order => {
                  const current = approved(config.accountId);
                  if (stopped() || current.deployment.hypothesisId !== order.hypothesisId || current.deployment.symbol !== order.symbol || order.volumeLots > current.deployment.maxLots) throw new Error('CFD strategy approval changed or runner paused');
                  const quote = await activeBroker.quote(order.symbol), instrument = await activeBroker.instrument(order.symbol);
                  const entry = (order.side === 'LONG' ? quote.ask : quote.bid) + (order.side === 'LONG' ? 1 : -1) * order.maxSlippagePoints * instrument.priceTick;
                  const loss = -(await activeBroker.estimateProfit(order, entry, order.stopLoss)) + Math.max(order.volumeLots * current.config.risk.commissionPerLotRoundTrip, await activeBroker.estimateCommission(order, entry, order.stopLoss));
                  if (!Number.isFinite(loss) || loss <= 0 || loss > current.deployment.maxPlannedLoss) throw new Error('CFD approved cash-risk cap exceeded');
                } });
              runner = new CfdDemoRunner(db, broker, controller, ledger, () => approved(config.accountId), stopped);
            }
            unsubscribe = connection.onDisconnect(() => { runner?.reset(); });
          }
          if (!broker) throw new Error('CFD session unavailable');
          if (values.observe) {
            const symbol = values.symbol ?? '';
            await broker.instrument(symbol); // Reject synthetic/unknown names even in this real-market observer.
            const quote = await broker.quote(symbol);
            const path = resolve(values.out); mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, `${JSON.stringify({ kind: 'OBSERVED_QUOTE_NOT_VALIDATED_DATASET', accountId: connection.accountId, observedAtMs: Date.now(), ...quote })}\n`, { mode: 0o600 });
            print(JSON.stringify({ state: 'OBSERVING', symbol, quoteTimeMs: quote.timeMs, output: path, ordersSubmitted: 0 }));
          } else if (runner) {
            print(JSON.stringify({ state: await runner.step(), mode: 'DEMO', liveEligible: false }));
            previousEquity = (await broker.snapshot()).account.equity;
          }
          failures = 0;
        }
      } catch (error) {
        const reason = error instanceof z.ZodError ? 'Invalid configuration or evidence schema' : error instanceof Error ? error.message : 'CFD operation failed';
        failures++; dispose();
        print(JSON.stringify({ state: 'BLOCKED_OR_DISCONNECTED', reason, action: 'Check deployment evidence, local credentials, market availability and reconciliation; no replacement orders submitted', consecutiveFailures: failures }));
        if (cycles !== Infinity) process.exitCode = 2;
      }
      if (!isShuttingDown() && count < cycles) await new Promise(resolve => setTimeout(resolve, Math.min(30000, failures ? interval * 2 ** Math.min(failures, 5) : interval)));
    }
  } finally { dispose(); process.off('SIGINT', stop); process.off('SIGTERM', stop); closeDb(); }
}
main().catch(() => { print('CFD runner stopped: invalid configuration or missing evidence. Credentials suppressed; no live execution supported.'); process.exitCode = 1; });
