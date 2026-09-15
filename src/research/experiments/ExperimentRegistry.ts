import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const holdoutSchema = z.array(z.object({ symbol: z.string().min(1), timestamp: z.string().datetime(), price: z.number().finite().positive() })).min(1);

/** Stable JSON for manifests: unsupported or nonfinite values are rejected, never erased. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Experiment manifest contains unsupported values');
}
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Capture source and dependency declarations, never .env, accounts, logs or databases. */
export function captureResearchCode(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files[path] = readFileSync(join(root, path), 'utf8');
    }
  };
  visit('src');
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) files[file] = readFileSync(join(root, file), 'utf8');
  return files;
}

export class ExperimentRegistry {
  constructor(private readonly db: Database.Database, private readonly code: Record<string, string>) {
    ensureExperimentSchema(db);
  }

  begin(dataset: unknown, configuration: unknown, kind: 'EXPERIMENT' | 'VALIDATION_STUDY' = 'EXPERIMENT'): { experimentId: string; attemptId: string } {
    return this.db.transaction(() => {
      const dataId = this.artifact(dataset);
      const codeId = this.artifact(this.code);
      const hypothesisConfiguration = configuration && typeof configuration === 'object' && !Array.isArray(configuration)
        ? Object.fromEntries(Object.entries(configuration).filter(([key]) => key !== 'numTrials' && key !== 'periods')) : configuration;
      const hypothesisId = kind === 'EXPERIMENT' ? this.registerHypothesis(hypothesisConfiguration) : null;
      const manifest = { schemaVersion: 1, kind, hypothesisId, dataId, codeId, configuration,
        runtime: { node: process.version, platform: process.platform, architecture: process.arch },
        randomness: 'No seed supplied; deterministic replay must be verified separately' };
      const experimentId = contentHash(manifest);
      this.db.prepare('INSERT OR IGNORE INTO experiment_manifests(id,content) VALUES (?,?)').run(experimentId, canonicalJson(manifest));
      const attemptId = randomUUID();
      this.db.prepare('INSERT INTO experiment_attempts(id,experiment_id,created_at) VALUES (?,?,?)').run(attemptId, experimentId, new Date().toISOString());
      return { experimentId, attemptId };
    }).immediate();
  }

  finish(attemptId: string, status: 'COMPLETED' | 'FAILED', outcome: unknown): void {
    this.db.prepare('INSERT INTO experiment_outcomes(attempt_id,status,content) VALUES (?,?,?)').run(attemptId, status, canonicalJson(outcome));
  }

  registerHypothesis(declaration: unknown): string {
    const content = canonicalJson(declaration);
    const id = contentHash(declaration);
    this.db.prepare('INSERT OR IGNORE INTO research_hypotheses(id,content) VALUES (?,?)').run(id, content);
    return id;
  }

  countHypotheses(): number {
    return (this.db.prepare('SELECT count(*) AS count FROM research_hypotheses').get() as { count: number }).count;
  }

  /** Consume once BEFORE evaluation, including failed evaluations; no retry with another candidate. */
  claimHoldout(dataset: unknown, hypothesisId: string): string {
    const rows = holdoutSchema.parse(dataset);
    if (!this.db.prepare('SELECT id FROM research_hypotheses WHERE id=?').get(hypothesisId)) throw new Error('Unknown holdout hypothesis');
    return this.db.transaction(() => {
      const datasetId = this.artifact(dataset);
      // Preserve the unique constraint for an exact replay; reject changed or
      // shortened overlapping datasets as well, even if their hashes differ.
      if (!this.db.prepare('SELECT dataset_id FROM research_holdout_claims WHERE dataset_id=?').get(datasetId)) {
        const previous = this.db.prepare(`SELECT a.content FROM research_holdout_claims h JOIN experiment_artifacts a ON a.id=h.dataset_id`).all() as { content: string }[];
        const ranges = (values: z.infer<typeof holdoutSchema>): Map<string, [number, number]> => {
          const result = new Map<string, [number, number]>();
          for (const row of values) {
            const time = Date.parse(row.timestamp);
            const prior = result.get(row.symbol);
            result.set(row.symbol, prior ? [Math.min(prior[0], time), Math.max(prior[1], time)] : [time, time]);
          }
          return result;
        };
        const requested = ranges(rows);
        for (const record of previous) for (const [symbol, interval] of ranges(holdoutSchema.parse(JSON.parse(record.content)))) {
          const proposed = requested.get(symbol);
          if (proposed && proposed[0] <= interval[1] && proposed[1] >= interval[0]) throw new Error('Holdout overlaps previously consumed observations');
        }
      }
      this.db.prepare('INSERT INTO research_holdout_claims(dataset_id,hypothesis_id,claimed_at) VALUES (?,?,?)')
        .run(datasetId, hypothesisId, new Date().toISOString());
      return datasetId;
    }).immediate();
  }

  private artifact(value: unknown): string {
    const id = contentHash(value);
    this.db.prepare('INSERT OR IGNORE INTO experiment_artifacts(id,content) VALUES (?,?)').run(id, canonicalJson(value));
    return id;
  }
}

export function ensureExperimentSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_hypotheses (id TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_holdout_claims (dataset_id TEXT PRIMARY KEY, hypothesis_id TEXT NOT NULL, claimed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS experiment_artifacts (id TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS experiment_manifests (id TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS experiment_attempts (id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiment_manifests(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS experiment_outcomes (attempt_id TEXT PRIMARY KEY REFERENCES experiment_attempts(id), status TEXT NOT NULL CHECK(status IN ('COMPLETED','FAILED')), content TEXT NOT NULL);
    `);
    for (const table of ['research_hypotheses', 'research_holdout_claims', 'experiment_artifacts', 'experiment_manifests', 'experiment_attempts', 'experiment_outcomes']) {
      for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Experiment records are immutable'); END;`);
    }
}

/** Verify content hashes before exporting a self-contained, non-executable audit bundle. */
export function readExperimentBundle(db: Database.Database, experimentId: string): Record<string, unknown> {
  const manifestRow = db.prepare('SELECT content FROM experiment_manifests WHERE id=?').get(experimentId) as { content: string } | undefined;
  if (!manifestRow) throw new Error('Unknown experiment');
  const manifest: unknown = JSON.parse(manifestRow.content);
  if (contentHash(manifest) !== experimentId) throw new Error('Manifest hash mismatch');
  const references = manifest as { dataId: string; codeId: string };
  const read = (id: string): unknown => {
    const row = db.prepare('SELECT content FROM experiment_artifacts WHERE id=?').get(id) as { content: string } | undefined;
    if (!row) throw new Error('Missing experiment artifact');
    const content: unknown = JSON.parse(row.content);
    if (contentHash(content) !== id) throw new Error('Artifact hash mismatch');
    return content;
  };
  const attempts = db.prepare(`SELECT a.id,a.created_at,o.status,o.content FROM experiment_attempts a
    LEFT JOIN experiment_outcomes o ON o.attempt_id=a.id WHERE a.experiment_id=? ORDER BY a.created_at,a.id`)
    .all(experimentId) as { id: string; created_at: string; status: string | null; content: string | null }[];
  return { experimentId, manifest, dataset: read(references.dataId), code: read(references.codeId),
    attempts: attempts.map(attempt => ({ id: attempt.id, createdAt: attempt.created_at, status: attempt.status ?? 'UNFINISHED',
      outcome: attempt.content ? JSON.parse(attempt.content) as unknown : null })) };
}
