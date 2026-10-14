import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Operational Node entry.
import { canReuseBrowserProof, reusableEnvironment, tryReuseBrowserProof } from '../scripts/ci-browser-proof.mjs';
afterEach(() => vi.unstubAllEnvs());
const environment = { node: 'v24.14.1', nodeHash: 'a'.repeat(64), npm: '11', git: 'git version 2', kernel: 'synthetic', platform: 'linux', arch: 'x64', hostImage: 'test-image', hostOS: 'ubuntu', playwright: '1.62.1', lock: 'b'.repeat(64), bases: ['node:24-alpine@sha256:' + 'c'.repeat(64)] };
const expected = { runId: 42, attempt: 1, headSha: 'a'.repeat(40), tree: 'b'.repeat(40), role: '2-1', shard: '1/6', environment };
const now = Date.parse('2026-10-14T12:00:00Z');
const proof = { version: 1, repository: 'zdaiwmm/shui-IM', sourceRun: 42, attempt: 1, headSha: expected.headSha, tree: expected.tree, role: expected.role, shard: expected.shard, executed: true, executedAt: '2026-10-14T11:59:00Z', environment };
describe('full browser evidence equivalence', () => {
  it('reuses only freshly executed exact-tree, exact-role evidence under the same immutable environment', () => {
    expect(canReuseBrowserProof(proof, expected, now)).toBe(true);
    for (const change of [{ version: 2 }, { repository: 'other' }, { sourceRun: 41 }, { attempt: 2 }, { headSha: 'c'.repeat(40) }, { tree: 'd'.repeat(40) }, { role: '2-2' }, { shard: '2/6' }, { executed: false }, { executedAt: '2026-10-14T10:59:59Z' }, { executedAt: '2026-10-14T12:00:01Z' }, { environment: { ...environment, node: 'different' } }, { environment: { ...environment, bases: ['node:24-alpine'] } }]) {
      expect(canReuseBrowserProof({ ...proof, ...change }, expected, now)).toBe(false);
    }
  });
  it('rejects unknown environment identity instead of silently caching test results', () => {
    expect(reusableEnvironment({ ...environment, hostImage: '', hostOS: '' })).toBe(false);
    expect(reusableEnvironment({ ...environment, hostImage: '', hostOS: '', containerImage: 'playwright@sha256:' + 'd'.repeat(64) })).toBe(true);
    expect(canReuseBrowserProof({ ...proof, environment: {} }, { ...expected, environment: {} }, now)).toBe(false);
  });
  it('requires the latest complete PR CI, full aggregate, exact artifact and a final freshness check', async () => {
    for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: 'zdaiwmm/shui-IM', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'c'.repeat(40), BROWSER_GROUP: '2', BROWSER_SHARD: '1/6', BROWSER_INDEX: '1' })) vi.stubEnv(key, value);
    const candidate = { id: 42, run_attempt: 1, head_sha: expected.headSha, head_branch: 'feature', path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success' };
    const executed = { ...proof, executedAt: new Date().toISOString() };
    for (const failure of ['', 'newer-failed', 'scoped', 'artifact-head', 'changed-attempt', 'different-tree']) {
      let lists = 0, downloads = 0;
      const api = async (suffix: string) => {
        if (suffix.startsWith('commits/')) return [{ merged_at: 'now', merge_commit_sha: 'c'.repeat(40), base: { ref: 'main' }, head: { sha: expected.headSha, ref: 'feature', repo: { full_name: 'zdaiwmm/shui-IM' } } }];
        if (suffix.startsWith('actions/workflows/')) {
          lists++;
          return { workflow_runs: failure === 'newer-failed' ? [candidate, { ...candidate, id: 43, conclusion: 'failure' }] : [{ ...candidate, run_attempt: failure === 'changed-attempt' && lists > 1 ? 2 : 1 }] };
        }
        if (suffix.includes('/jobs?')) return { jobs: [{ name: 'verify', head_sha: expected.headSha, run_id: 42, status: 'completed', conclusion: 'success', steps: [{ name: 'Full application verification', conclusion: failure === 'scoped' ? 'skipped' : 'success' }] }] };
        if (suffix.includes('/artifacts?')) return { artifacts: [{ id: 7, name: 'quiet-room-browser-proof-42-1-2-1', expired: false, size_in_bytes: 2048, workflow_run: { id: 42, head_sha: failure === 'artifact-head' ? 'd'.repeat(40) : expected.headSha } }] };
        throw new Error('Unexpected API');
      };
      const result = await tryReuseBrowserProof(() => failure === 'different-tree' ? 'd'.repeat(40) : expected.tree, { api, download: async () => { downloads++; return executed; }, fingerprint: () => environment });
      expect(result, failure).toBe(failure === '');
      if (['newer-failed', 'scoped', 'artifact-head'].includes(failure)) expect(downloads).toBe(0);
    }
  });
});
