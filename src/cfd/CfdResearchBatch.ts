import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { cTraderCatalogueSchema, cTraderIdSchema, cfdCatalogueCategorySchema, catalogueResearchEntries, catalogueIdentity } from './ctrader/Catalogue.js';
import { cfdDatasetIdentity } from './CfdDataset.js';
import { inspectCfdData } from './CfdDataQuality.js';
import { cfdBacktestConfigSchema } from './CfdBacktest.js';
import { validateCfd, defaultCfdValidationPolicy } from './CfdValidation.js';
import { benjaminiHochbergYekutieli } from '../research/statistics/stats.js';
import { contentHash, type ExperimentRegistry } from '../research/experiments/ExperimentRegistry.js';

const symbolSchema = z.object({ symbol: z.string().min(1), brokerSymbolId: cTraderIdSchema, category: cfdCatalogueCategorySchema,
  catalogueStatus: z.enum(['ACTIVE', 'DISABLED', 'ARCHIVED', 'REVIEW_REQUIRED']),
  dataset: z.string().min(1).nullable(), config: z.string().min(1).nullable(),
}).strict();
export const cfdResearchPlanSchema = z.object({ version: z.literal(2), universeSource: z.literal('CTRADER_ACCOUNT_CATALOGUE'),
  catalogue: cTraderCatalogueSchema.nullable(), symbols: z.array(symbolSchema),
}).strict().superRefine((plan, ctx) => {
  if (!plan.catalogue) {
    if (plan.symbols.length) ctx.addIssue({ code: 'custom', message: 'CFD symbols require a cTrader account catalogue; Options-derived lists are not accepted' });
    return;
  }
  const expected = catalogueResearchEntries(plan.catalogue);
  if (new Set(plan.symbols.map(row => row.brokerSymbolId)).size !== plan.symbols.length) ctx.addIssue({ code: 'custom', message: 'Duplicate CFD broker symbol ID' });
  if (expected.length !== plan.symbols.length) ctx.addIssue({ code: 'custom', message: 'Plan must represent every cTrader catalogue entry' });
  for (const row of expected) {
    const entry = plan.symbols.find(item => item.brokerSymbolId === row.brokerSymbolId);
    if (entry?.symbol !== row.symbol || entry.category !== row.category || entry.catalogueStatus !== row.catalogueStatus) ctx.addIssue({ code: 'custom', message: 'Plan differs from cTrader catalogue identity or classification' });
  }
});
export type CfdResearchPlan = z.infer<typeof cfdResearchPlanSchema>;
export interface CfdResearchRow {
  symbol: string; brokerSymbolId: string; category: string; status: string; reasons: string[];
  quality: ReturnType<typeof inspectCfdData> | null; validation: Record<string, unknown> | null; batchAdjustedPValue: number; researchSupported: boolean;
}

/** Exhaustive within the declared universe. Missing inputs are visible blockers, never dropped symbols. */
export async function researchCfdBatch(planInput: unknown, baseDirectory: string, registry: ExperimentRegistry, evaluate: boolean): Promise<{
  planId: string; universeSource: string; catalogueId: string | null; accountId: string | null; mode: 'AUDIT' | 'VALIDATE'; symbols: CfdResearchRow[];
  complete: boolean; demoEligible: false; liveEligible: false; blockers: string[];
}> {
  const plan = cfdResearchPlanSchema.parse(planInput);
  const rows: CfdResearchRow[] = [];
  // Freeze every valid candidate before any evaluation so file order cannot hide later trials.
  const prepared: { row: CfdResearchRow; dataset: ReturnType<typeof cfdDatasetIdentity>['dataset']; config: z.infer<typeof cfdBacktestConfigSchema> }[] = [];
  for (const entry of plan.symbols) {
    const row: CfdResearchRow = { symbol: entry.symbol, brokerSymbolId: entry.brokerSymbolId, category: entry.category, status: 'BLOCKED', reasons: [], quality: null, validation: null, batchAdjustedPValue: 1, researchSupported: false };
    rows.push(row);
    if (entry.category === 'synthetic') row.reasons.push('SYNTHETIC_RESEARCH_PAUSED');
    if (entry.category === 'unknown') row.reasons.push('CFD_CATEGORY_REVIEW_REQUIRED');
    if (entry.catalogueStatus !== 'ACTIVE') row.reasons.push(`CATALOGUE_${entry.catalogueStatus}`);
    if (row.reasons.length) continue;
    if (!entry.dataset) row.reasons.push('MISSING_BID_ASK_HISTORY');
    if (!entry.config) row.reasons.push('MISSING_SYMBOL_RESEARCH_CONFIG');
    if (!entry.dataset || !entry.config) continue;
    try {
      const { dataset } = cfdDatasetIdentity(JSON.parse(readFileSync(resolve(baseDirectory, entry.dataset), 'utf8')) as unknown);
      const config = cfdBacktestConfigSchema.parse(JSON.parse(readFileSync(resolve(baseDirectory, entry.config), 'utf8')) as unknown);
      if (dataset.instrument.symbol !== entry.symbol || dataset.instrument.category !== entry.category) throw new Error('Dataset symbol/category differs from declared universe');
      row.quality = inspectCfdData(dataset, config.maxGapMs);
      if (dataset.kind === 'FIXTURE') row.reasons.push('FIXTURE_IS_NOT_MARKET_EVIDENCE');
      if (dataset.kind === 'SCENARIO_BID_ASK') row.reasons.push('ASSUMED_COSTS_REQUIRE_VERIFICATION');
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
  // Conservatively adjust across the full declared symbol universe, including missing/failed studies as p=1.
  const corrected = benjaminiHochbergYekutieli(rows.map(row => {
    const pValues = row.validation?.adjustedPValues;
    return Array.isArray(pValues) && pValues.length && pValues.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
      ? Math.min(...pValues as number[]) : 1;
  }));
  rows.forEach((row, index) => {
    row.batchAdjustedPValue = corrected[index]?.corrected ?? 1;
    row.researchSupported = row.status === 'HOLDOUT_SUPPORTED_PENDING_BROKER_VERIFICATION' && row.batchAdjustedPValue <= 0.05;
  });
  return { planId: contentHash(plan), universeSource: plan.universeSource, catalogueId: plan.catalogue ? catalogueIdentity(plan.catalogue) : null, accountId: plan.catalogue?.accountId ?? null, mode: evaluate ? 'VALIDATE' : 'AUDIT', symbols: rows,
    complete: rows.length > 0 && rows.every(row => row.validation !== null), demoEligible: false, liveEligible: false,
    blockers: [...(!plan.catalogue ? ['CTRADER_CATALOGUE_PENDING'] : []), 'CTRADER_ADAPTER_AND_BROKER_DEMO_VERIFICATION_PENDING', 'SOURCE_COST_AND_CONTRACT_VERIFICATION_REQUIRED', 'RESEARCH_REPORTS_DO_NOT_AUTHORIZE_TRADING'] };
}
