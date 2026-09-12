import { getDb } from '../../data/database/sqlite.js';
import { cointegrationTest, type CointegrationResult } from './CointegrationTest.js';

export interface SpreadState {
  pairId: string;
  symbolA: string;
  symbolB: string;
  betaHedgeRatio: number;
  spreadMean: number;
  spreadStd: number;
  cointegrationP: number;
  lastZScore: number;
  windowSize: number;
  updatedAt: Date;
}

export class SpreadTracker {
  private logPricesA: number[] = [];
  private logPricesB: number[] = [];
  
  private updateCount = 0;
  private currentCointegration: CointegrationResult | null = null;
  public readonly state: SpreadState;
  
  constructor(symbolA: string, symbolB: string, windowSize: number, initialState?: SpreadState) {
    this.state = initialState || {
      pairId: `${symbolA}-${symbolB}`,
      symbolA,
      symbolB,
      betaHedgeRatio: 1.0,
      spreadMean: 0.0,
      spreadStd: 1.0,
      cointegrationP: 1.0,
      lastZScore: 0.0,
      windowSize,
      updatedAt: new Date()
    };
  }
  
  update(priceA: number, priceB: number, timestamp: Date): SpreadState {
    const logA = Math.log(priceA);
    const logB = Math.log(priceB);
    
    this.logPricesA.push(logA);
    this.logPricesB.push(logB);
    
    if (this.logPricesA.length > this.state.windowSize) {
      this.logPricesA.shift();
      this.logPricesB.shift();
    }
    
    this.updateCount++;
    
    if (this.updateCount % 50 === 0 && this.logPricesA.length >= 50) {
      const coint = cointegrationTest(this.logPricesA, this.logPricesB);
      this.currentCointegration = coint;
      this.state.betaHedgeRatio = coint.betaHedgeRatio;
      this.state.spreadMean = coint.spreadMean;
      this.state.spreadStd = coint.spreadStd;
      this.state.cointegrationP = coint.pValue;
    }
    
    const spread = logA - this.state.betaHedgeRatio * logB;
    const zScore = this.state.spreadStd > 0 
      ? (spread - this.state.spreadMean) / this.state.spreadStd 
      : 0;
      
    this.state.lastZScore = zScore;
    this.state.updatedAt = timestamp;
    
    return this.state;
  }
  
  getCurrentZScore(): number | null {
    if (this.logPricesA.length < 50) return null;
    return this.state.lastZScore;
  }
  
  getCointegration(): CointegrationResult | null {
    if (this.logPricesA.length < 50) return null;
    if (this.currentCointegration) return this.currentCointegration;
    this.currentCointegration = cointegrationTest(this.logPricesA, this.logPricesB);
    return this.currentCointegration;
  }
  
  persist(): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO pair_spread_state (
        pair_id, symbol_a, symbol_b, beta_hedge_ratio, spread_mean, 
        spread_std, cointegration_p, last_z_score, window_size, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_id) DO UPDATE SET
        beta_hedge_ratio=excluded.beta_hedge_ratio,
        spread_mean=excluded.spread_mean,
        spread_std=excluded.spread_std,
        cointegration_p=excluded.cointegration_p,
        last_z_score=excluded.last_z_score,
        window_size=excluded.window_size,
        updated_at=excluded.updated_at
    `);
    
    stmt.run(
      this.state.pairId,
      this.state.symbolA,
      this.state.symbolB,
      this.state.betaHedgeRatio,
      this.state.spreadMean,
      this.state.spreadStd,
      this.state.cointegrationP,
      this.state.lastZScore,
      this.state.windowSize,
      this.state.updatedAt.toISOString()
    );
  }
  
  static load(symbolA: string, symbolB: string): SpreadTracker | null {
    const db = getDb();
    const pairId = `${symbolA}-${symbolB}`;
    const row = db.prepare('SELECT * FROM pair_spread_state WHERE pair_id = ?').get(pairId) as any;
    
    if (!row) return null;
    
    const state: SpreadState = {
      pairId: row.pair_id,
      symbolA: row.symbol_a,
      symbolB: row.symbol_b,
      betaHedgeRatio: row.beta_hedge_ratio,
      spreadMean: row.spread_mean,
      spreadStd: row.spread_std,
      cointegrationP: row.cointegration_p,
      lastZScore: row.last_z_score,
      windowSize: row.window_size,
      updatedAt: new Date(row.updated_at)
    };
    
    return new SpreadTracker(symbolA, symbolB, state.windowSize, state);
  }
  
  getLogPricesA(): readonly number[] {
    return this.logPricesA;
  }
  
  getLogPricesB(): readonly number[] {
    return this.logPricesB;
  }
}
