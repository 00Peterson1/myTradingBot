import { z } from 'zod';
import { inspectCfdData } from './CfdDataQuality.js';
import type { ExperimentRegistry } from '../research/experiments/ExperimentRegistry.js';
import { blockBootstrapMean, DEFAULT_BOOTSTRAP_POLICY } from '../research/statistics/bootstrap.js';
import { benjaminiHochbergYekutieli, deflatedSharpeRatio, probabilityOfBacktestOverfitting } from '../research/statistics/stats.js';
import { mean, stddev } from '../features/indicators/indicators.js';
import { backtestCfd, cfdBacktestConfigSchema, type CfdBacktestConfig, type CfdBacktestResult } from './CfdBacktest.js';
import { cfdDatasetIdentity, type CfdDataset } from './CfdDataset.js';

export const cfdValidationPolicySchema = z.object({ minDays: z.number().min(90), minTradesPerPeriod: z.number().int().min(30), maxDrawdown: z.number().positive().max(0.3), costStressMultiplier: z.number().min(1.5).max(10), bootstrapBlockLengths: z.array(z.number().int().min(2).max(100)).min(2).max(10).default([3, 5, 10]) }).strict();
export const defaultCfdValidationPolicy = { minDays: 180, minTradesPerPeriod: 30, maxDrawdown: 0.2, costStressMultiplier: 2, bootstrapBlockLengths: [3, 5, 10] };
interface PeriodResult { label: string; result: CfdBacktestResult; confidenceInterval: [number, number] | null; bootstrapSensitivity: { blockLength: number; interval: [number, number] | null }[]; passed: boolean }

/** Predeclared lookback sensitivity study. Research evidence never directly enables trading. */
export async function validateCfd(datasetInput: CfdDataset, configInput: CfdBacktestConfig, registry: ExperimentRegistry, policyInput: z.input<typeof cfdValidationPolicySchema> = defaultCfdValidationPolicy): Promise<Record<string, unknown>> {
  const { dataset, days } = cfdDatasetIdentity(datasetInput), config = cfdBacktestConfigSchema.parse(configInput), policy = cfdValidationPolicySchema.parse(policyInput);
  const lookbacks = [...new Set([Math.max(3, config.lookback - 5), config.lookback, Math.min(10000, config.lookback + 5)])];
  const candidates = lookbacks.map(lookback => ({ ...config, lookback }));
  const identities = candidates.map(candidate => registry.registerHypothesis({ product: 'CFD', symbol: dataset.instrument.symbol, config: candidate, policy }));
  const trials = registry.countProductHypotheses('CFD', dataset.instrument.symbol);
  const attempt = registry.begin(dataset, { product: 'CFD', symbol: dataset.instrument.symbol, candidates, policy, trials,
    selection: 'All lookback neighbors pass; DSR + BY <= 0.05; aligned CSCV PBO <= 0.5; cost stress; sealed final 20%' }, 'VALIDATION_STUDY');
  const evaluate = async (label: string, start: number, end: number, candidate: CfdBacktestConfig, stress = false): Promise<PeriodResult> => {
    const subset = { ...dataset, quotes: dataset.quotes.slice(start, end).map(row => stress ? { ...row,
      ask: (row.ask + row.bid) / 2 + (row.ask - row.bid) * policy.costStressMultiplier / 2,
      bid: (row.ask + row.bid) / 2 - (row.ask - row.bid) * policy.costStressMultiplier / 2,
      longFinancingPerLot: row.longFinancingPerLot < 0 ? row.longFinancingPerLot * policy.costStressMultiplier : row.longFinancingPerLot / policy.costStressMultiplier,
      shortFinancingPerLot: row.shortFinancingPerLot < 0 ? row.shortFinancingPerLot * policy.costStressMultiplier : row.shortFinancingPerLot / policy.costStressMultiplier,
    } : row) };
    const changed = stress ? { ...candidate, commissionPerLotPerSide: candidate.commissionPerLotPerSide * policy.costStressMultiplier,
      slippageTicks: Math.ceil(Math.max(1, candidate.slippageTicks) * policy.costStressMultiplier),
      risk: { ...candidate.risk, commissionPerLotRoundTrip: candidate.risk.commissionPerLotRoundTrip * policy.costStressMultiplier } } : candidate;
    const result = await backtestCfd(subset, changed);
    const bootstrapSensitivity = policy.bootstrapBlockLengths.map(blockLength => ({ blockLength, interval: blockBootstrapMean([result.tradeNet], { ...DEFAULT_BOOTSTRAP_POLICY, blockLength, minObservations: policy.minTradesPerPeriod }) }));
    const confidenceInterval: [number, number] | null = bootstrapSensitivity.every(row => row.interval !== null)
      ? [Math.min(...bootstrapSensitivity.map(row => row.interval?.[0] ?? -Infinity)), Math.max(...bootstrapSensitivity.map(row => row.interval?.[1] ?? Infinity))] : null;
    return { label, result, confidenceInterval, bootstrapSensitivity, passed: result.trades >= policy.minTradesPerPeriod && result.netProfit > 0 && result.maxDrawdown <= policy.maxDrawdown && confidenceInterval !== null && confidenceInterval[0] > 0 };
  };
  try {
    const quality = inspectCfdData(dataset, config.maxGapMs);
    const blockers: string[] = [];
    if (dataset.kind === 'FIXTURE') blockers.push('FIXTURE_IS_NOT_MARKET_EVIDENCE');
    if (dataset.kind === 'SCENARIO_BID_ASK') blockers.push('ASSUMED_COSTS_REQUIRE_VERIFICATION');
    if (days < policy.minDays) blockers.push('INSUFFICIENT_HISTORY_SPAN');
    if (quality.activeUtcDays < Math.ceil(policy.minDays * 0.35)) blockers.push('INSUFFICIENT_OBSERVED_DAYS');
    if (dataset.quotes.length < 5 * (Math.max(...lookbacks) + policy.minTradesPerPeriod)) blockers.push('INSUFFICIENT_QUOTE_COUNT');
    if (quality.longestContinuousQuotes <= Math.max(...lookbacks)) blockers.push('INSUFFICIENT_CONTINUOUS_QUOTES');
    if (config.risk.commissionPerLotRoundTrip < 2 * config.commissionPerLotPerSide) blockers.push('RISK_UNDERSTATES_COMMISSION');
    if (trials !== candidates.length) blockers.push('RECORDED_SEARCH_NOT_FULLY_REPRESENTED');
    let verdict = 'INSUFFICIENT_EVIDENCE';
    const development: { hypothesisId: string; config: CfdBacktestConfig; periods: PeriodResult[] }[] = [];
    let final: PeriodResult | null = null, stress: PeriodResult | null = null, selectedId: string | null = null;
    let adjustedPValues: number[] = [], pbo: number | null = null;
    if (blockers.length === 0) {
      const n = dataset.quotes.length, cuts = [0, Math.floor(n * 0.3), Math.floor(n * 0.55), Math.floor(n * 0.8), n];
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const candidate = candidates[candidateIndex], hypothesisId = identities[candidateIndex];
        if (!candidate || !hypothesisId) throw new Error('Missing candidate declaration');
        const periods: PeriodResult[] = [];
        for (let i = 0; i < 3; i++) {
          const start = cuts[i], end = cuts[i + 1];
          if (start === undefined || end === undefined) throw new Error('Missing validation boundary');
          periods.push(await evaluate(`WALK_FORWARD_${String(i + 1)}`, start, end, candidate));
        }
        development.push({ hypothesisId, config: candidate, periods });
      }
      // All candidates have identical quote timestamps and cold-start period boundaries.
      const paths = development.map(candidate => candidate.periods.flatMap(period => period.result.equity.map((row, i, rows) => {
        const previous = i ? rows[i - 1]?.equity : candidate.config.initialBalance;
        return previous !== undefined && previous > 0 ? (row.equity - previous) / previous : NaN;
      })));
      const sharpes = paths.map(path => stddev(path) > 0 ? mean(path) / stddev(path) : NaN);
      const completeSearch = trials === candidates.length && candidates.length >= 2 && sharpes.every(Number.isFinite);
      const variance = completeSearch ? stddev(sharpes) ** 2 : null;
      const pValues = paths.map(path => variance !== null && variance > 0 ? 1 - (deflatedSharpeRatio(path, trials, undefined, variance)?.dsr ?? 0) : 1);
      adjustedPValues = benjaminiHochbergYekutieli(pValues).map(value => value.corrected);
      const alignedLength = Math.floor((paths[0]?.length ?? 0) / 4) * 4;
      if (completeSearch && alignedLength >= 8) pbo = probabilityOfBacktestOverfitting(paths.map(path => path.slice(0, alignedLength)), 4)?.pbo ?? null;
      const neighborsPass = development.every(candidate => candidate.periods.every(period => period.passed));
      const selected = development.map((candidate, i) => ({ candidate, p: adjustedPValues[i] ?? 1 }))
        .filter(row => completeSearch && neighborsPass && row.p <= 0.05 && pbo !== null && pbo <= 0.5)
        .sort((a, b) => b.candidate.periods.reduce((sum, period) => sum + period.result.netProfit, 0) - a.candidate.periods.reduce((sum, period) => sum + period.result.netProfit, 0) || a.candidate.hypothesisId.localeCompare(b.candidate.hypothesisId))[0];
      if (selected) {
        const start = cuts[3] ?? 0;
        stress = await evaluate('DEVELOPMENT_COST_STRESS', 0, start, selected.candidate.config, true);
        if (stress.passed) {
          selectedId = selected.candidate.hypothesisId;
          registry.claimHoldout(dataset.quotes.slice(start).map(row => ({ symbol: dataset.instrument.symbol, timestamp: new Date(row.timeMs).toISOString(), price: (row.bid + row.ask) / 2 })), selectedId);
          final = await evaluate('SEALED_FINAL_HOLDOUT', start, n, selected.candidate.config);
          verdict = final.passed ? 'HOLDOUT_SUPPORTED_PENDING_BROKER_VERIFICATION' : 'REJECTED';
        } else verdict = 'REJECTED';
      } else if (completeSearch && pbo !== null && development.every(candidate => candidate.periods.every(period => period.result.trades >= policy.minTradesPerPeriod))) verdict = 'NO_EDGE_FOUND';
    }
    const outcome = { ...attempt, symbol: dataset.instrument.symbol, verdict, blockers, days, quality, development, stress, final, selectedId, adjustedPValues, pbo, recordedHypotheses: trials, recordedAllSymbolHypotheses: registry.countProductHypotheses('CFD'), inferenceScope: 'PER_SYMBOL_ONLY_NO_CROSS_SYMBOL_SELECTION',
      demoEligible: false, liveEligible: false, limitations: ['Recorded CFD search for this symbol (including declarations without a symbol) must be completely represented; unrecorded searches are not observable', 'Bootstrap requires support across predeclared block lengths; DSR/CSCV assumptions are not proof of independence. PBO uses aligned prefix divisible by four', 'Source and cost metadata are declarations; independent broker verification remains required', 'No statistical result guarantees profitability'] };
    registry.finish(attempt.attemptId, 'COMPLETED', outcome);
    return outcome;
  } catch (error) { registry.finish(attempt.attemptId, 'FAILED', { error: error instanceof Error ? error.message : 'CFD validation failed' }); throw error; }
}
