import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { cfdDatasetIdentity } from './CfdDataset.js';
import { inspectCfdData } from './CfdDataQuality.js';
import { cfdBacktestConfigSchema } from './CfdBacktest.js';
import { validateCfd, defaultCfdValidationPolicy } from './CfdValidation.js';
import { contentHash, type ExperimentRegistry } from '../research/experiments/ExperimentRegistry.js';

const symbolSchema = z.object({ symbol: z.string().min(1), category: z.enum(['forex', 'metals', 'commodities', 'crypto', 'stock_indices', 'stocks']),
  dataset: z.string().min(1).nullable(), config: z.string().min(1).nullable(),
}).strict();
export const cfdResearchPlanSchema = z.object({ version: z.literal(1), universeSource: z.string().min(1), symbols: z.array(symbolSchema).min(1) }).strict()
  .refine(plan => new Set(plan.symbols.map(row => row.symbol)).size === plan.symbols.length, 'Duplicate symbol in CFD research plan');
export type CfdResearchPlan = z.infer<typeof cfdResearchPlanSchema>;
export interface CfdResearchRow {
  symbol: string; category: string; status: string; reasons: string[];
  quality: ReturnType<typeof inspectCfdData> | null; validation: Record<string, unknown> | null;
}

/** Exhaustive within the declared universe. Missing inputs are visible blockers, never dropped symbols. */
export async function researchCfdBatch(planInput: unknown, baseDirectory: string, registry: ExperimentRegistry, evaluate: boolean): Promise<{
  planId: string; universeSource: string; mode: 'AUDIT' | 'VALIDATE'; symbols: CfdResearchRow[];
  complete: boolean; demoEligible: false; liveEligible: false; blockers: string[];
}> {
  const plan = cfdResearchPlanSchema.parse(planInput);
  const rows: CfdResearchRow[] = [];
  // Freeze every valid candidate before any evaluation so file order cannot hide later trials.
  const prepared: { row: CfdResearchRow; dataset: ReturnType<typeof cfdDatasetIdentity>['dataset']; config: z.infer<typeof cfdBacktestConfigSchema> }[] = [];
  for (const entry of plan.symbols) {
    const row: CfdResearchRow = { symbol: entry.symbol, category: entry.category, status: 'BLOCKED', reasons: [], quality: null, validation: null };
    rows.push(row);
    if (!entry.dataset) row.reasons.push('MISSING_BID_ASK_HISTORY');
    if (!entry.config) row.reasons.push('MISSING_SYMBOL_RESEARCH_CONFIG');
    if (!entry.dataset || !entry.config) continue;
    try {
      const { dataset } = cfdDatasetIdentity(JSON.parse(readFileSync(resolve(baseDirectory, entry.dataset), 'utf8')) as unknown);
      const config = cfdBacktestConfigSchema.parse(JSON.parse(readFileSync(resolve(baseDirectory, entry.config), 'utf8')) as unknown);
      if (dataset.instrument.symbol !== entry.symbol || dataset.instrument.category !== entry.category) throw new Error('Dataset symbol/category differs from declared universe');
      row.quality = inspectCfdData(dataset, config.maxGapMs);
      if (dataset.kind === 'FIXTURE') row.reasons.push('FIXTURE_IS_NOT_MARKET_EVIDENCE');
      if (row.quality.days < defaultCfdValidationPolicy.minDays) row.reasons.push('INSUFFICIENT_HISTORY_SPAN');
      if (row.quality.activeUtcDays < Math.ceil(defaultCfdValidationPolicy.minDays * 0.35)) row.reasons.push('INSUFFICIENT_OBSERVED_DAYS');
      if (row.quality.longestContinuousQuotes <= config.lookback + 5) row.reasons.push('INSUFFICIENT_CONTINUOUS_QUOTES');
      if (config.risk.commissionPerLotRoundTrip < 2 * config.commissionPerLotPerSide) row.reasons.push('RISK_UNDERSTATES_COMMISSION');
      if (evaluate) for (const lookback of new Set([Math.max(3, config.lookback - 5), config.lookback, Math.min(10000, config.lookback + 5)])) {
        registry.registerHypothesis({ product: 'CFD', symbol: entry.symbol, config: { ...config, lookback }, policy: defaultCfdValidationPolicy });
      }
      prepared.push({ row, dataset, config });
      if (!row.reasons.length) row.status = 'READY_FOR_RESEARCH';
    } catch (error) { row.status = 'INVALID_INPUT'; row.reasons.push(error instanceof Error ? error.message : 'Invalid CFD input'); }
  }
  for (const { row, dataset, config } of prepared) if (evaluate && row.reasons.length === 0) {
    try {
      row.validation = await validateCfd(dataset, config, registry);
      row.status = String(row.validation.verdict);
    } catch (error) { row.status = 'VALIDATION_FAILED'; row.reasons.push(error instanceof Error ? error.message : 'Validation failed'); }
  }
  return { planId: contentHash(plan), universeSource: plan.universeSource, mode: evaluate ? 'VALIDATE' : 'AUDIT', symbols: rows,
    complete: rows.every(row => row.validation !== null), demoEligible: false, liveEligible: false,
    blockers: ['CTRADER_ADAPTER_AND_BROKER_DEMO_VERIFICATION_PENDING', 'SOURCE_COST_AND_CONTRACT_VERIFICATION_REQUIRED', 'RESEARCH_REPORTS_DO_NOT_AUTHORIZE_TRADING'] };
}
