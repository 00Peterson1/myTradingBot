import { handleHelp } from './help.js';
handleHelp('cfd:deploy', 'Prepare a bounded DEMO deployment from immutable passing evidence. --review reviewed-evidence.json --out deployment.json. Requires an explicit reviewer, source documents for historical costs/contract/quote cadence/demo execution, and matching supported study/batch IDs. Does not run the bot or place orders. --suspend HYPOTHESIS_ID --reason TEXT permanently suspends that hypothesis.');
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ExperimentRegistry, captureResearchCode, contentHash, readExperimentBundle } from '../research/experiments/ExperimentRegistry.js';
import { cfdDeploymentSchema, ensureCfdRunnerSchema, loadCfdDeployment } from '../cfd/CfdDeployment.js';
import { cfdDatasetIdentity } from '../cfd/CfdDataset.js';
import { getDb, closeDb } from '../data/database/sqlite.js';
import { writeNewJson } from '../cfd/history/CfdCsvImport.js';
import { print } from '../monitoring/print.js';

const reviewSchema = z.object({ deployment: cfdDeploymentSchema.omit({ reviewId: true, reviewAttemptId: true }),
  reviewer: z.string().min(1), assessment: z.string().min(40),
  documents: z.array(z.object({ path: z.string().min(1), source: z.string().min(1), role: z.enum(['HISTORICAL_COSTS', 'CONTRACT', 'QUOTE_CADENCE', 'DEMO_EXECUTION']) }).strict()).min(4),
}).strict();
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { review: { type: 'string' }, out: { type: 'string' }, suspend: { type: 'string' }, reason: { type: 'string' } }, strict: true });
  const db = getDb(); ensureCfdRunnerSchema(db);
  try {
    if (values.suspend) {
      if (!/^[a-f0-9]{64}$/.test(values.suspend) || !values.reason?.trim()) throw new Error('Suspension requires a hypothesis ID and reason');
      db.prepare('INSERT INTO cfd_strategy_suspensions VALUES (?,?,?)').run(values.suspend, values.reason.trim(), Date.now());
      print('CFD hypothesis suspended; existing broker stops remain active.'); return;
    }
    if (!values.review || !values.out) throw new Error('--review and --out are required');
    const review = reviewSchema.parse(JSON.parse(readFileSync(values.review, 'utf8')) as unknown);
    const bundle = readExperimentBundle(db, review.deployment.studyId);
    const { id: datasetId } = cfdDatasetIdentity(bundle.dataset);
    const documents = review.documents.map(doc => {
      const bytes = readFileSync(resolve(dirname(resolve(values.review ?? '')), doc.path));
      return { source: doc.source, role: doc.role, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    if (!['HISTORICAL_COSTS', 'CONTRACT', 'QUOTE_CADENCE', 'DEMO_EXECUTION'].every(role => documents.some(doc => doc.role === role))) throw new Error('Review must cover all required evidence roles');
    const code = captureResearchCode(fileURLToPath(new URL('../../', import.meta.url))), registry = new ExperimentRegistry(db, code);
    const { expiresAt, pollIntervalMs, maxLots, maxPlannedLoss } = review.deployment;
    const attempt = registry.begin({ documents, reviewer: review.reviewer, assessment: review.assessment }, { product: 'CFD', purpose: 'CFD_DATA_AND_EXECUTION_REVIEW',
      datasetId, hypothesisId: review.deployment.hypothesisId, accountId: review.deployment.accountId, deploymentLimits: { expiresAt, pollIntervalMs, maxLots, maxPlannedLoss } }, 'VALIDATION_STUDY');
    registry.finish(attempt.attemptId, 'COMPLETED', { verdict: 'APPROVED_FOR_BOUNDED_DEMO', basis: 'Explicit recorded operator review; hashes establish document integrity, not independent accuracy' });
    const deployment = { ...review.deployment, reviewId: attempt.experimentId, reviewAttemptId: attempt.attemptId };
    loadCfdDeployment(db, deployment, deployment.accountId, contentHash(code));
    await writeNewJson(values.out, deployment);
    print(JSON.stringify({ output: values.out, symbol: deployment.symbol, mode: 'DEMO', expiresAt, liveEligible: false }));
  } finally { closeDb(); }
}
main().catch((error: unknown) => { print(error instanceof z.ZodError ? 'Invalid deployment review schema' : error instanceof Error ? error.message : 'CFD deployment preparation failed'); process.exitCode = 1; });
