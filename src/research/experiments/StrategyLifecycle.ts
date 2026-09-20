import type Database from 'better-sqlite3';
import { z } from 'zod';
import { contentHash, readExperimentBundle } from './ExperimentRegistry.js';

export const lifecycleStateSchema = z.enum(['DISCOVERED', 'BACKTESTED', 'OOS_VALIDATED', 'WALK_FORWARD_VALIDATED',
  'ROBUSTNESS_VALIDATED', 'DEMO_ELIGIBLE', 'DEMO_RUNNING', 'LIVE_ELIGIBLE', 'LIVE', 'REVIEW', 'SUSPENDED']);
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
const next: Partial<Record<LifecycleState, readonly LifecycleState[]>> = {
  DISCOVERED: ['BACKTESTED', 'REVIEW'], BACKTESTED: ['OOS_VALIDATED', 'REVIEW'],
  OOS_VALIDATED: ['WALK_FORWARD_VALIDATED', 'REVIEW'], WALK_FORWARD_VALIDATED: ['ROBUSTNESS_VALIDATED', 'REVIEW'],
  ROBUSTNESS_VALIDATED: ['DEMO_ELIGIBLE', 'REVIEW'], DEMO_ELIGIBLE: ['DEMO_RUNNING', 'REVIEW'],
  DEMO_RUNNING: ['LIVE_ELIGIBLE', 'REVIEW'], LIVE_ELIGIBLE: ['LIVE', 'REVIEW'], LIVE: ['REVIEW'], REVIEW: ['SUSPENDED'],
};
const manifestSchema = z.object({ hypothesisId: z.string().nullable(), codeId: z.string(), kind: z.string() });
const studySchema = z.object({ verdict: z.literal('HOLDOUT_SUPPORTED'), selectedId: z.string(), finalExperimentId: z.string(),
  candidates: z.array(z.object({ id: z.string(), eligible: z.boolean(), adjustedPValue: z.number().finite().min(0).max(1), foldExperiments: z.array(z.string()).min(2) })) });

/** Append-only transitions; a review/suspension cannot be undone by a runner restart. */
export class StrategyLifecycle {
  private readonly verifiedStudies = new Set<string>();
  constructor(private readonly db: Database.Database) { ensureLifecycleSchema(db); }

  declaration(id: string): unknown {
    const row = this.db.prepare('SELECT content FROM research_hypotheses WHERE id=?').get(id) as { content: string } | undefined;
    if (!row) throw new Error('Unknown hypothesis');
    const declaration: unknown = JSON.parse(row.content);
    if (contentHash(declaration) !== id) throw new Error('Hypothesis identity mismatch');
    return declaration;
  }

  state(id: string): LifecycleState {
    this.declaration(id);
    const row = this.db.prepare('SELECT state FROM strategy_lifecycle_events WHERE hypothesis_id=? ORDER BY sequence DESC LIMIT 1').get(id) as { state: unknown } | undefined;
    return row ? lifecycleStateSchema.parse(row.state) : 'DISCOVERED';
  }

  list(): { id: string; state: LifecycleState }[] {
    return (this.db.prepare('SELECT id FROM research_hypotheses ORDER BY id').all() as { id: string }[])
      .map(({ id }) => ({ id, state: this.state(id) }));
  }

  private completed(experimentId: string): { manifest: z.infer<typeof manifestSchema>; outcomes: unknown[] } {
    const bundle = readExperimentBundle(this.db, experimentId);
    const attempts = z.array(z.object({ status: z.string(), outcome: z.unknown() })).parse(bundle.attempts);
    const outcomes = attempts.filter(row => row.status === 'COMPLETED').map(row => row.outcome);
    if (!outcomes.length) throw new Error('Evidence has no completed attempt');
    return { manifest: manifestSchema.parse(bundle.manifest), outcomes };
  }

  private supportedStudy(id: string, studyId: string, codeId?: string): void {
    const cacheKey = `${id}:${studyId}:${codeId ?? 'any'}`;
    if (this.verifiedStudies.has(cacheKey)) return;
    const study = this.completed(studyId);
    if (study.manifest.kind !== 'VALIDATION_STUDY') throw new Error('Expected validation study evidence');
    if (codeId && study.manifest.codeId !== codeId) throw new Error('Validated source/dependencies differ from current runtime');
    const outcome = study.outcomes.map(value => studySchema.safeParse(value)).find(value => value.success);
    if (!outcome?.success) throw new Error('Study does not support its final holdout');
    const selected = outcome.data.candidates.find(row => row.id === outcome.data.selectedId);
    if (!selected?.eligible || selected.adjustedPValue > 0.05 || new Set(selected.foldExperiments).size !== selected.foldExperiments.length) throw new Error('Selected candidate lacks selection evidence');
    const final = this.completed(outcome.data.finalExperimentId);
    if (final.manifest.hypothesisId !== id || final.manifest.codeId !== study.manifest.codeId) throw new Error('Evidence belongs to a different hypothesis/version');
    for (const fold of selected.foldExperiments) {
      const evidence = this.completed(fold);
      if (evidence.manifest.hypothesisId !== id || evidence.manifest.codeId !== study.manifest.codeId) throw new Error('Fold evidence does not match hypothesis/version');
    }
    this.verifiedStudies.add(cacheKey);
  }

  transition(id: string, target: LifecycleState, reason: string, evidenceId?: string): void {
    if (!reason.trim()) throw new Error('Lifecycle changes require an explicit review reason');
    this.db.transaction(() => {
      const current = this.state(id);
      if (!next[current]?.includes(target)) throw new Error(`Invalid lifecycle transition ${current} → ${target}`);
      if (target === 'LIVE_ELIGIBLE') {
        // A simulated holdout or an isolated manual demo trade is not evidence of a live edge.
        throw new Error('Live promotion requires a validated prospective demo evaluation protocol; unavailable');
      }
      if (target === 'BACKTESTED') {
        if (!evidenceId || this.completed(evidenceId).manifest.hypothesisId !== id) throw new Error('Completed matching backtest evidence required');
      } else if (['OOS_VALIDATED', 'WALK_FORWARD_VALIDATED', 'ROBUSTNESS_VALIDATED', 'DEMO_ELIGIBLE'].includes(target)) {
        if (!evidenceId) throw new Error('Supported validation study evidence required');
        this.supportedStudy(id, evidenceId);
      } else if (target === 'DEMO_RUNNING' || target === 'LIVE') {
        this.assertEligible(id, target === 'DEMO_RUNNING' ? 'DEMO' : 'LIVE');
      }
      this.db.prepare('INSERT INTO strategy_lifecycle_events(hypothesis_id,previous_state,state,reason,evidence_id,occurred_at) VALUES (?,?,?,?,?,?)')
        .run(id, current, target, reason.trim(), evidenceId ?? null, new Date().toISOString());
    }).immediate();
  }

  assertEligible(id: string, mode: 'DEMO' | 'LIVE', codeId?: string): void {
    const state = this.state(id);
    const allowed = mode === 'DEMO' ? ['DEMO_ELIGIBLE', 'DEMO_RUNNING'] : ['LIVE_ELIGIBLE', 'LIVE'];
    if (!allowed.includes(state)) throw new Error(`Hypothesis ${id} is ${state}, not eligible for ${mode}`);
    const row = this.db.prepare("SELECT evidence_id FROM strategy_lifecycle_events WHERE hypothesis_id=? AND state='DEMO_ELIGIBLE' ORDER BY sequence DESC LIMIT 1")
      .get(id) as { evidence_id: string | null } | undefined;
    if (!row?.evidence_id) throw new Error('Missing immutable eligibility evidence');
    this.supportedStudy(id, row.evidence_id, codeId);
  }

  history(id: string): unknown[] {
    this.declaration(id);
    return this.db.prepare('SELECT previous_state,state,reason,evidence_id,occurred_at FROM strategy_lifecycle_events WHERE hypothesis_id=? ORDER BY sequence').all(id);
  }
}

export function ensureLifecycleSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS strategy_lifecycle_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    hypothesis_id TEXT NOT NULL REFERENCES research_hypotheses(id), previous_state TEXT NOT NULL,
    state TEXT NOT NULL, reason TEXT NOT NULL, evidence_id TEXT, occurred_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_lifecycle_hypothesis ON strategy_lifecycle_events(hypothesis_id,sequence);`);
  for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS lifecycle_no_${operation} BEFORE ${operation}
    ON strategy_lifecycle_events BEGIN SELECT RAISE(ABORT, 'Lifecycle history is immutable'); END;`);
}
