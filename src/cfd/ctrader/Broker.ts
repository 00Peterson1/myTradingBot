import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { CTraderDemoConnection } from './DemoConnection.js';
import { catalogueResearchEntries, type CTraderCatalogue } from './Catalogue.js';
import { CTraderOrderJournal } from './OrderJournal.js';
import { completeHistory, enumIs, identifier, integer, money, object, positive, rows, volumeUnits, type Wire } from './Protocol.js';
import { cfdAccountSchema, cfdInstrumentSchema, cfdOrderSchema, cfdPositionSchema, cfdQuoteSchema,
  type CfdInstrument, type CfdOrder, type CfdOrderResult, type CfdQuote, type CfdSnapshot } from '../types.js';
import { cfdRequestSchema, type CfdLedger, type CfdRequest } from '../CfdLedger.js';
import { reconcileCfdEvidence, type CfdClosureEvidence, type CfdEvidence } from '../CfdReconciliation.js';
import type { ReconcilingCfdBroker } from '../CfdExecutionController.js';
import { canonicalJson, contentHash } from '../../research/experiments/ExperimentRegistry.js';

interface Specification { instrument: CfdInstrument; raw: Wire; id: string; lotSize: number }
interface Spot { bid?: number; ask?: number; bidTime?: number; askTime?: number }

/** Actual cTrader demo adapter. Unknown metadata, stale prices and uncertain executions fail closed. */
export class CTraderDemoBroker implements ReconcilingCfdBroker {
  private catalogueData: CTraderCatalogue | undefined;
  private readonly assets = new Map<string, string>();
  private readonly specs = new Map<string, Specification>();
  private readonly spots = new Map<string, Spot>();
  private readonly subscriptions = new Set<string>();
  private readonly journal: CTraderOrderJournal;
  private currency = '';
  private depositAssetId = '';
  private readonly removeEvent: () => void;
  private readonly removeDisconnect: () => void;
  constructor(readonly connection: CTraderDemoConnection, db: Database.Database, private readonly ledger: CfdLedger) {
    if (ledger.accountKey !== canonicalJson({ provider: 'CTRADER', id: connection.accountId, mode: 'DEMO' })) throw new Error('cTrader ledger identity mismatch');
    this.journal = new CTraderOrderJournal(db, connection.accountId);
    this.removeEvent = connection.onEvent((type, payload) => {
      if (type === 2131) {
        const id = identifier(payload.symbolId), previous = this.spots.get(id) ?? {};
        const time = integer(payload.timestamp);
        if (payload.bid !== undefined && time >= (previous.bidTime ?? 0)) { previous.bid = integer(payload.bid) / 100000; previous.bidTime = time; }
        if (payload.ask !== undefined && time >= (previous.askTime ?? 0)) { previous.ask = integer(payload.ask) / 100000; previous.askTime = time; }
        this.spots.set(id, previous);
      }
      if (type === 2120) this.specs.clear();
      if (type === 2126 && payload.order) {
        const order = object(payload.order);
        if (typeof order.clientOrderId === 'string' && this.journal.find(order.clientOrderId)) this.journal.bind(order.clientOrderId, identifier(order.orderId));
      }
    });
    this.removeDisconnect = connection.onDisconnect(() => { this.spots.clear(); this.subscriptions.clear(); this.specs.clear(); });
  }
  dispose(): void { this.removeEvent(); this.removeDisconnect(); }
  async initialize(): Promise<void> {
    this.catalogueData = await this.connection.catalogue();
    for (const asset of rows((await this.connection.read(2112)).asset)) this.assets.set(identifier(asset.assetId), z.string().min(1).parse(asset.name));
    const trader = object((await this.connection.read(2121)).trader);
    this.depositAssetId = identifier(trader.depositAssetId);
    this.currency = this.assets.get(this.depositAssetId) ?? '';
    if (!this.currency) throw new Error('Unknown cTrader deposit currency');
  }
  private light(symbol: string): CTraderCatalogue['symbols'][number] {
    const row = this.catalogueData?.symbols.find(item => item.symbolName === symbol);
    if (!row) throw new Error('Symbol is absent from the authenticated CFD catalogue'); return row;
  }
  private symbolName(id: unknown): string {
    const symbol = this.catalogueData?.symbols.find(row => row.symbolId === identifier(id))?.symbolName;
    if (!symbol) throw new Error('Unknown broker symbol identity'); return symbol;
  }
  private async specification(symbol: string): Promise<Specification> {
    const cached = this.specs.get(symbol); if (cached) return cached;
    if (!this.catalogueData) throw new Error('cTrader adapter is not initialized');
    const entry = catalogueResearchEntries(this.catalogueData).find(item => item.symbol === symbol);
    if (!entry || entry.category === 'synthetic' || entry.category === 'unknown' || entry.catalogueStatus !== 'ACTIVE') throw new Error('CFD symbol is not an active classified real market');
    const light = this.light(symbol);
    const response = await this.connection.read(2116, { symbolId: [integer(light.symbolId)] });
    const raw = rows(response.symbol).find(row => identifier(row.symbolId) === light.symbolId);
    if (!raw) throw new Error('Missing broker contract specification');
    const lotSize = positive(integer(raw.lotSize)), digits = integer(raw.digits);
    if (digits < 0 || digits > 10) throw new Error('Invalid symbol price precision');
    const distance = Math.max(integer(raw.slDistance), integer(raw.tpDistance));
    const percentageDistance = enumIs(raw.distanceSetIn, 2, 'SYMBOL_DISTANCE_IN_PERCENTAGE');
    if (!percentageDistance && !enumIs(raw.distanceSetIn ?? 1, 1, 'SYMBOL_DISTANCE_IN_POINTS')) throw new Error('Unknown stop distance unit');
    const instrument = cfdInstrumentSchema.parse({ symbol, category: entry.category, contractSize: lotSize / 100,
      volumeMin: integer(raw.minVolume) / lotSize, volumeMax: integer(raw.maxVolume) / lotSize,
      volumeStep: integer(raw.stepVolume) / lotSize, priceTick: 10 ** -digits, minStopDistance: percentageDistance ? 0 : distance * 10 ** -digits,
      ...(percentageDistance ? { minStopDistanceFraction: distance / 10000 } : {}),
      profitCurrency: this.assets.get(light.quoteAssetId ?? '') });
    const result = { instrument, raw, id: light.symbolId, lotSize }; this.specs.set(symbol, result); return result;
  }
  async instrument(symbol: string): Promise<CfdInstrument> { return (await this.specification(symbol)).instrument; }
  private async spot(id: string): Promise<Spot> {
    if (!this.subscriptions.has(id)) {
      await this.connection.read(2127, { symbolId: [integer(id)], subscribeToSpotTimestamp: true }); this.subscriptions.add(id);
    }
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const spot = this.spots.get(id), now = Date.now();
      if (spot?.bid && spot.ask && spot.bidTime && spot.askTime && Math.min(spot.bidTime, spot.askTime) >= now - 5000 && Math.max(spot.bidTime, spot.askTime) <= now && spot.ask >= spot.bid) return spot;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('No fresh two-sided cTrader quote; market may be closed');
  }
  async quote(symbol: string): Promise<CfdQuote> {
    const quote = await this.spot(this.light(symbol).symbolId);
    return cfdQuoteSchema.parse({ symbol, bid: quote.bid, ask: quote.ask, timeMs: Math.min(quote.bidTime ?? 0, quote.askTime ?? 0) });
  }
  private async convert(value: number, fromAssetId: string, targetAssetId = this.depositAssetId): Promise<number> {
    if (fromAssetId === targetAssetId) return value;
    const response = await this.connection.read(2118, { firstAssetId: integer(fromAssetId), lastAssetId: integer(targetAssetId) });
    const links = rows(response.symbol);
    // Find a currency conversion chain; never assume a currency is USD or a conversion equals one.
    const queue: { asset: string; path: { id: string; inverse: boolean }[] }[] = [{ asset: fromAssetId, path: [] }];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift(); if (!current || seen.has(current.asset)) continue; seen.add(current.asset);
      if (current.asset === targetAssetId) {
        let result = value;
        for (const link of current.path) {
          const spot = await this.spot(link.id), bid = positive(spot.bid), ask = positive(spot.ask);
          result *= link.inverse ? 1 / (value < 0 ? bid : ask) : (value < 0 ? ask : bid);
        }
        return result;
      }
      for (const link of links) {
        const base = identifier(link.baseAssetId), quote = identifier(link.quoteAssetId), id = identifier(link.symbolId);
        if (base === current.asset) queue.push({ asset: quote, path: [...current.path, { id, inverse: false }] });
        if (quote === current.asset) queue.push({ asset: base, path: [...current.path, { id, inverse: true }] });
      }
    }
    throw new Error('No verified deposit currency conversion chain');
  }
  async estimateProfit(order: CfdOrder, entryPrice: number, exitPrice: number): Promise<number> {
    const spec = await this.specification(order.symbol), quoteAsset = this.light(order.symbol).quoteAssetId;
    if (!quoteAsset) throw new Error('Missing profit currency');
    const gross = (positive(exitPrice) - positive(entryPrice)) * spec.instrument.contractSize * positive(order.volumeLots) * (order.side === 'LONG' ? 1 : -1);
    const converted = await this.convert(gross, quoteAsset);
    const fee = integer(spec.raw.pnlConversionFeeRate ?? 0) / 10000;
    if (fee < 0) throw new Error('Invalid conversion fee');
    return converted - (quoteAsset !== this.depositAssetId ? Math.abs(converted) * fee : 0);
  }
  async estimateCommission(order: CfdOrder, entryPrice: number, exitPrice: number): Promise<number> {
    const spec = await this.specification(order.symbol), raw = spec.raw, quoteAsset = this.light(order.symbol).quoteAssetId;
    const usd = [...this.assets].find(([, name]) => name === 'USD')?.[0];
    if (!quoteAsset || !usd) throw new Error('Missing commission currency metadata');
    const rate = integer(raw.preciseTradingCommissionRate), minimum = integer(raw.preciseMinCommission);
    if (rate < 0 || minimum < 0) throw new Error('Unsupported negative commission');
    const minimumAsset = enumIs(raw.minCommissionType ?? 1, 2, 'QUOTE_CURRENCY') ? quoteAsset : [...this.assets].find(([, name]) => name === (raw.minCommissionAsset ?? 'USD'))?.[0];
    if (!minimumAsset) throw new Error('Unknown minimum commission currency');
    const minCost = Math.abs(await this.convert(-minimum / 1e8, minimumAsset));
    const costs: number[] = [];
    for (const price of [entryPrice, exitPrice]) {
      const notional = positive(price) * spec.instrument.contractSize * order.volumeLots;
      let cost: number;
      if (rate === 0) cost = 0;
      else if (enumIs(raw.commissionType ?? 1, 1, 'USD_PER_MILLION_USD')) {
        const usdNotional = Math.abs(await this.convert(-notional, quoteAsset, usd));
        cost = Math.abs(await this.convert(-usdNotional / 1e6 * rate / 1e8, usd));
      } else if (enumIs(raw.commissionType, 2, 'USD_PER_LOT')) cost = Math.abs(await this.convert(-order.volumeLots * rate / 1e8, usd));
      else if (enumIs(raw.commissionType, 3, 'PERCENTAGE_OF_VALUE')) cost = Math.abs(await this.convert(-notional * rate / 1e7, quoteAsset));
      else if (enumIs(raw.commissionType, 4, 'QUOTE_CCY_PER_LOT')) cost = Math.abs(await this.convert(-order.volumeLots * rate / 1e8, quoteAsset));
      else throw new Error('Unsupported broker commission type');
      costs.push(Math.max(cost, minCost));
    }
    return costs.reduce((sum, cost) => sum + cost, 0);
  }
  async estimateMargin(order: CfdOrder, _entryPrice: number): Promise<number> {
    const spec = await this.specification(order.symbol), units = volumeUnits(order.volumeLots, spec.lotSize);
    const response = await this.connection.read(2139, { symbolId: integer(spec.id), volume: [units] });
    const margin = rows(response.margin).find(item => integer(item.volume) === units);
    if (!margin) throw new Error('Missing broker margin estimate');
    return positive(money(order.side === 'LONG' ? margin.buyMargin : margin.sellMargin, response.moneyDigits));
  }
  async snapshot(): Promise<CfdSnapshot> {
    const started = Date.now(), trader = object((await this.connection.read(2121)).trader);
    if (identifier(trader.ctidTraderAccountId) !== this.connection.accountId || identifier(trader.depositAssetId) !== this.depositAssetId) throw new Error('Trader identity or currency changed');
    if (trader.isLimitedRisk === true || [trader.managerBonus, trader.ibBonus, trader.nonWithdrawableBonus].some(value => value !== undefined && integer(value) !== 0)) throw new Error('Limited-risk or bonus-funded accounts require separate equity/margin support');
    const state = await this.connection.read(2124), rawPositions = rows(state.position);
    if (rows(state.order).length) throw new Error('Pending broker orders require reconciliation before a risk snapshot');
    const pnl = await this.connection.read(2187), profit = rows(pnl.positionUnrealizedPnL);
    if (profit.length !== rawPositions.length || new Set(profit.map(row => identifier(row.positionId))).size !== profit.length) throw new Error('Position/PnL snapshot changed; reconcile again');
    let margin = 0, net = 0;
    const positions = [];
    for (const row of rawPositions) {
      if (!enumIs(row.positionStatus, 1, 'POSITION_STATUS_OPEN')) throw new Error('Unexpected broker position status');
      const trade = object(row.tradeData), symbol = this.symbolName(trade.symbolId), spec = await this.specification(symbol);
      const side = enumIs(trade.tradeSide, 1, 'BUY') ? 'LONG' : enumIs(trade.tradeSide, 2, 'SELL') ? 'SHORT' : null;
      const amount = profit.find(item => identifier(item.positionId) === identifier(row.positionId));
      if (!amount || !side) throw new Error('Invalid broker position/PnL identity');
      const quote = await this.quote(symbol), unrealized = money(amount.netUnrealizedPnL, pnl.moneyDigits);
      net += unrealized; margin += money(row.usedMargin, row.moneyDigits);
      positions.push(cfdPositionSchema.parse({ id: identifier(row.positionId), symbol, side, volumeLots: integer(trade.volume) / spec.lotSize,
        entryPrice: positive(row.price), currentPrice: side === 'LONG' ? quote.bid : quote.ask, stopLoss: row.stopLoss ?? null, takeProfit: row.takeProfit ?? null,
        unrealizedPnl: unrealized, financing: money(row.swap, row.moneyDigits), clientOrderId: null }));
    }
    const balance = money(trader.balance, trader.moneyDigits), equity = balance + net;
    return { account: cfdAccountSchema.parse({ id: this.connection.accountId, provider: 'CTRADER', mode: 'DEMO', currency: this.currency,
      balance, equity, margin, freeMargin: equity - margin, tradeAllowed: enumIs(trader.accessRights ?? 0, 0, 'FULL_ACCESS'),
      hedging: enumIs(trader.accountType ?? 0, 0, 'HEDGED'), timeMs: started }), positions };
  }
  private requireIntent(request: CfdRequest): void {
    const id = request.kind === 'OPEN' ? request.order.clientOrderId : request.clientOrderId;
    const intent = this.ledger.find(id);
    if (intent?.status !== 'SUBMITTING' || intent.request_hash !== contentHash(request)) throw new Error('Durable authorized submission intent required');
  }
  async submit(input: CfdOrder): Promise<CfdOrderResult> {
    const order = cfdOrderSchema.parse(input), request: CfdRequest = { kind: 'OPEN', order };
    this.requireIntent(request);
    const spec = await this.specification(order.symbol), quote = await this.quote(order.symbol);
    if (!enumIs(spec.raw.tradingMode ?? 0, 0, 'ENABLED') || (order.side === 'SHORT' && spec.raw.enableShortSelling !== true)) throw new Error('Symbol does not permit this opening order');
    const units = volumeUnits(order.volumeLots, spec.lotSize);
    if (units < integer(spec.raw.minVolume) || units > integer(spec.raw.maxVolume) || units % integer(spec.raw.stepVolume) !== 0) throw new Error('Invalid broker volume');
    const payload: Wire = { symbolId: integer(spec.id), orderType: 5, tradeSide: order.side === 'LONG' ? 1 : 2, volume: units,
      timeInForce: 3, baseSlippagePrice: order.side === 'LONG' ? quote.ask : quote.bid, slippageInPoints: order.maxSlippagePoints,
      stopLoss: order.stopLoss, clientOrderId: order.clientOrderId, label: 'myTradingBot-demo' };
    if (order.takeProfit !== null) payload.takeProfit = order.takeProfit;
    if (!this.journal.reserve(request, spec.id, spec.lotSize)) return this.existingResult(request);
    return this.dispatch(2106, payload, request);
  }
  async close(positionId: string, volumeLots: number, clientOrderId: string): Promise<CfdOrderResult> {
    const request = cfdRequestSchema.parse({ kind: 'CLOSE', positionId, volumeLots, clientOrderId }); this.requireIntent(request);
    const position = (await this.snapshot()).positions.find(row => row.id === positionId);
    if (!position || volumeLots > position.volumeLots) throw new Error('Invalid position close');
    const spec = await this.specification(position.symbol), volume = volumeUnits(volumeLots, spec.lotSize);
    if (volume % integer(spec.raw.stepVolume) !== 0) throw new Error('Invalid close volume step');
    if (!this.journal.reserve(request, spec.id, spec.lotSize)) return this.existingResult(request);
    return this.dispatch(2111, { positionId: integer(positionId), volume }, request);
  }
  private async dispatch(type: 2106 | 2111, payload: Wire, request: CfdRequest): Promise<CfdOrderResult> {
    try {
      const event = await this.connection.trade(type, payload);
      const id = request.kind === 'OPEN' ? request.order.clientOrderId : request.clientOrderId;
      if (event.order) this.journal.bind(id, identifier(object(event.order).orderId));
      // ACCEPTED is not FILLED. Fetch cumulative authoritative details until terminal or bounded timeout.
      for (let attempt = 0; attempt < 12; attempt++) {
        const evidence = await this.orderEvidence(request);
        if (evidence) {
          const resolved = reconcileCfdEvidence(request, this.ledger.accountKey, evidence);
          if (resolved.terminal) return resolved.result;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch { /* A post-dispatch exception cannot prove the order was rejected. */ }
    return { status: 'UNKNOWN', reason: 'Broker outcome uncertain; reconcile the durable intent before any further order' };
  }
  private async existingResult(request: CfdRequest): Promise<CfdOrderResult> {
    const evidence = await this.orderEvidence(request);
    return evidence ? reconcileCfdEvidence(request, this.ledger.accountKey, evidence).result : { status: 'UNKNOWN', reason: 'Prior dispatch has no complete broker receipt; not resubmitted' };
  }
  async orderEvidence(input: CfdRequest): Promise<CfdEvidence | null> {
    const request = cfdRequestSchema.parse(input), clientId = request.kind === 'OPEN' ? request.order.clientOrderId : request.clientOrderId;
    let intent = this.journal.find(clientId);
    if (intent?.request_hash !== contentHash(request)) return null;
    if (!intent.broker_order_id && request.kind === 'OPEN') {
      const history = await completeHistory((fromTimestamp, toTimestamp) => this.connection.read(2175, { fromTimestamp, toTimestamp }), 'order', 'orderId', Math.max(0, request.order.createdAtMs - 5000), Date.now());
      const matching = history.filter(row => row.clientOrderId === clientId);
      if (matching.length > 1) throw new Error('Multiple broker orders share a client identity');
      if (matching[0]) { this.journal.bind(clientId, identifier(matching[0].orderId)); intent = this.journal.find(clientId); }
    }
    // ClosePositionReq has no clientOrderId: missing ACK cannot be safely matched by volume/time alone.
    if (!intent?.broker_order_id) return null;
    const details = await this.connection.read(2181, { orderId: integer(intent.broker_order_id) }), order = object(details.order), trade = object(order.tradeData);
    if (identifier(order.orderId) !== intent.broker_order_id || identifier(trade.symbolId) !== intent.symbol_id) throw new Error('Broker receipt identity mismatch');
    const requestedVolume = request.kind === 'OPEN' ? request.order.volumeLots : request.volumeLots;
    if (integer(trade.volume) !== volumeUnits(requestedVolume, intent.lot_size)) throw new Error('Broker order volume mismatch');
    if (request.kind === 'OPEN' && (order.clientOrderId !== clientId || order.closingOrder === true || !enumIs(trade.tradeSide, request.order.side === 'LONG' ? 1 : 2, request.order.side === 'LONG' ? 'BUY' : 'SELL'))) throw new Error('Opening broker receipt mismatch');
    if (request.kind === 'CLOSE' && (identifier(order.positionId) !== request.positionId || order.closingOrder !== true)) throw new Error('Closing broker receipt mismatch');
    const status = order.orderStatus;
    const state = enumIs(status, 1, 'ORDER_STATUS_ACCEPTED') ? 'WORKING' : enumIs(status, 2, 'ORDER_STATUS_FILLED') ? 'FILLED' : enumIs(status, 3, 'ORDER_STATUS_REJECTED') ? 'REJECTED' : enumIs(status, 4, 'ORDER_STATUS_EXPIRED') || enumIs(status, 5, 'ORDER_STATUS_CANCELLED') ? 'CANCELLED' : null;
    if (!state) throw new Error('Unknown broker order status');
    const deals: CfdEvidence['deals'] = [];
    for (const deal of rows(details.deal)) {
      if (identifier(deal.orderId) !== intent.broker_order_id || identifier(deal.symbolId) !== intent.symbol_id) throw new Error('Broker deal identity mismatch');
      const volume = integer(deal.filledVolume);
      if (volume === 0) continue;
      if (!enumIs(deal.dealStatus, 2, 'FILLED') && !enumIs(deal.dealStatus, 3, 'PARTIALLY_FILLED')) throw new Error('Uncertain deal status');
      deals.push({ id: identifier(deal.dealId), positionId: identifier(deal.positionId), volumeLots: volume / intent.lot_size,
        price: positive(deal.executionPrice), commission: Math.abs(money(deal.commission, deal.moneyDigits)), timeMs: integer(deal.executionTimestamp) });
    }
    const evidence: CfdEvidence = { accountKey: this.ledger.accountKey, clientOrderId: clientId, requestHash: contentHash(request), brokerOrderId: intent.broker_order_id,
      observedAtMs: Date.now(), state, completeDealHistory: true, deals };
    reconcileCfdEvidence(request, this.ledger.accountKey, evidence); return evidence;
  }
  async positionClosureEvidence(positionId: string): Promise<CfdClosureEvidence | null> {
    const opening = this.ledger.intents().find(intent => {
      if (!intent.result_json) return false;
      const result = object(JSON.parse(intent.result_json) as unknown);
      return Boolean(this.ledger.order(intent)) && result.fill !== undefined && object(result.fill).positionId === positionId;
    });
    if (!opening) return null;
    const order = this.ledger.order(opening); if (!order) return null;
    const spec = await this.specification(order.symbol);
    const history = await completeHistory((fromTimestamp, toTimestamp) => this.connection.read(2179, { positionId: integer(positionId), fromTimestamp, toTimestamp }), 'deal', 'dealId', order.createdAtMs, Date.now());
    const deals: CfdClosureEvidence['deals'] = [];
    let net = 0;
    for (const deal of history) {
      if (identifier(deal.positionId) !== positionId || identifier(deal.symbolId) !== spec.id) throw new Error('Position deal history identity mismatch');
      const filled = integer(deal.filledVolume); if (!filled) continue;
      if (!enumIs(deal.dealStatus, 2, 'FILLED') && !enumIs(deal.dealStatus, 3, 'PARTIALLY_FILLED')) throw new Error('Uncertain position deal status');
      const kind = deal.closePositionDetail === undefined ? 'OPEN' : 'CLOSE', volumeLots = filled / spec.lotSize;
      net += kind === 'OPEN' ? volumeLots : -volumeLots;
      deals.push({ id: identifier(deal.dealId), kind, volumeLots, price: positive(deal.executionPrice), timeMs: integer(deal.executionTimestamp) });
    }
    if (!deals.length || Math.abs(net) > 1e-8) return null;
    if (rows((await this.connection.read(2124)).position).some(row => identifier(row.positionId) === positionId)) return null;
    return { accountKey: this.ledger.accountKey, positionId, openingClientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side,
      state: 'CLOSED', completeDealHistory: true, observedAtMs: Date.now(), deals };
  }
}
