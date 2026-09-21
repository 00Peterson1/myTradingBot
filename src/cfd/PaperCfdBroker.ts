import { randomUUID } from 'node:crypto';
import { contentHash } from '../research/experiments/ExperimentRegistry.js';
import { validateCfdOrder } from './CfdRisk.js';
import { cfdInstrumentSchema, cfdQuoteSchema, type CfdAccount, type CfdBroker, type CfdFill, type CfdInstrument, type CfdOrder, type CfdOrderResult, type CfdPosition, type CfdQuote, type CfdSnapshot } from './types.js';
import { assertDefined } from '../utils/assertDefined.js';

export interface PaperCfdPolicy {
  initialBalance: number; currency: string; leverage: number; commissionPerLotPerSide: number;
  slippageTicks: number; stopOutMarginRatio: number;
}
interface PaperPosition { position: CfdPosition; margin: number }

/** Explicit bid/ask CFD simulator. Financing is supplied as dated account-currency cashflows. */
export class PaperCfdBroker implements CfdBroker {
  private balance: number;
  private now = 0;
  private readonly instruments = new Map<string, CfdInstrument>();
  private readonly quotes = new Map<string, CfdQuote>();
  private readonly conversion = new Map<string, number>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly requests = new Map<string, { hash: string; result: CfdOrderResult }>();
  private readonly financingIds = new Set<string>();
  readonly fills: { kind: 'OPEN' | 'CLOSE'; positionId: string; symbol: string; volumeLots: number; price: number; pnl: number; commission: number; timeMs: number; reason: string }[] = [];

  constructor(private readonly policy: PaperCfdPolicy, instruments: readonly CfdInstrument[]) {
    if (Object.entries(policy).some(([key, value]) => key !== 'currency' && (typeof value !== 'number' || !Number.isFinite(value))) ||
      policy.initialBalance <= 0 || policy.leverage < 1 || policy.commissionPerLotPerSide < 0 || !Number.isInteger(policy.slippageTicks) || policy.slippageTicks < 0 || policy.stopOutMarginRatio <= 0) throw new Error('Invalid paper CFD assumptions');
    if (instruments.length !== 1) throw new Error('Paper CFD studies require one instrument; portfolio quote synchronization is not implemented');
    if (!/^[A-Z]{3}$/.test(policy.currency)) throw new Error('Invalid paper account currency');
    this.balance = policy.initialBalance;
    for (const item of instruments) {
      cfdInstrumentSchema.parse(item);
      if (this.instruments.has(item.symbol)) throw new Error('Duplicate CFD instrument');
      this.instruments.set(item.symbol, { ...item });
    }
  }
  instrument(symbol: string): Promise<CfdInstrument> { return Promise.resolve({ ...this.instrumentNow(symbol) }); }
  quote(symbol: string): Promise<CfdQuote> { return Promise.resolve({ ...this.quoteNow(symbol) }); }
  private instrumentNow(symbol: string): CfdInstrument { return assertDefined(this.instruments.get(symbol)); }
  private quoteNow(symbol: string): CfdQuote { return assertDefined(this.quotes.get(symbol)); }
  private rate(symbol: string): number { return assertDefined(this.conversion.get(symbol)); }
  private pnl(position: CfdPosition, exit: number, volume = position.volumeLots): number {
    return (exit - position.entryPrice) * (position.side === 'LONG' ? 1 : -1) * volume * this.instrumentNow(position.symbol).contractSize * this.rate(position.symbol);
  }
  private margin(symbol: string, volume: number, entry: number): number {
    return volume * this.instrumentNow(symbol).contractSize * entry * this.rate(symbol) / this.policy.leverage;
  }
  estimateMargin(order: CfdOrder, entry: number): Promise<number> { return Promise.resolve(this.margin(order.symbol, order.volumeLots, entry)); }
  estimateProfit(order: CfdOrder, entry: number, exit: number): Promise<number> {
    return Promise.resolve((exit - entry) * (order.side === 'LONG' ? 1 : -1) * order.volumeLots * this.instrumentNow(order.symbol).contractSize * this.rate(order.symbol));
  }
  private account(): CfdAccount {
    const positions = [...this.positions.values()];
    const equity = this.balance + positions.reduce((sum, row) => sum + row.position.unrealizedPnl, 0);
    const margin = positions.reduce((sum, row) => sum + row.margin, 0);
    return { id: 'paper-cfd', provider: 'PAPER', mode: 'PAPER', currency: this.policy.currency, balance: this.balance, equity, margin,
      freeMargin: equity - margin, tradeAllowed: true, hedging: true, timeMs: this.now };
  }
  snapshot(): Promise<CfdSnapshot> { return Promise.resolve({ account: this.account(), positions: [...this.positions.values()].map(row => ({ ...row.position })) }); }

  /** Gaps fill stops at the next executable quote, never at an invented stop price. */
  advance(input: CfdQuote, profitCurrencyToAccount?: number): void {
    const quote = cfdQuoteSchema.parse(input);
    const instrument = this.instrumentNow(quote.symbol);
    if (quote.timeMs < this.now) throw new Error('CFD events must be globally chronological');
    const rate = instrument.profitCurrency === this.policy.currency ? 1 : profitCurrencyToAccount;
    if (rate === undefined || !Number.isFinite(rate) || rate <= 0) throw new Error('Historical account-currency conversion required');
    this.now = quote.timeMs;
    this.quotes.set(quote.symbol, quote);
    this.conversion.set(quote.symbol, rate);
    for (const row of this.positions.values()) if (row.position.symbol === quote.symbol) {
      const position = row.position;
      position.currentPrice = position.side === 'LONG' ? quote.bid : quote.ask;
      position.unrealizedPnl = this.pnl(position, position.currentPrice);
      row.margin = this.margin(position.symbol, position.volumeLots, position.currentPrice);
      const stopped = position.stopLoss !== null && (position.side === 'LONG' ? quote.bid <= position.stopLoss : quote.ask >= position.stopLoss);
      const target = position.takeProfit !== null && (position.side === 'LONG' ? quote.bid >= position.takeProfit : quote.ask <= position.takeProfit);
      if (stopped || target) this.closeNow(position.id, position.volumeLots, stopped ? 'STOP_LOSS' : 'TAKE_PROFIT');
    }
    this.enforceStopOut();
  }

  private enforceStopOut(): void {
    while (this.account().margin > 0 && this.account().equity / this.account().margin <= this.policy.stopOutMarginRatio) {
      const worst = [...this.positions.values()].sort((a, b) => a.position.unrealizedPnl - b.position.unrealizedPnl)[0];
      if (!worst) break;
      this.closeNow(worst.position.id, worst.position.volumeLots, 'SIMULATED_STOP_OUT');
    }
  }

  accrueFinancing(id: string, positionId: string, amount: number, timeMs: number): void {
    if (!Number.isFinite(amount) || timeMs !== this.now) throw new Error('Financing must be an explicit cashflow at the current event time');
    if (this.financingIds.has(id)) throw new Error('Financing event already applied');
    const row = assertDefined(this.positions.get(positionId));
    row.position.financing += amount;
    this.balance += amount;
    this.financingIds.add(id);
    this.enforceStopOut();
  }

  submit(order: CfdOrder): Promise<CfdOrderResult> {
    const hash = contentHash(order), prior = this.requests.get(order.clientOrderId);
    if (prior) { if (prior.hash !== hash) throw new Error('Client order ID reused with changed CFD request'); return Promise.resolve(prior.result); }
    const instrument = this.instrumentNow(order.symbol), quote = this.quoteNow(order.symbol);
    validateCfdOrder(order, instrument, quote, this.now, 5000);
    const price = (order.side === 'LONG' ? quote.ask : quote.bid) + (order.side === 'LONG' ? 1 : -1) * instrument.priceTick * this.policy.slippageTicks;
    const margin = this.margin(order.symbol, order.volumeLots, price), commission = order.volumeLots * this.policy.commissionPerLotPerSide;
    if (this.policy.slippageTicks > order.maxSlippagePoints || margin + commission > this.account().freeMargin) {
      const result: CfdOrderResult = { status: 'REJECTED', reason: this.policy.slippageTicks > order.maxSlippagePoints ? 'Slippage limit exceeded' : 'Insufficient CFD margin' };
      this.requests.set(order.clientOrderId, { hash, result });
      return Promise.resolve(result);
    }
    const id = randomUUID();
    const position: CfdPosition = { id, symbol: order.symbol, side: order.side, volumeLots: order.volumeLots, entryPrice: price,
      currentPrice: order.side === 'LONG' ? quote.bid : quote.ask, stopLoss: order.stopLoss, takeProfit: order.takeProfit,
      unrealizedPnl: 0, financing: 0, clientOrderId: order.clientOrderId };
    position.unrealizedPnl = this.pnl(position, position.currentPrice);
    this.balance -= commission;
    this.positions.set(id, { position, margin });
    const fill: CfdFill = { orderId: order.clientOrderId, positionId: id, filledLots: order.volumeLots, price, commission, timeMs: this.now };
    const result: CfdOrderResult = { status: 'FILLED', fill };
    this.requests.set(order.clientOrderId, { hash, result });
    this.fills.push({ kind: 'OPEN', positionId: id, symbol: order.symbol, volumeLots: order.volumeLots, price, pnl: 0, commission, timeMs: this.now, reason: 'MARKET' });
    return Promise.resolve(result);
  }
  close(positionId: string, volumeLots: number, clientOrderId: string): Promise<CfdOrderResult> {
    const hash = contentHash({ positionId, volumeLots });
    const prior = this.requests.get(clientOrderId);
    if (prior) { if (prior.hash !== hash) throw new Error('Close request ID reused'); return Promise.resolve(prior.result); }
    const result = this.closeNow(positionId, volumeLots, 'MARKET_CLOSE');
    this.requests.set(clientOrderId, { hash, result });
    return Promise.resolve(result);
  }
  private closeNow(positionId: string, volumeLots: number, reason: string): CfdOrderResult {
    const row = assertDefined(this.positions.get(positionId));
    const position = row.position, instrument = this.instrumentNow(position.symbol), quote = this.quoteNow(position.symbol);
    if (quote.timeMs !== this.now) throw new Error('Cannot simulate a CFD fill using a stale cross-market quote');
    if (!Number.isFinite(volumeLots) || volumeLots <= 0 || volumeLots > position.volumeLots || Math.abs(volumeLots / instrument.volumeStep - Math.round(volumeLots / instrument.volumeStep)) > 1e-7) throw new Error('Invalid CFD close volume');
    const price = (position.side === 'LONG' ? quote.bid : quote.ask) + (position.side === 'LONG' ? -1 : 1) * instrument.priceTick * this.policy.slippageTicks;
    const pnl = this.pnl(position, price, volumeLots), commission = volumeLots * this.policy.commissionPerLotPerSide;
    this.balance += pnl - commission;
    const oldVolume = position.volumeLots;
    position.volumeLots = Number((position.volumeLots - volumeLots).toFixed(8));
    if (position.volumeLots <= 0) this.positions.delete(positionId);
    else { row.margin *= position.volumeLots / oldVolume; position.unrealizedPnl = this.pnl(position, position.currentPrice); }
    this.fills.push({ kind: 'CLOSE', positionId, symbol: position.symbol, volumeLots, price, pnl, commission, timeMs: this.now, reason });
    return { status: 'FILLED', fill: { orderId: randomUUID(), positionId, filledLots: volumeLots, price, commission, timeMs: this.now } };
  }
}
