/**
 * VotingEngine
 *
 * Collects signals from ALL strategies running on a symbol, then
 * applies a democratic vote: a trade fires ONLY when a minimum fraction
 * of strategies agree on the same direction.
 *
 * Design principles (from research papers):
 *   - Ensemble methods reduce single-model overfit (Zhang et al. 2019)
 *   - Consensus confidence = precision-weighted average of agreeing signals
 *   - Abstain on ties — never trade on ambiguous signals
 *
 * Vote fractions:
 *   0.5 = majority (≥ half agree)
 *   0.6 = supermajority (≥ 60% agree) ← recommended default
 *   0.75 = strong consensus (≥ 3/4 agree)
 *   1.0 = unanimous (all agree)
 */

import type { Signal } from '../types/signal.js';
import type { TickFeatures } from '../types/tick.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrategyVote {
  strategy: string;
  direction: 'BUY' | 'SELL' | 'NONE';
  confidence: number;
}

export interface VoteResult {
  metadata: Record<string, unknown>;
  symbol: string;
  direction: 'BUY' | 'SELL' | 'NONE';
  /** Fraction of strategies that agreed (0.0 – 1.0) */
  voteFraction: number;
  /** Weighted average confidence of agreeing strategies */
  consensusConfidence: number;
  /** All individual votes */
  votes: StrategyVote[];
  /** How many voted BUY / SELL / NONE */
  tally: { buy: number; sell: number; none: number; total: number };
  /** True if a tradeable consensus was reached */
  hasConsensus: boolean;
  /** Human-readable summary */
  summary: string;
}

export interface VotingEngineConfig {
  /**
   * Minimum fraction of strategies that must agree to trigger a trade.
   * Range: 0.0 – 1.0.  Default: 0.6 (60%).
   */
  minVoteFraction: number;

  /**
   * Minimum consensus confidence to fire a trade.
   * Even if vote fraction is met, confidence must also pass this bar.
   * Default: 0.55.
   */
  minConsensusConfidence: number;

  /**
   * Weight individual votes by their confidence score (true)
   * or treat all votes equally (false).
   * Default: true (confidence-weighted voting).
   */
  weightByConfidence: boolean;
}

const DEFAULTS: VotingEngineConfig = {
  minVoteFraction: 0.6,
  minConsensusConfidence: 0.55,
  weightByConfidence: true,
};

// ---------------------------------------------------------------------------
// VotingEngine
// ---------------------------------------------------------------------------

export class VotingEngine {
  private readonly config: VotingEngineConfig;

  constructor(config: Partial<VotingEngineConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  /**
   * Aggregate signals from multiple strategies into a consensus vote.
   *
   * @param symbol   The market symbol being voted on
   * @param signals  Array of signals from different strategies
   * @returns        VoteResult with consensus direction and metadata
   */
  vote(symbol: string, signals: Signal[]): VoteResult {
    const votes: StrategyVote[] = signals.map((s) => ({
      strategy: s.strategy,
      direction: s.direction,
      confidence: s.confidence,
    }));

    const tally = { buy: 0, sell: 0, none: 0, total: votes.length };
    if (signals.some(signal => signal.product !== 'OPTIONS' || signal.symbol !== symbol)) {
      return this.noConsensus(symbol, votes, tally, 'Mismatched product or symbol');
    }

    for (const v of votes) {
      if (v.direction === 'BUY') tally.buy++;
      else if (v.direction === 'SELL') tally.sell++;
      else tally.none++;
    }

    if (tally.total === 0) {
      return this.noConsensus(symbol, votes, tally, 'No strategies running');
    }

    // Determine winning direction
    const buyFraction = tally.buy / tally.total;
    const sellFraction = tally.sell / tally.total;

    let winningDir: 'BUY' | 'SELL' | 'NONE' = 'NONE';
    let winningFraction = 0;

    if (buyFraction > sellFraction && buyFraction >= this.config.minVoteFraction) {
      winningDir = 'BUY';
      winningFraction = buyFraction;
    } else if (sellFraction > buyFraction && sellFraction >= this.config.minVoteFraction) {
      winningDir = 'SELL';
      winningFraction = sellFraction;
    } else {
      const reason = `Split: ${String(tally.buy)}↑ ${String(tally.sell)}↓ ${String(tally.none)}— (need ${String(Math.ceil(tally.total * this.config.minVoteFraction))} to agree)`;
      return this.noConsensus(symbol, votes, tally, reason);
    }

    // Compute consensus confidence from agreeing votes only
    const agreeing = votes.filter((v) => v.direction === winningDir);
    const agreeingSignals = signals.filter(s => s.direction === winningDir);
    const contracts = new Set(agreeingSignals.map(s => JSON.stringify([
      s.metadata.contractType ?? (s.direction === 'BUY' ? 'CALL' : 'PUT'),
      s.metadata.barrier ?? null,
    ])));
    if (contracts.size !== 1) {
      return this.noConsensus(symbol, votes, tally, 'Strategies disagree on contract type or barrier');
    }
    const metadata = agreeingSignals[0]?.metadata ?? {};
    const consensusConfidence = this.config.weightByConfidence
      ? this.weightedAvgConfidence(agreeing)
      : agreeing.reduce((s, v) => s + v.confidence, 0) / agreeing.length;

    if (consensusConfidence < this.config.minConsensusConfidence) {
      return this.noConsensus(
        symbol,
        votes,
        tally,
        `Low confidence: ${consensusConfidence.toFixed(3)} < ${String(this.config.minConsensusConfidence)}`,
      );
    }

    const summary =
      `${symbol} ${winningDir} | ` +
      `${String(agreeing.length)}/${String(tally.total)} agree (${(winningFraction * 100).toFixed(0)}%) | ` +
      `conf=${consensusConfidence.toFixed(3)}`;

    return {
      metadata: { ...metadata, voteFraction: winningFraction },
      symbol,
      direction: winningDir,
      voteFraction: winningFraction,
      consensusConfidence,
      votes,
      tally,
      hasConsensus: true,
      summary,
    };
  }

  toSignal(current: TickFeatures, signals: Signal[]): Signal {
    const vote = this.vote(current.symbol, signals);
    return {
      product: 'OPTIONS', hypothesisId: null, strategyVersion: '1',
      id: crypto.randomUUID(), timestamp: current.timestamp, symbol: current.symbol,
      price: current.price, direction: vote.direction, confidence: vote.consensusConfidence,
      strategy: 'Consensus', metadata: vote.metadata,
    };
  }

  updateConfig(update: Partial<VotingEngineConfig>): void {
    Object.assign(this.config, update);
  }

  getConfig(): Readonly<VotingEngineConfig> {
    return { ...this.config };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private weightedAvgConfidence(votes: StrategyVote[]): number {
    if (votes.length === 0) return 0;
    const totalWeight = votes.reduce((s, v) => s + v.confidence, 0);
    if (totalWeight === 0) return 0;
    return votes.reduce((s, v) => s + v.confidence * v.confidence, 0) / totalWeight;
  }

  private noConsensus(
    symbol: string,
    votes: StrategyVote[],
    tally: VoteResult['tally'],
    reason: string,
  ): VoteResult {
    return {
      metadata: {},
      symbol,
      direction: 'NONE',
      voteFraction: 0,
      consensusConfidence: 0,
      votes,
      tally,
      hasConsensus: false,
      summary: `${symbol} NO CONSENSUS — ${reason}`,
    };
  }
}
