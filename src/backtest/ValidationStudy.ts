import { BacktestEngine, type BacktestConfig } from './BacktestEngine.js';
import { WalkForwardRunner, type WalkForwardConfig, type WalkForwardResult } from './WalkForwardRunner.js';
import type { ExperimentRegistry } from '../research/experiments/ExperimentRegistry.js';
import { benjaminiHochbergYekutieli, deflatedSharpeRatio } from '../research/statistics/stats.js';
import { assertDefined } from '../utils/assertDefined.js';
import type { BacktestRun } from '../types/backtest.js';
import type { TickFeatures } from '../types/tick.js';

export interface StudyCandidate { id: string; family: string; config: BacktestConfig }
export interface StudyResult {
  candidates: { id: string; development: WalkForwardResult; adjustedPValue: number; eligible: boolean }[];
  selectedId: string | null;
  finalRun: BacktestRun | null;
  verdict: 'INSUFFICIENT_EVIDENCE' | 'NO_EDGE_FOUND' | 'HOLDOUT_SUPPORTED' | 'HOLDOUT_REJECTED';
  trials: number;
}

/** Predeclared sensitivity families; selection cannot see the reserved final 20%. */
export class ValidationStudy {
  constructor(private readonly registry: ExperimentRegistry, private readonly walkForward: WalkForwardConfig) {}

  async run(features: readonly TickFeatures[], candidates: readonly StudyCandidate[]): Promise<StudyResult> {
    const registration = this.registry.begin(
      features.map(row => ({ symbol: row.symbol, timestamp: row.timestamp.toISOString(), price: row.price })),
      { walkForward: this.walkForward, candidates: candidates.map(candidate => ({ id: candidate.id, family: candidate.family,
        declaration: new BacktestEngine(candidate.config).declaration() })),
        selection: { holdoutFraction: 0.2, minTrades: 100, maxDrawdownFraction: 0.3, correction: 'DSR then BY at 0.05', sensitivity: 'All declared family neighbors must pass',
          tieBreak: 'Development expectancy descending then candidate ID', requireCompleteRecordedSearch: true } }, 'VALIDATION_STUDY');
    try {
      const result = await this.evaluate(features, candidates);
      this.registry.finish(registration.attemptId, 'COMPLETED', {
        verdict: result.verdict, selectedId: result.selectedId, trials: result.trials,
        candidates: result.candidates.map(row => ({ id: row.id, adjustedPValue: row.adjustedPValue, eligible: row.eligible,
          foldExperiments: row.development.folds.map(fold => fold.run.experimentId ?? null) })),
        finalExperimentId: result.finalRun?.experimentId ?? null,
      });
      return result;
    } catch (error) {
      this.registry.finish(registration.attemptId, 'FAILED', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async evaluate(features: readonly TickFeatures[], candidates: readonly StudyCandidate[]): Promise<StudyResult> {
    if (features.length < 500 || candidates.length < 2 || new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) {
      throw new Error('Study needs at least 500 ticks and two distinct predeclared candidates');
    }
    let cut = Math.floor(features.length * 0.8);
    while (cut < features.length && assertDefined(features[cut]).timestamp.getTime() === assertDefined(features[cut - 1]).timestamp.getTime()) cut++;
    if (features.length - cut < 50) throw new Error('Insufficient distinct final holdout');
    const development = features.slice(0, cut);
    const holdout = features.slice(cut);
    const identities = candidates.map(candidate => this.registry.registerHypothesis(new BacktestEngine(candidate.config).declaration()));
    // Registry count is a conservative recorded-search count, not an estimate of independent trials.
    const trials = Math.max(candidates.length, this.registry.countHypotheses());
    const runner = new WalkForwardRunner(this.walkForward);
    const results: WalkForwardResult[] = [];
    for (const candidate of candidates) results.push(await runner.run(development, { ...candidate.config, registry: this.registry }, trials));
    const sharpes = results.map(result => result.aggregatedTestMetrics?.sharpeRatio ?? null);
    const complete = trials === candidates.length && sharpes.every(value => value !== null && Number.isFinite(value));
    const mean = complete ? sharpes.reduce<number>((sum, value) => sum + assertDefined(value), 0) / sharpes.length : 0;
    const variance = complete ? sharpes.reduce<number>((sum, value) => sum + (assertDefined(value) - mean) ** 2, 0) / (sharpes.length - 1) : null;
    const pValues = results.map(result => {
      const observations = result.folds.flatMap(fold => fold.run.observations.filter(row => row.timestamp >= fold.testFrom && row.timestamp <= fold.testTo));
      const dsr = variance === null || variance <= 0 ? null : deflatedSharpeRatio(observations.map(row => row.returnPct), trials, undefined, variance);
      return dsr === null ? 1 : 1 - dsr.dsr;
    });
    const adjusted = benjaminiHochbergYekutieli(pValues);
    const basic = results.map(result => {
      const metrics = result.aggregatedTestMetrics;
      return result.folds.length === this.walkForward.numFolds && result.folds.every(fold => fold.run.testMetrics.totalTrades >= this.walkForward.minTradesPerFold) &&
        metrics !== null && metrics.totalTrades >= 100 && metrics.expectancy > 0 &&
        metrics.confidenceInterval95 !== null && metrics.confidenceInterval95[0] > 0 && metrics.maxDrawdownPct >= -0.3;
    });
    const rows = candidates.map((candidate, index) => {
      const neighbors = candidates.map((other, i) => ({ other, i })).filter(({ other }) => other.family === candidate.family);
      const sensitive = neighbors.length >= 2 && neighbors.every(({ i }) => basic[i]);
      return { id: candidate.id, development: assertDefined(results[index]), adjustedPValue: assertDefined(adjusted[index]).corrected,
        eligible: sensitive && assertDefined(adjusted[index]).rejected && assertDefined(basic[index]) };
    });
    const selected = rows.filter(row => row.eligible).sort((a, b) =>
      (b.development.aggregatedTestMetrics?.expectancy ?? 0) - (a.development.aggregatedTestMetrics?.expectancy ?? 0) || a.id.localeCompare(b.id))[0];
    if (!selected) return { candidates: rows, selectedId: null, finalRun: null, trials, verdict: complete && variance !== null && variance > 0 ? 'NO_EDGE_FOUND' : 'INSUFFICIENT_EVIDENCE' };
    const index = candidates.findIndex(candidate => candidate.id === selected.id);
    this.registry.claimHoldout(holdout.map(row => ({ symbol: row.symbol, timestamp: row.timestamp.toISOString(), price: row.price })), assertDefined(identities[index]));
    const config = assertDefined(candidates[index]).config;
    let split = Math.floor(development.length * 0.75);
    while (split < development.length && assertDefined(development[split]).timestamp.getTime() === assertDefined(development[split - 1]).timestamp.getTime()) split++;
    if (split >= development.length) throw new Error('Cannot separate training and validation timestamps');
    const finalRun = await new BacktestEngine({ ...config, registry: this.registry, numTrials: trials }).run(features,
      assertDefined(development[0]).timestamp, assertDefined(development[split - 1]).timestamp,
      assertDefined(development[split]).timestamp, assertDefined(development.at(-1)).timestamp,
      assertDefined(holdout[0]).timestamp, assertDefined(holdout.at(-1)).timestamp);
    const metrics = finalRun.testMetrics;
    const supported = metrics.totalTrades >= 100 && metrics.expectancy > 0 && metrics.confidenceInterval95 !== null && metrics.confidenceInterval95[0] > 0;
    return { candidates: rows, selectedId: selected.id, finalRun, trials, verdict: supported ? 'HOLDOUT_SUPPORTED' : 'HOLDOUT_REJECTED' };
  }
}
