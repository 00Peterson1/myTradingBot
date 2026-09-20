import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExperimentRegistry, contentHash } from '../../../src/research/experiments/ExperimentRegistry.js';
import { StrategyLifecycle, type LifecycleState } from '../../../src/research/experiments/StrategyLifecycle.js';
let db: Database.Database;
let registry: ExperimentRegistry;
let lifecycle: StrategyLifecycle;
const declaration = { strategy: 'fixture', symbol: 'TEST' };
const code = { fixture: '1' };
beforeEach(() => { db = new Database(':memory:'); registry = new ExperimentRegistry(db, code); lifecycle = new StrategyLifecycle(db); });
afterEach(() => { db.close(); });
function evidence(): { id: string; runId: string; studyId: string } {
  const id = registry.registerHypothesis(declaration);
  const second = registry.begin([], { ...declaration, periods: ['second'] });
  registry.finish(second.attemptId, 'COMPLETED', { observations: [] });
  const run = registry.begin([], declaration);
  registry.finish(run.attemptId, 'COMPLETED', { observations: [] });
  const study = registry.begin([], { policy: 'fixture' }, 'VALIDATION_STUDY');
  registry.finish(study.attemptId, 'COMPLETED', { verdict: 'HOLDOUT_SUPPORTED', selectedId: 'fixture', finalExperimentId: run.experimentId,
    candidates: [{ id: 'fixture', eligible: true, adjustedPValue: 0.01, foldExperiments: [run.experimentId, second.experimentId] }] });
  return { id, runId: run.experimentId, studyId: study.experimentId };
}
function eligible(): ReturnType<typeof evidence> {
  const fixture = evidence();
  lifecycle.transition(fixture.id, 'BACKTESTED', 'review', fixture.runId);
  for (const state of ['OOS_VALIDATED', 'WALK_FORWARD_VALIDATED', 'ROBUSTNESS_VALIDATED', 'DEMO_ELIGIBLE'] as const) lifecycle.transition(fixture.id, state, 'review', fixture.studyId);
  return fixture;
}
describe('evidence-backed lifecycle', () => {
  it('rejects state skipping, unknown hypotheses, missing or mismatched evidence', () => {
    const { id, runId } = evidence();
    expect(lifecycle.state(id)).toBe('DISCOVERED');
    expect(() => { lifecycle.transition(id, 'DEMO_ELIGIBLE', 'skip'); }).toThrow('Invalid lifecycle');
    expect(() => { lifecycle.assertEligible(id, 'DEMO'); }).toThrow('not eligible');
    expect(() => lifecycle.state('missing')).toThrow('Unknown hypothesis');
    expect(() => { lifecycle.transition(id, 'BACKTESTED', ''); }).toThrow('reason');
    expect(() => { lifecycle.transition(id, 'BACKTESTED', 'review'); }).toThrow('evidence');
    const other = registry.registerHypothesis({ different: true });
    expect(() => { lifecycle.transition(other, 'BACKTESTED', 'review', runId); }).toThrow('matching');
  });
  it('binds eligibility to source and preserves suspensions across restarts', () => {
    const { id } = eligible();
    lifecycle.assertEligible(id, 'DEMO', contentHash(code));
    expect(() => { lifecycle.assertEligible(id, 'DEMO', contentHash({ fixture: '2' })); }).toThrow('source');
    expect(() => { lifecycle.assertEligible(id, 'LIVE'); }).toThrow('not eligible');
    lifecycle.transition(id, 'DEMO_RUNNING', 'start');
    expect(() => { lifecycle.transition(id, 'LIVE_ELIGIBLE', 'manual demo won'); }).toThrow('prospective demo');
    lifecycle.transition(id, 'REVIEW', 'degradation');
    lifecycle.transition(id, 'SUSPENDED', 'confirmed');
    lifecycle = new StrategyLifecycle(db);
    expect(() => { lifecycle.assertEligible(id, 'DEMO'); }).toThrow('not eligible');
    expect(() => { lifecycle.transition(id, 'DEMO_ELIGIBLE', 'restart'); }).toThrow('Invalid lifecycle');
    expect(() => db.exec('DELETE FROM strategy_lifecycle_events')).toThrow('immutable');
  });
  it('does not promote from failed or unfinished experiments', () => {
    const id = registry.registerHypothesis(declaration);
    const run = registry.begin([], declaration);
    for (const state of ['BACKTESTED'] as LifecycleState[]) expect(() => { lifecycle.transition(id, state, 'review', run.experimentId); }).toThrow('no completed');
    registry.finish(run.attemptId, 'FAILED', { reason: 'gap' });
    expect(() => { lifecycle.transition(id, 'BACKTESTED', 'review', run.experimentId); }).toThrow('no completed');
    expect(lifecycle.history(id)).toEqual([]);
  });
});
