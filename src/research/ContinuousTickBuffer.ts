import type { TickInsert } from '../data/repository/TickRepository.js';

/** Raw observations are persisted before deletion from memory; retries retain their order. */
export class ContinuousTickBuffer {
  private pending: TickInsert[] = [];
  private symbols = new Set<string>();
  constructor(private readonly persist: (rows: TickInsert[]) => number) {}
  get size(): number { return this.pending.length; }
  setSymbols(symbols: readonly string[]): void { this.symbols = new Set(symbols); }
  accepts(symbol: string): boolean { return this.symbols.has(symbol); }
  push(tick: TickInsert): void {
    if (!this.accepts(tick.symbol)) throw new Error('Tick outside selected collection scope');
    if (!Number.isFinite(tick.price) || tick.price <= 0 || !Number.isInteger(tick.epoch) || tick.epoch < 0) throw new Error('Invalid collection tick');
    this.pending.push({ ...tick });
  }
  flush(): number {
    if (!this.pending.length) return 0;
    const batch = this.pending.slice();
    const saved = this.persist(batch);
    this.pending.splice(0, batch.length);
    return saved;
  }
}
