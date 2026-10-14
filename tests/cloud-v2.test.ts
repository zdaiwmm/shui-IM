import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational Node entry.
import { cloudPublish, production } from '../scripts/cloud-publish.mjs';
const sha = 'a'.repeat(40), previous = 'b'.repeat(40), tree = 'c'.repeat(40);
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(mode: 'stage' | 'activate', failure = '') {
  const directory = mkdtempSync(path.join(tmpdir(), 'quiet-cloud-v2-')); directories.push(directory);
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'zdaiwmm/shui-IM', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: tree, GITHUB_RUN_ID: '100', RUNNER_TEMP: directory, SAS_REGION_ID: production.region, SAS_INSTANCE_ID: production.instance, PUBLISH_MODE: mode })) vi.stubEnv(key, value);
  const manifest = { version: 1, validationVersion: 2, sourceTree: tree, sha, runId: 42, attempt: 1, platform: 'linux/amd64', imageId: 'sha256:' + 'd'.repeat(64), archiveSha256: 'e'.repeat(64), archiveBytes: 1024 };
  const trace: string[] = [];
  let metadata = false;
  const run = (program: string, args: string[]) => {
    trace.push(program + ' ' + args.join(' '));
    if (program === 'python3') { metadata = true; expect(args.at(-1)).toBe('--manifest'); return JSON.stringify(manifest); }
    const route = args[1];
    if (route.includes('/compare/')) return JSON.stringify({ status: 'ahead', merge_base_commit: { sha: route.split('/compare/')[1].split('...')[0] } });
    if (route.includes('runs?')) return JSON.stringify({ workflow_runs: [{ id: 42, run_attempt: failure === 'rerun' && metadata ? 2 : 1, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' }] });
    if (route.includes('/jobs?')) return JSON.stringify({ jobs: [{ run_id: 42, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] });
    if (route.includes('/artifacts?')) return JSON.stringify({ artifacts: [{ id: 7, size_in_bytes: 4096, name: `quiet-room-image-${sha}-1-amd64`, expired: false, workflow_run: { id: 42, head_sha: sha } }] });
    if (route.endsWith('/commits/' + sha)) return JSON.stringify({ commit: { tree: { sha: failure === 'tree' ? previous : tree } } });
    throw new Error('Unexpected operation');
  };
  const invokeCommand = async (script: string, label: string) => {
    trace.push(label);
    if (['preflight', 'postflight'].includes(label)) return JSON.stringify({ imageProtocol: 1, expectedPreviousProtocol: 1, stagedImageProtocol: failure === 'old-helper' ? undefined : 1, publicOrigin: production.origin }) + '\nLIVE_SHA=' + (label === 'postflight' && mode === 'activate' || label === 'postflight' && failure === 'live-changed' ? sha : previous);
    if (mode === 'activate') {
      expect(script).toContain(`--activate ${sha} ${manifest.imageId} ${manifest.archiveSha256} ${previous}`);
      expect(script).not.toContain('server-image-stream');
      return `DEPLOY_OK sha=${sha} image=${manifest.imageId}\n`;
    }
    return `STAGE_OK sha=${sha} image=${manifest.imageId}\nSTREAM_VERIFIED sha=${sha} image=${manifest.imageId}\n`;
  };
  return { run, invokeCommand, ticket: async () => 'https://example.blob.core.windows.net/synthetic', trace, directory };
}
describe('sealed artifact stage and activation orchestration', () => {
  it.each(['stage', 'activate'] as const)('uses only bounded metadata on the control runner and verifies %s independently', async mode => {
    const f = fixture(mode);
    await cloudPublish(sha, { [mode]: true, ...f });
    expect(f.trace.some(item => item.includes('run download'))).toBe(false);
    expect(f.trace.filter(item => item.startsWith(mode + '-'))).toHaveLength(1);
    expect(f.trace.at(-1)).toBe('postflight');
    const receipt = JSON.parse(readFileSync(path.join(f.directory, 'quiet-room-cloud-receipt.json'), 'utf8'));
    expect(receipt.status).toBe(mode === 'stage' ? 'STAGE_VERIFIED' : 'DEPLOY_VERIFIED');
    expect(receipt.previousSha).toBe(previous);
  });
  it.each(['old-helper', 'tree', 'rerun'])('blocks %s before any image import or cutover', async failure => {
    const f = fixture('stage', failure);
    await expect(cloudPublish(sha, { stage: true, ...f })).rejects.toThrow();
    expect(f.trace.some(item => item.startsWith('stage-') || item.startsWith('activate-'))).toBe(false);
  });
  it('rejects changed production after staging without repeating the import', async () => {
    const f = fixture('stage', 'live-changed');
    await expect(cloudPublish(sha, { stage: true, ...f })).rejects.toThrow('production changed');
    expect(f.trace.filter(item => item.startsWith('stage-'))).toHaveLength(1);
  });
});
