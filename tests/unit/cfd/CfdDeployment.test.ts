import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentHash, ExperimentRegistry } from '../../../src/research/experiments/ExperimentRegistry.js';
import { loadCfdDeployment, ensureCfdRunnerSchema } from '../../../src/cfd/CfdDeployment.js';
import { cfdDatasetIdentity } from '../../../src/cfd/CfdDataset.js';
import { cfdBacktestConfigSchema } from '../../../src/cfd/CfdBacktest.js';

const code = { fixture: 'Artificial evidence to test gates; never a real strategy approval' };
const fixtureData = cfdDatasetIdentity(JSON.parse(readFileSync('examples/cfd/fixture.json', 'utf8')) as unknown).dataset;
const config = cfdBacktestConfigSchema.parse(JSON.parse(readFileSync('examples/cfd/config.json', 'utf8')) as unknown);
function setup(db: Database.Database, kind: 'FIXTURE' | 'EXTERNAL_BID_ASK' = 'EXTERNAL_BID_ASK') {
  ensureCfdRunnerSchema(db);
  const registry = new ExperimentRegistry(db, code), dataset = { ...fixtureData, kind };
  const hypothesisId = registry.registerHypothesis({ product: 'CFD', symbol: 'EURUSD', config });
  const study = registry.begin(dataset, { product: 'CFD' }, 'VALIDATION_STUDY');
  registry.finish(study.attemptId, 'COMPLETED', { verdict: 'HOLDOUT_SUPPORTED_PENDING_BROKER_VERIFICATION', symbol: 'EURUSD', selectedId: hypothesisId,
    development: [{ hypothesisId, config, periods: [{ passed: true }, { passed: true }, { passed: true }] }], final: { passed: true }, stress: { passed: true } });
  const batch = registry.begin({}, { purpose: 'CFD_BATCH_VALIDATION' }, 'VALIDATION_STUDY');
  registry.finish(batch.attemptId, 'COMPLETED', { accountId: '123', mode: 'VALIDATE', symbols: [{ symbol: 'EURUSD', researchSupported: true, batchAdjustedPValue: 0.01, validation: study }] });
  const limits = { expiresAt: new Date(Date.now() + 86400000).toISOString(), pollIntervalMs: 1000, maxLots: 0.01, maxPlannedLoss: 2 };
  const review = registry.begin({ documents: ['HISTORICAL_COSTS', 'CONTRACT', 'QUOTE_CADENCE', 'DEMO_EXECUTION'].map(role => ({ role, source: 'test fixture', sha256: 'a'.repeat(64) })) },
    { purpose: 'CFD_DATA_AND_EXECUTION_REVIEW', datasetId: contentHash(dataset), hypothesisId, accountId: '123', deploymentLimits: limits }, 'VALIDATION_STUDY');
  registry.finish(review.attemptId, 'COMPLETED', { verdict: 'APPROVED_FOR_BOUNDED_DEMO' });
  return { version: 1, mode: 'DEMO', accountId: '123', symbol: 'EURUSD', hypothesisId, studyId: study.experimentId, studyAttemptId: study.attemptId,
    batchId: batch.experimentId, batchAttemptId: batch.attemptId, reviewId: review.experimentId, reviewAttemptId: review.attemptId, ...limits };
}
describe('CFD immutable deployment evidence gate', () => {
  it('loads the recorded config and rejects edited limits, expired approval, another account and changed code', () => {
    const db = new Database(':memory:');
    try {
      const deployment = setup(db), codeId = contentHash(code);
      expect(loadCfdDeployment(db, deployment, '123', codeId).config).toEqual(config);
      expect(() => loadCfdDeployment(db, { ...deployment, maxLots: 1 }, '123', codeId)).toThrow('limits');
      expect(() => loadCfdDeployment(db, deployment, '456', codeId)).toThrow('account');
      expect(() => loadCfdDeployment(db, deployment, '123', 'changed')).toThrow('code');
      expect(() => loadCfdDeployment(db, deployment, '123', codeId, Date.now() + 172800000)).toThrow('expired');
      expect(() => loadCfdDeployment(db, { ...deployment, mode: 'LIVE' }, '123', codeId)).toThrow();
      db.prepare('INSERT INTO cfd_strategy_suspensions VALUES (?,?,?)').run(deployment.hypothesisId, 'review required', Date.now());
      expect(() => loadCfdDeployment(db, deployment, '123', codeId)).toThrow('suspended');
    } finally { db.close(); }
  });
  it('cannot promote fixture data even when an outcome claims support', () => {
    const db = new Database(':memory:');
    try { expect(() => loadCfdDeployment(db, setup(db, 'FIXTURE'), '123', contentHash(code))).toThrow('observed'); }
    finally { db.close(); }
  });
});
