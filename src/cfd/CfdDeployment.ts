import type Database from 'better-sqlite3';
import { z } from 'zod';
import { contentHash, readExperimentBundle } from '../research/experiments/ExperimentRegistry.js';
import { cfdBacktestConfigSchema, type CfdBacktestConfig } from './CfdBacktest.js';
import { cfdDatasetIdentity, type CfdDataset } from './CfdDataset.js';

export const cfdDeploymentSchema = z.object({ version: z.literal(1), mode: z.literal('DEMO'), accountId: z.string().regex(/^[1-9]\d*$/),
  symbol: z.string().min(1), hypothesisId: z.string().length(64), studyId: z.string().length(64), studyAttemptId: z.string().uuid(),
  batchId: z.string().length(64), batchAttemptId: z.string().uuid(), reviewId: z.string().length(64), reviewAttemptId: z.string().uuid(),
  expiresAt: z.string().datetime(), pollIntervalMs: z.number().int().min(1000).max(60000), maxLots: z.number().finite().positive(), maxPlannedLoss: z.number().finite().positive().max(5),
}).strict();
export type CfdDeployment = z.infer<typeof cfdDeploymentSchema>;
export interface ApprovedCfdStrategy { deployment: CfdDeployment; config: CfdBacktestConfig; dataset: CfdDataset }
const record = (value: unknown): Record<string, unknown> => z.record(z.unknown()).parse(value);

/** Deployment files reference immutable studies; editing booleans/configuration cannot manufacture eligibility. */
export function loadCfdDeployment(db: Database.Database, input: unknown, accountId: string, codeId: string, now = Date.now()): ApprovedCfdStrategy {
  ensureCfdRunnerSchema(db);
  const deployment = cfdDeploymentSchema.parse(input);
  if (deployment.accountId !== accountId || Date.parse(deployment.expiresAt) <= now) throw new Error('CFD deployment account mismatch or expired approval');
  function evidence(id: string, attemptId: string): { bundle: Record<string, unknown>; manifest: Record<string, unknown>; outcome: Record<string, unknown> } {
    const bundle = readExperimentBundle(db, id), manifest = record(bundle.manifest);
    if (manifest.kind !== 'VALIDATION_STUDY') throw new Error('CFD deployment requires validation-study evidence');
    const attempt = z.array(z.object({ id: z.string(), status: z.string(), outcome: z.unknown() })).parse(bundle.attempts).find(row => row.id === attemptId);
    if (attempt?.status !== 'COMPLETED') throw new Error('Missing completed CFD evidence attempt');
    return { bundle, manifest, outcome: record(attempt.outcome) };
  }
  const study = evidence(deployment.studyId, deployment.studyAttemptId);
  if (study.manifest.codeId !== codeId) throw new Error('CFD validated code differs from the running source/dependencies');
  if (study.outcome.verdict !== 'HOLDOUT_SUPPORTED_PENDING_BROKER_VERIFICATION' || study.outcome.selectedId !== deployment.hypothesisId || study.outcome.symbol !== deployment.symbol) throw new Error('No supported CFD holdout for the deployed hypothesis');
  const { dataset, id: datasetId } = cfdDatasetIdentity(study.bundle.dataset);
  if (!['BROKER_BID_ASK', 'EXTERNAL_BID_ASK'].includes(dataset.kind) || dataset.instrument.symbol !== deployment.symbol) throw new Error('CFD strategy needs observed matching bid/ask data');
  const row = db.prepare('SELECT content FROM research_hypotheses WHERE id=?').get(deployment.hypothesisId) as { content: string } | undefined;
  if (!row) throw new Error('Missing registered CFD hypothesis');
  const declaration = record(JSON.parse(row.content) as unknown);
  if (contentHash(declaration) !== deployment.hypothesisId || declaration.product !== 'CFD' || declaration.symbol !== deployment.symbol) throw new Error('CFD hypothesis identity mismatch');
  const config = cfdBacktestConfigSchema.parse(declaration.config);
  const development = z.array(z.object({ hypothesisId: z.string(), config: cfdBacktestConfigSchema, periods: z.array(z.object({ passed: z.boolean() })).min(3) })).parse(study.outcome.development);
  const selected = development.find(candidate => candidate.hypothesisId === deployment.hypothesisId);
  if (!selected || contentHash(selected.config) !== contentHash(config) || !development.every(candidate => candidate.periods.every(period => period.passed)) || record(study.outcome.final).passed !== true || record(study.outcome.stress).passed !== true) throw new Error('Incomplete CFD development/holdout/cost-stress evidence');
  const batch = evidence(deployment.batchId, deployment.batchAttemptId);
  if (batch.manifest.codeId !== codeId || record(batch.manifest.configuration).purpose !== 'CFD_BATCH_VALIDATION' || batch.outcome.accountId !== accountId || batch.outcome.mode !== 'VALIDATE') throw new Error('Invalid CFD batch evidence');
  const batchRow = z.array(z.object({ symbol: z.string(), researchSupported: z.boolean(), batchAdjustedPValue: z.number().min(0).max(1), validation: z.unknown() })).parse(batch.outcome.symbols).find(item => item.symbol === deployment.symbol);
  if (!batchRow?.researchSupported || batchRow.batchAdjustedPValue > 0.05 || record(batchRow.validation).attemptId !== deployment.studyAttemptId || record(batchRow.validation).experimentId !== deployment.studyId) throw new Error('CFD strategy lacks matching universe-wide selection evidence');
  const review = evidence(deployment.reviewId, deployment.reviewAttemptId), reviewConfig = record(review.manifest.configuration);
  // Recorded review is an explicit provenance/cadence assessment, not a generated "verified" flag.
  if (reviewConfig.purpose !== 'CFD_DATA_AND_EXECUTION_REVIEW' || reviewConfig.datasetId !== datasetId || reviewConfig.hypothesisId !== deployment.hypothesisId || reviewConfig.accountId !== accountId || review.manifest.codeId !== codeId || review.outcome.verdict !== 'APPROVED_FOR_BOUNDED_DEMO') throw new Error('Missing matching historical-cost, contract and execution review');
  if (contentHash(reviewConfig.deploymentLimits) !== contentHash({ expiresAt: deployment.expiresAt, pollIntervalMs: deployment.pollIntervalMs, maxLots: deployment.maxLots, maxPlannedLoss: deployment.maxPlannedLoss })) throw new Error('CFD deployment limits differ from the recorded review');
  const docs = z.array(z.object({ source: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), role: z.enum(['HISTORICAL_COSTS', 'CONTRACT', 'QUOTE_CADENCE', 'DEMO_EXECUTION']) })).parse(record(review.bundle.dataset).documents);
  if (!['HISTORICAL_COSTS', 'CONTRACT', 'QUOTE_CADENCE', 'DEMO_EXECUTION'].every(role => docs.some(doc => doc.role === role))) throw new Error('CFD review lacks required source evidence');
  if (db.prepare('SELECT 1 FROM cfd_strategy_suspensions WHERE hypothesis_id=?').get(deployment.hypothesisId)) throw new Error('CFD hypothesis is suspended');
  return { deployment, config, dataset };
}
export function ensureCfdRunnerSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cfd_strategy_suspensions(hypothesis_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cfd_runner_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, time_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cfd_runner_positions(account_id TEXT NOT NULL, position_id TEXT NOT NULL, hypothesis_id TEXT NOT NULL, held_quotes INTEGER NOT NULL, last_quote_ms INTEGER NOT NULL, PRIMARY KEY(account_id,position_id));`);
  for (const table of ['cfd_strategy_suspensions', 'cfd_runner_events']) for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'CFD runner audit records are immutable'); END;`);
}
