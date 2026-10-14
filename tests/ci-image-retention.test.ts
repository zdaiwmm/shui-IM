import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script has no TS declarations.
import { imageRetentionPlan, protectedPublishShas } from '../scripts/ci-image-retention.mjs';

describe('bounded CI artifact retention', () => {
  it('keeps the current and two previous versions and ignores other artifacts or active/unknown runs', () => {
    const runs: Record<number, any> = {}; const artifacts: any[] = [];
    for (let id = 1; id <= 5; id++) {
      const sha = String(id).repeat(40);
      runs[id] = { id, path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push', head_sha: sha, status: 'completed', conclusion: 'success' };
      artifacts.push({ id, name: `quiet-room-image-${sha}-1-amd64`, expired: false, workflow_run: { id, head_sha: sha } });
    }
    expect(imageRetentionPlan(artifacts, runs, 5, '5'.repeat(40))).toEqual([1, 2]);
    for (const change of [{ status: 'in_progress' }, { head_branch: 'feature' }, { path: 'other.yml' }, { head_sha: 'f'.repeat(40) }]) {
      expect(imageRetentionPlan(artifacts, { ...runs, 1: { ...runs[1], ...change } }, 5, '5'.repeat(40))).not.toContain(1);
    }
    expect(imageRetentionPlan([...artifacts, { id: 99, name: 'user-upload', expired: false, workflow_run: { id: 1 } }], runs, 5, '5'.repeat(40))).not.toContain(99);
  });
  it('retains failed diagnostic artifacts for a day and never uses an unknown timestamp to authorize deletion', () => {
    const sha = 'a'.repeat(40);
    const run = { id: 1, path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push', head_sha: sha, status: 'completed', conclusion: 'failure' };
    const artifact = { id: 1, name: `quiet-room-image-${sha}-1-amd64`, expired: false, workflow_run: { id: 1, head_sha: sha } };
    expect(imageRetentionPlan([artifact], { 1: run }, 2, 'b'.repeat(40), 172800000)).toEqual([]);
    expect(imageRetentionPlan([{ ...artifact, created_at: new Date(0).toISOString() }], { 1: run }, 2, 'b'.repeat(40), 172800000)).toEqual([1]);
  });
});

describe('frozen cloud candidates', () => {
  it('protects active and three recent successful prepared/deployed application SHAs', () => {
    const base = { path: '.github/workflows/publish.yml', event: 'workflow_dispatch', head_branch: 'main' };
    const runs = [1, 2, 3, 4, 5].map(id => ({ ...base, id, display_title: `Publish ${String(id).repeat(40)} (request-${id})`, status: id === 1 ? 'queued' : 'completed', conclusion: 'success' }));
    expect(protectedPublishShas(runs)).toEqual(['1'.repeat(40), '5'.repeat(40), '4'.repeat(40), '3'.repeat(40)]);
    expect(() => protectedPublishShas([{ ...base, display_title: 'unknown' }])).toThrow();
    const sha = '1'.repeat(40);
    const artifact = { id: 1, name: `quiet-room-image-${sha}-1-amd64`, expired: false, workflow_run: { id: 1, head_sha: sha } };
    const run = { id: 1, path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success' };
    // Current and two newer versions would otherwise evict the frozen target.
    const artifacts = [artifact], ciRuns: Record<number, any> = { 1: run };
    for (const id of [2, 3, 4]) {
      const next = String(id).repeat(40);
      artifacts.push({ ...artifact, id, name: `quiet-room-image-${next}-1-amd64`, workflow_run: { id, head_sha: next } });
      ciRuns[id] = { ...run, id, head_sha: next };
    }
    expect(imageRetentionPlan(artifacts, ciRuns, 4, '4'.repeat(40))).toContain(1);
    expect(imageRetentionPlan(artifacts, ciRuns, 4, '4'.repeat(40), Date.now(), [sha])).not.toContain(1);
  });
});
