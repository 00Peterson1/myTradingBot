import { Strategy, makeSignal } from '../base/Strategy.js';
import type { TickFeatures } from '../../types/tick.js';
import type { Signal } from '../../types/signal.js';
import { getDb } from '../../data/database/sqlite.js';

export interface TDQNConfig {
  symbol: string;
  epsilon?: number;
  learningRate?: number;
  discount?: number;
  epsilonDecay?: number;
  minEpsilon?: number;
}

export class TDQNStrategy implements Strategy {
  readonly name: string;
  readonly description: string;
  private epsilon: number;
  private readonly learningRate: number;
  private readonly discount: number;
  private readonly epsilonDecay: number;
  private readonly minEpsilon: number;
  private readonly symbol: string;

  private qTable = new Map<string, Map<string, number>>();
  private updateCount = 0;
  private previousState: string | null = null;
  private previousAction: 'BUY' | 'SELL' | 'HOLD' | null = null;

  constructor(config: TDQNConfig) {
    this.symbol = config.symbol;
    this.epsilon = config.epsilon ?? 0.1;
    this.learningRate = config.learningRate ?? 0.01;
    this.discount = config.discount ?? 0.95;
    this.epsilonDecay = config.epsilonDecay ?? 0.9999;
    this.minEpsilon = config.minEpsilon ?? 0.01;

    this.name = `TDQN(${this.symbol})`;
    this.description = 'Tabular Q-learning strategy (arXiv:2004.06627 TDQN)';

    this.loadQTable();
  }

  private loadQTable() {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT state_key, action, q_value FROM rl_q_tables WHERE strategy_name = ? AND symbol = ?').all(this.name, this.symbol) as any[];
      for (const row of rows) {
        if (!this.qTable.has(row.state_key)) {
          this.qTable.set(row.state_key, new Map());
        }
        this.qTable.get(row.state_key)!.set(row.action, row.q_value);
      }
    } catch (e) {
      // ignore
    }
  }

  private saveQTable() {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO rl_q_tables (strategy_name, symbol, state_key, action, q_value, update_count, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(strategy_name, symbol, state_key, action) DO UPDATE SET
        q_value = excluded.q_value,
        update_count = update_count + 1,
        updated_at = datetime('now')
    `);
    
    db.transaction(() => {
      for (const [stateKey, actions] of this.qTable.entries()) {
        for (const [action, qValue] of actions.entries()) {
          stmt.run(this.name, this.symbol, stateKey, action, qValue);
        }
      }
    })();
  }

  private getQ(state: string, action: string): number {
    return this.qTable.get(state)?.get(action) ?? 0;
  }

  private setQ(state: string, action: string, value: number) {
    if (!this.qTable.has(state)) {
      this.qTable.set(state, new Map());
    }
    this.qTable.get(state)!.set(action, value);
  }

  private discretizeState(current: TickFeatures): string | null {
    const mom = current.mom20;
    const std = current.rollingStd20;
    const z = current.zScore20;

    if (mom === null || std === null || z === null) return null;

    let momBin = 0;
    if (mom >= 0.002) momBin = 4;
    else if (mom >= 0.0005) momBin = 3;
    else if (mom >= -0.0005) momBin = 2;
    else if (mom >= -0.002) momBin = 1;
    else momBin = 0;

    let stdBin = 0;
    if (std > 0.005) stdBin = 4;
    else if (std > 0.002) stdBin = 3;
    else if (std > 0.001) stdBin = 2;
    else if (std > 0.0005) stdBin = 1;
    else stdBin = 0;

    let zBin = 0;
    if (z >= 2) zBin = 4;
    else if (z >= 0.5) zBin = 3;
    else if (z >= -0.5) zBin = 2;
    else if (z >= -2) zBin = 1;
    else zBin = 0;

    return `${momBin}_${stdBin}_${zBin}`;
  }

  generateSignal(current: TickFeatures, _history: readonly TickFeatures[]): Signal {
    const state = this.discretizeState(current);
    if (!state) {
      return makeSignal(this.name, current, 'NONE', 0, { reason: 'null_features' });
    }

    if (this.previousState && this.previousAction && current.logReturn1 !== null) {
      const reward = current.logReturn1 / Math.max(current.rollingStd20 ?? 1e-6, 1e-6);
      
      const maxNextQ = Math.max(
        this.getQ(state, 'BUY'),
        this.getQ(state, 'SELL'),
        this.getQ(state, 'HOLD')
      );

      const oldQ = this.getQ(this.previousState, this.previousAction);
      const newQ = oldQ + this.learningRate * (reward + this.discount * maxNextQ - oldQ);
      this.setQ(this.previousState, this.previousAction, newQ);

      this.updateCount++;
      if (this.updateCount >= 100) {
        this.saveQTable();
        this.updateCount = 0;
      }
    }

    const actions = ['BUY', 'SELL', 'HOLD'] as const;
    let chosenAction: 'BUY' | 'SELL' | 'HOLD';

    if (Math.random() < this.epsilon) {
      chosenAction = actions[Math.floor(Math.random() * actions.length)] as 'BUY' | 'SELL' | 'HOLD';
    } else {
      let maxQ = -Infinity;
      let bestActions: ('BUY' | 'SELL' | 'HOLD')[] = [];
      for (const a of actions) {
        const q = this.getQ(state, a);
        if (q > maxQ) {
          maxQ = q;
          bestActions = [a];
        } else if (q === maxQ) {
          bestActions.push(a);
        }
      }
      chosenAction = bestActions[Math.floor(Math.random() * bestActions.length)] as 'BUY' | 'SELL' | 'HOLD';
    }

    this.epsilon = Math.max(this.minEpsilon, this.epsilon * this.epsilonDecay);

    this.previousState = state;
    this.previousAction = chosenAction;

    const qVals = actions.map(a => this.getQ(state, a));
    const qMin = Math.min(...qVals);
    const qMax = Math.max(...qVals);
    const chosenQ = this.getQ(state, chosenAction);
    const confidence = (chosenQ - qMin) / (qMax - qMin + 1e-10);

    const direction = chosenAction === 'HOLD' ? 'NONE' : chosenAction;
    return makeSignal(this.name, current, direction, confidence || 0, {
      state, action: chosenAction, qValue: chosenQ
    });
  }
}
