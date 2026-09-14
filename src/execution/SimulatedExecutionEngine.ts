import type { OptionsLedger } from '../portfolio/OptionsLedger.js';
import { money, optionSpecificationSchema, majorUnits } from '../types/product.js';
import { contractWon } from '../backtest/contractOutcome.js';
import type { ApprovedSignal } from '../types/signal.js';
import type { Tick } from '../types/tick.js';

export interface SimulatedExecutionConfig {
  payoutMultiplier: number;
  feePerTrade: number;
  pipSize?: number;
}
interface OpenSimulation {
  approved: ApprovedSignal;
  intentId: string;
  entry: Tick;
  remainingTicks: number;
  expiryMs: number | null;
  lastPrice: number;
}
export interface SimulatedSettlement {
  intentId: string;
  signalId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  entryTime: Date;
  exitTime: Date;
  stake: number;
  profit: number;
  payout: number;
  won: boolean;
}

/** Deterministic fixed-quote assumption, with real ledger debits and expiry events. */
export class SimulatedExecutionEngine {
  private readonly lastEventMs = new Map<string, number>();
  private open = new Map<string, OpenSimulation>();

  constructor(readonly ledger: OptionsLedger, private readonly config: SimulatedExecutionConfig) {
    if (!Number.isFinite(config.payoutMultiplier) || config.payoutMultiplier <= 0) throw new Error('Invalid payout assumption');
    money(config.feePerTrade, 'USD', 2);
    if (config.feePerTrade < 0) throw new Error('Execution fees cannot be negative');
  }

  execute(approved: ApprovedSignal, entry: Tick): string {
    const spec = optionSpecificationSchema.parse(approved.optionSpecification);
    if (approved.signal.direction === 'NONE' || approved.signal.product !== 'OPTIONS' || entry.symbol !== spec.symbol) throw new Error('Invalid Options entry');
    this.validateTick(entry);
    if (spec.stake.currency !== 'USD' || spec.stake.decimals !== 2 || majorUnits(spec.stake) !== approved.stakeAmount) throw new Error('Inconsistent simulation stake');
    // Reject unsupported outcome assumptions before debiting the account.
    contractWon({ ...approved.signal, metadata: { contractType: spec.contractType, barrier: spec.barrier } }, entry.price, entry.price, this.config.pipSize);
    const intent = this.ledger.reserve(() => approved, this.config.feePerTrade);
    this.ledger.markSubmitting(intent.intent_id);
    const totalCost = (spec.stake.minorUnits + money(this.config.feePerTrade, 'USD', 2).minorUnits) / 100;
    this.ledger.recordPurchase(intent.intent_id, `SIM:${intent.intent_id}`, totalCost, { entry });
    const durationMs = spec.durationUnit === 't' ? null : spec.duration * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[spec.durationUnit];
    this.open.set(intent.intent_id, { approved, intentId: intent.intent_id, entry,
      remainingTicks: spec.duration, expiryMs: durationMs === null ? null : entry.timestamp.getTime() + durationMs,
      lastPrice: entry.price });
    return intent.intent_id;
  }

  /** Process expiries before considering new signals on this tick. No future prices are read. */
  onTick(tick: Tick, onProfit: (profit: number) => void): SimulatedSettlement[] {
    this.validateTick(tick);
    this.lastEventMs.set(tick.symbol, tick.timestamp.getTime());
    const settlements: SimulatedSettlement[] = [];
    for (const position of this.open.values()) {
      if (position.entry.symbol !== tick.symbol) continue;
      position.remainingTicks--;
      const due = position.expiryMs === null ? position.remainingTicks <= 0 : tick.timestamp.getTime() >= position.expiryMs;
      if (!due) { position.lastPrice = tick.price; continue; }
      const spec = position.approved.optionSpecification;
      // For time contracts use the latest observed quote at/before expiry, never the later arrival's price.
      const exitPrice = position.expiryMs !== null && tick.timestamp.getTime() > position.expiryMs ? position.lastPrice : tick.price;
      const won = contractWon({ ...position.approved.signal, metadata: { contractType: spec.contractType, barrier: spec.barrier } },
        position.entry.price, exitPrice, this.config.pipSize);
      const stake = majorUnits(spec.stake);
      // Explicit simulation assumption: fixed quoted payout, rounded to the nearest USD cent.
      const payoutMinor = won ? Math.round(spec.stake.minorUnits * (1 + this.config.payoutMultiplier)) : 0;
      const profitMinor = payoutMinor - spec.stake.minorUnits - money(this.config.feePerTrade, 'USD', 2).minorUnits;
      const profit = profitMinor / 100;
      this.ledger.recordSettlement(position.intentId, payoutMinor / 100, profit, () => { onProfit(profit); });
      this.open.delete(position.intentId);
      if (position.approved.signal.direction === 'NONE') throw new Error('Invalid open direction');
      settlements.push({ intentId: position.intentId, signalId: position.approved.signal.id, symbol: tick.symbol,
        direction: position.approved.signal.direction, entryPrice: position.entry.price, exitPrice,
        entryTime: position.entry.timestamp, exitTime: new Date(position.expiryMs ?? tick.timestamp.getTime()),
        stake, profit, payout: payoutMinor / 100, won });
    }
    return settlements;
  }

  private validateTick(tick: Tick): void {
    const timestamp = tick.timestamp.getTime();
    if (!Number.isFinite(timestamp) || !Number.isFinite(tick.price) || tick.price <= 0 ||
        timestamp < (this.lastEventMs.get(tick.symbol) ?? -Infinity)) throw new Error('Invalid or out-of-order simulation tick');
    for (const position of this.open.values()) {
      if (position.entry.symbol === tick.symbol && timestamp < position.entry.timestamp.getTime()) throw new Error('Tick precedes open position');
    }
  }

  getOpenCount(): number { return this.open.size; }
}
