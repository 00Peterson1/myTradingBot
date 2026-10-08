import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { verifyCfdDemo } from '../../../src/cfd/CfdDemoVerification.js';
import { CfdLedger } from '../../../src/cfd/CfdLedger.js';
import { contentHash, ExperimentRegistry } from '../../../src/research/experiments/ExperimentRegistry.js';
import { cfdDatasetIdentity } from '../../../src/cfd/CfdDataset.js';
import { backtestCfd, cfdBacktestConfigSchema } from '../../../src/cfd/CfdBacktest.js';
import { validateCfd } from '../../../src/cfd/CfdValidation.js';
import { PaperCfdBroker } from '../../../src/cfd/PaperCfdBroker.js';
import { CfdExecutionController, type ReconcilingCfdBroker } from '../../../src/cfd/CfdExecutionController.js';
import type { CfdOrder } from '../../../src/cfd/types.js';
import type { CfdEvidence, CfdClosureEvidence } from '../../../src/cfd/CfdReconciliation.js';
const dataset = cfdDatasetIdentity(JSON.parse(readFileSync('examples/cfd/fixture.json', 'utf8')) as unknown).dataset;
const config = cfdBacktestConfigSchema.parse(JSON.parse(readFileSync('examples/cfd/config.json', 'utf8')) as unknown);
const order = (): CfdOrder => ({ product: 'CFD' as const, clientOrderId: randomUUID(), hypothesisId: 'fixture-only', symbol: 'EURUSD', side: 'LONG' as const, volumeLots: 0.1, stopLoss: 1.09, takeProfit: null, maxSlippagePoints: 1, createdAtMs: 1000 });
describe('CFD research and recovery workflow', () => {
  it('reconciles cumulative partial deals and releases a cancelled remainder without replacing it', () => {
    const db = new Database(':memory:');
    try {
      const ledger = new CfdLedger(db, { provider: 'PAPER', id: 'test', mode: 'PAPER' });
      const request = { kind: 'OPEN', order: order() } as const;
      ledger.begin(request);
      ledger.recover();
      const evidence: CfdEvidence = { accountKey: ledger.accountKey, clientOrderId: request.order.clientOrderId, requestHash: contentHash(request), brokerOrderId: 'broker-order', observedAtMs: 2000, state: 'WORKING', completeDealHistory: true,
        deals: [{ id: 'deal1', positionId: 'position', volumeLots: 0.04, price: 1.1, commission: 0.1, timeMs: 1500 }] };
      ledger.reconcile(request.order.clientOrderId, evidence);
      expect(ledger.unresolved()).toHaveLength(1);
      expect(() => { ledger.reconcile(request.order.clientOrderId, { ...evidence, observedAtMs: 2001, deals: [] }); }).toThrow('regressed');
      expect(() => { ledger.reconcile(request.order.clientOrderId, { ...evidence, deals: [...evidence.deals, ...evidence.deals] }); }).toThrow('Duplicate');
      expect(() => { ledger.reconcile(request.order.clientOrderId, { ...evidence, accountKey: 'wrong' }); }).toThrow('identity');
      const terminal = { ...evidence, observedAtMs: 2002, state: 'CANCELLED' };
      ledger.reconcile(request.order.clientOrderId, terminal);
      ledger.reconcile(request.order.clientOrderId, terminal);
      expect(ledger.unresolved()).toHaveLength(0);
      expect(ledger.find(request.order.clientOrderId)?.status).toBe('PARTIAL');
      expect(ledger.begin(request).created).toBe(false);
      expect(() => db.exec('DELETE FROM cfd_reconciliations')).toThrow('immutable');
    } finally { db.close(); }
  });
  it('refuses price-only, crossed, unordered or missing-cost datasets', () => {
    expect(() => cfdDatasetIdentity({ history: { prices: [1, 2], times: [1, 2] } })).toThrow();
    expect(() => cfdDatasetIdentity({ ...dataset, quotes: dataset.quotes.map(row => ({ ...row, ask: row.bid - 1 })) })).toThrow();
    expect(() => cfdDatasetIdentity({ ...dataset, quotes: [...dataset.quotes].reverse() })).toThrow();
    expect(() => cfdDatasetIdentity({ ...dataset, quotes: dataset.quotes.map(row => ({ timeMs: row.timeMs, bid: row.bid, ask: row.ask })) })).toThrow();
  });
  it('replays deterministically, includes costs, closes positions, and is causal', async () => {
    const first = await backtestCfd(dataset, config), second = await backtestCfd(dataset, config);
    expect(first).toEqual(second);
    expect(first.trades).toBeGreaterThan(0);
    expect(first.tradeNet.reduce((a, b) => a + b, 0)).toBeCloseTo(first.netProfit);
    expect(first.equity.at(-1)?.margin).toBe(0);
    const free = await backtestCfd({ ...dataset, quotes: dataset.quotes.map(row => ({ ...row, ask: row.bid, longFinancingPerLot: 0, shortFinancingPerLot: 0 })) }, { ...config, commissionPerLotPerSide: 0, slippageTicks: 0 });
    expect(free.netProfit).toBeGreaterThan(first.netProfit);
    const changed = await backtestCfd({ ...dataset, quotes: dataset.quotes.map((row, i) => i < 150 ? row : { ...row, bid: row.bid + 0.1, ask: row.ask + 0.1 }) }, config);
    expect(changed.equity.slice(0, 150)).toEqual(first.equity.slice(0, 150));
  });
  it('applies dated financing and a leverage reduction before margin stop-out', async () => {
    const paper = new PaperCfdBroker({ initialBalance: 10000, currency: 'USD', leverage: 100, commissionPerLotPerSide: 3, slippageTicks: 0, stopOutMarginRatio: 0.5 }, [dataset.instrument]);
    paper.advance({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: 1000 });
    await paper.submit({ ...order(), volumeLots: 1 });
    paper.advance({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: 2000 }, 1, { leverage: 1, longFinancingPerLot: -2, shortFinancingPerLot: -1 });
    const snapshot = await paper.snapshot();
    expect(snapshot.positions).toHaveLength(0);
    expect(snapshot.account.margin).toBe(0);
    expect(snapshot.account.balance).toBeCloseTo(9972);
    expect(paper.fills.at(-1)?.reason).toBe('SIMULATED_STOP_OUT');
  });
  it('reports missing cost and continuity evidence before consuming a holdout', async () => {
    const db = new Database(':memory:');
    try {
      const sparse = { ...dataset, kind: 'BROKER_BID_ASK' as const,
        quotes: dataset.quotes.map((row, i) => ({ ...row, timeMs: i * 86400000 })) };
      const understated = { ...config, commissionPerLotPerSide: 10, risk: { ...config.risk, commissionPerLotRoundTrip: 0 } };
      const result = await validateCfd(sparse, understated, new ExperimentRegistry(db, { fixture: 'validation blockers' }));
      expect(result.verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.blockers).toEqual(expect.arrayContaining(['INSUFFICIENT_CONTINUOUS_QUOTES', 'RISK_UNDERSTATES_COMMISSION']));
      expect(db.prepare('SELECT count(*) AS n FROM research_holdout_claims').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
  it('records fixture validation as insufficient and never promotes it', async () => {
    const db = new Database(':memory:');
    try {
      const result = await validateCfd(dataset, config, new ExperimentRegistry(db, { fixture: 'test' }));
      expect(result.verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.blockers).toContain('FIXTURE_IS_NOT_MARKET_EVIDENCE');
      expect(result.demoEligible).toBe(false);
      expect(db.prepare('SELECT * FROM research_holdout_claims').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM experiment_outcomes').all()).toHaveLength(1);
    } finally { db.close(); }
  });
  it('evaluates each declared neighbor only on development data and leaves insufficient holdouts sealed', async () => {
    const db = new Database(':memory:');
    try {
      const longData = { ...dataset, kind: 'EXTERNAL_BID_ASK' as const, source: 'Unit-test declaration only, not real market data', quotes: dataset.quotes.map((row, index) => ({ ...row, timeMs: 1700000000000 + index * 86400000 })) };
      const result = await validateCfd(longData, { ...config, maxGapMs: 86400001 }, new ExperimentRegistry(db, { fixture: 'declared daily sampling' }));
      expect(result.verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.recordedHypotheses).toBe(3);
      expect(result.final).toBeNull();
      expect(result.development).toHaveLength(3);
      const development = result.development as { periods: { bootstrapSensitivity: { blockLength: number }[] }[] }[];
      expect(development[0]?.periods[0]?.bootstrapSensitivity.map(row => row.blockLength)).toEqual([3, 5, 10]);
      expect(db.prepare('SELECT * FROM research_holdout_claims').all()).toHaveLength(0);
    } finally { db.close(); }
  });
  it('tests the demo verification protocol with a clearly labelled fixture and rejects paper accounts', async () => {
    const db = new Database(':memory:');
    try {
      const paper = new PaperCfdBroker({ initialBalance: 10000, currency: 'USD', leverage: 100, commissionPerLotPerSide: 3, slippageTicks: 1, stopOutMarginRatio: 0.5 }, [dataset.instrument]);
      paper.advance({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: 1000 });
      const snapshot = paper.snapshot.bind(paper);
      const broker: ReconcilingCfdBroker = Object.assign(paper, { orderEvidence: (): Promise<CfdEvidence | null> => Promise.resolve(null) });
      const registry = new ExperimentRegistry(db, { fixture: 'not a broker verification' });
      const ledger = new CfdLedger(db, { provider: 'FIXTURE', id: 'demo-fixture', mode: 'DEMO' });
      const controller = new CfdExecutionController(broker, ledger, { ...config.risk, maxRiskFraction: 0.02 }, 10000, { demoAccountId: 'demo-fixture', now: (): number => 1000, authorizeHypothesis: (): Promise<void> => Promise.resolve() });
      await expect(verifyCfdDemo(broker, controller, order(), { accountId: 'demo-fixture', maxVolumeLots: 0.1 }, registry)).rejects.toThrow('demo account');
      broker.snapshot = async (): ReturnType<ReconcilingCfdBroker['snapshot']> => {
        const result = await snapshot();
        return { ...result, account: { ...result.account, provider: 'FIXTURE', id: 'demo-fixture', mode: 'DEMO' } };
      };
      const result = await verifyCfdDemo(broker, controller, order(), { accountId: 'demo-fixture', maxVolumeLots: 0.1 }, registry);
      expect(result.status).toBe('ROUND_TRIP_CONFIRMED');
      expect(result.provider).toBe('FIXTURE');
      expect(result.liveEligible).toBe(false);
      expect((await broker.snapshot()).positions).toHaveLength(0);
    } finally { db.close(); }
  });
  it('completes a demo round trip beside an unprotected manual trade and never closes that trade', async () => {
    const db = new Database(':memory:');
    try {
      const paper = new PaperCfdBroker({ initialBalance: 10000, currency: 'USD', leverage: 100, commissionPerLotPerSide: 3, slippageTicks: 1, stopOutMarginRatio: 0.5 }, [dataset.instrument]);
      paper.advance({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: 1000 });
      const original = paper.snapshot.bind(paper);
      const manual = { id: 'phone-position', symbol: 'EURUSD', side: 'SHORT' as const, volumeLots: 1, entryPrice: 1.1,
        currentPrice: 1.1002, stopLoss: null, takeProfit: null, unrealizedPnl: -20, financing: 0, clientOrderId: null };
      let externalMargin = 100;
      const closeSpy = vi.spyOn(paper, 'close');
      const broker: ReconcilingCfdBroker = Object.assign(paper, { orderEvidence: (): Promise<CfdEvidence | null> => Promise.resolve(null) });
      broker.snapshot = async (): ReturnType<ReconcilingCfdBroker['snapshot']> => {
        const state = await original();
        return { account: { ...state.account, provider: 'FIXTURE', id: 'shared', mode: 'DEMO', margin: state.account.margin + externalMargin,
          freeMargin: state.account.freeMargin - externalMargin }, positions: [...state.positions, manual] };
      };
      const ledger = new CfdLedger(db, { provider: 'FIXTURE', id: 'shared', mode: 'DEMO' });
      const controller = new CfdExecutionController(broker, ledger, { ...config.risk, maxPositions: 1, maxRiskFraction: 0.02 }, 10000,
        { demoAccountId: 'shared', externalPositions: 'COEXIST', now: (): number => 1000, authorizeHypothesis: (): Promise<void> => Promise.resolve() });
      const result = await verifyCfdDemo(broker, controller, order(), { accountId: 'shared', maxVolumeLots: 0.1 }, new ExperimentRegistry(db, { fixture: 'shared account' }));
      expect(result.status).toBe('ROUND_TRIP_CONFIRMED');
      expect(result.externalPositionsAfter).toBe(1);
      expect((await broker.snapshot()).positions).toEqual([manual]);
      expect(await controller.close(manual.id, 1)).toMatchObject({ status: 'REJECTED', reason: 'Preflight rejected before broker submission' });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      externalMargin = 9999;
      expect(await controller.open(order())).toMatchObject({ status: 'REJECTED', reason: 'Preflight rejected before broker submission' });
      expect((await broker.snapshot()).positions).toEqual([manual]);
      controller.dispose();
    } finally { db.close(); }
  });
  it('requires broker exit history when a stop removes a position from the snapshot', async () => {
    const db = new Database(':memory:');
    try {
      const paper = new PaperCfdBroker({ initialBalance: 10000, currency: 'USD', leverage: 100, commissionPerLotPerSide: 3, slippageTicks: 1, stopOutMarginRatio: 0.5 }, [dataset.instrument]);
      let now = 1000;
      paper.advance({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: now });
      const broker: ReconcilingCfdBroker = Object.assign(paper, { orderEvidence: (): Promise<CfdEvidence | null> => Promise.resolve(null) });
      const ledger = new CfdLedger(db, { provider: 'PAPER', id: 'paper-cfd', mode: 'PAPER' });
      const controller = new CfdExecutionController(broker, ledger, { ...config.risk, maxRiskFraction: 0.02 }, 10000, { now: (): number => now, authorizeHypothesis: (): Promise<void> => Promise.resolve() });
      await controller.reconcile();
      const request = order(), opened = await controller.open(request);
      if (!('fill' in opened)) throw new Error('Expected fill');
      now = 2000;
      paper.advance({ symbol: 'EURUSD', bid: 1.08, ask: 1.0802, timeMs: now });
      await expect(controller.reconcile()).rejects.toThrow('disappeared');
      const evidence: CfdClosureEvidence = { accountKey: ledger.accountKey, positionId: opened.fill.positionId, openingClientOrderId: request.clientOrderId, symbol: 'EURUSD', side: 'LONG', state: 'CLOSED', completeDealHistory: true, observedAtMs: now,
        deals: [{ id: 'open', kind: 'OPEN', volumeLots: 0.1, price: opened.fill.price, timeMs: 1000 }, { id: 'stop', kind: 'CLOSE', volumeLots: 0.1, price: 1.07999, timeMs: now }] };
      broker.positionClosureEvidence = (): Promise<CfdClosureEvidence> => Promise.resolve(evidence);
      expect(await controller.reconcile()).toEqual({ unresolved: 0, positions: 0 });
      expect(ledger.positionClosed(opened.fill.positionId)).toBe(true);
      expect(() => { ledger.recordPositionClosure({ ...evidence, deals: [evidence.deals[0]] }); }).toThrow();
    } finally { db.close(); }
  });
  it('controls paper position opening/closing and blocks submissions after disconnect', async () => {
    const db = new Database(':memory:');
    try {
      const paper = new PaperCfdBroker({ initialBalance: 10000, currency: 'USD', leverage: 100, commissionPerLotPerSide: 3, slippageTicks: 1, stopOutMarginRatio: 0.5 }, [dataset.instrument]);
      paper.advance({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: 1000 });
      const broker: ReconcilingCfdBroker = Object.assign(paper, { orderEvidence: (): Promise<CfdEvidence | null> => Promise.resolve(null) });
      const ledger = new CfdLedger(db, { provider: 'PAPER', id: 'paper-cfd', mode: 'PAPER' });
      const controller = new CfdExecutionController(broker, ledger, { ...config.risk, maxRiskFraction: 0.02 }, 10000, { now: (): number => 1000, authorizeHypothesis: (): Promise<void> => Promise.resolve() });
      await expect(controller.open(order())).rejects.toThrow('reconciliation');
      await controller.reconcile();
      const opened = await controller.open(order());
      expect(opened.status).toBe('FILLED');
      if (!('fill' in opened)) throw new Error('Expected fill');
      const closed = await controller.close(opened.fill.positionId, opened.fill.filledLots);
      expect(closed.status).toBe('FILLED');
      expect((await broker.snapshot()).positions).toHaveLength(0);
      controller.disconnected();
      await expect(controller.open(order())).rejects.toThrow('reconciliation');
    } finally { db.close(); }
  });
});

describe('CFD lost-response recovery', () => {
  it('recovers an accepted order from deal evidence without a second submission', async () => {
    const db = new Database(':memory:');
    try {
      const paper = new PaperCfdBroker({ initialBalance: 10000, currency: 'USD', leverage: 100, commissionPerLotPerSide: 3, slippageTicks: 1, stopOutMarginRatio: 0.5 }, [dataset.instrument]);
      paper.advance({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timeMs: 1000 });
      const ledger = new CfdLedger(db, { provider: 'PAPER', id: 'paper-cfd', mode: 'PAPER' });
      const original = paper.submit.bind(paper);
      let submits = 0;
      let evidence: CfdEvidence | null = null;
      const broker: ReconcilingCfdBroker = Object.assign(paper, { orderEvidence: (): Promise<CfdEvidence | null> => Promise.resolve(evidence) });
      broker.submit = async (request): ReturnType<ReconcilingCfdBroker['submit']> => {
        submits++;
        const result = await original(request);
        if (!('fill' in result)) throw new Error('Fixture failed');
        evidence = { accountKey: ledger.accountKey, clientOrderId: request.clientOrderId, requestHash: contentHash({ kind: 'OPEN', order: request }), brokerOrderId: result.fill.orderId, observedAtMs: 1000, completeDealHistory: true, state: 'FILLED',
          deals: [{ id: 'one-deal', positionId: result.fill.positionId, volumeLots: result.fill.filledLots, price: result.fill.price, commission: result.fill.commission, timeMs: result.fill.timeMs }] };
        throw new Error('Connection dropped after acceptance');
      };
      const controller = new CfdExecutionController(broker, ledger, { ...config.risk, maxRiskFraction: 0.02 }, 10000, { now: (): number => 1000, authorizeHypothesis: (): Promise<void> => Promise.resolve() });
      await controller.reconcile();
      const request = order();
      expect((await controller.open(request)).status).toBe('UNKNOWN');
      controller.disconnected();
      expect(await controller.reconcile()).toEqual({ unresolved: 0, positions: 1 });
      expect((await controller.open(request)).status).toBe('FILLED');
      expect(submits).toBe(1);
    } finally { db.close(); }
  });
});
