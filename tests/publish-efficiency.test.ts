import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational Node entry.
import { publish } from '../scripts/publish.mjs';
// @ts-expect-error Operational Node entry.
import { dispatchCloud, verifyCloudReceipt } from '../scripts/cloud-dispatch.mjs';
// @ts-expect-error Operational Node entry.
import { findCIImageArtifact } from '../scripts/ci-image.mjs';
// @ts-expect-error Operational Node entry.
import { cloudPublish, production } from '../scripts/cloud-publish.mjs';
const sha = 'a'.repeat(40), tool = 'b'.repeat(40);
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(status = 'DEPLOY_VERIFIED', failReadback = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'quiet-publish-efficiency-'));
  directories.push(directory);
  const calls: { program: string; args: string[] }[] = [];
  const workflow = { databaseId: 42, headSha: tool, url: 'https://example.invalid/run/42' };
  const receipt = { version: 1, sha, workflowRun: '42', workflowSha: tool, status, previousSha: sha,
    ...(status === 'DEPLOY_VERIFIED' ? { manifest: { sha } } : {}) };
  let request = '';
  const run = (program: string, args: string[]) => {
    calls.push({ program, args });
    if (program === 'git') return directory;
    if (args[0] === 'workflow') { request = args.find(value => value.startsWith('request_id='))!.slice(11); return ''; }
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify([{ ...workflow, displayTitle: `Publish ${sha} (${request})` }]);
    if (args[0] === 'api') return JSON.stringify({ id: 42, head_sha: tool, conclusion: 'success', run_attempt: 1,
      path: '.github/workflows/publish.yml', event: 'workflow_dispatch', head_branch: 'main', display_title: `Publish ${sha} (existing)`, html_url: workflow.url });
    if (args[0] === 'run' && args[1] === 'download') writeFileSync(path.join(args.at(-1)!, 'quiet-room-cloud-receipt.json'), JSON.stringify(receipt));
    if (args[0]?.endsWith('production-readback.mjs') && failReadback) throw new Error('backup still starting');
    return '';
  };
  return { run, calls, directory, workflow, receipt };
}

describe('efficient publishing without repeated cutovers', () => {
  it('prepares via doctor, saves request identity before dispatch, and only downloads the small receipt', () => {
    const f = fixture('PREFLIGHT_OK');
    publish(['--cloud', '--prepare', '--environment', 'production', '--sha', sha], f.run);
    const dispatch = f.calls.find(call => call.args[0] === 'workflow')!;
    expect(dispatch.args).toContain('mode=doctor');
    expect(f.calls.some(call => call.args[0] === 'clone')).toBe(false);
    expect(f.calls.some(call => call.args[0]?.endsWith('production-readback.mjs'))).toBe(false);
    const requests = readdirSync(path.join(f.directory, 'quiet-room-cloud-publish')).filter(name => name.endsWith('.json'));
    expect(requests).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(f.directory, 'quiet-room-cloud-publish', requests[0]), 'utf8'))).toMatchObject({ sha, mode: 'doctor', status: 'dispatched', workflowRun: 42 });
    const downloads = f.calls.filter(call => call.args[1] === 'download');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].args).toContain('quiet-room-cloud-receipt-42-1');
  });
  it.each(['DEPLOY_VERIFIED', 'ALREADY_DEPLOYED_READBACK_REQUIRED'])('continues independently after an exact receipt (%s)', status => {
    const f = fixture(status);
    publish(['--cloud', '--with-readback', '--environment', 'production', '--sha', sha], f.run);
    const last = f.calls.at(-1)!;
    expect(last.args[0]).toMatch(/production-readback.mjs$/);
    expect(last.args.slice(1)).toEqual(['--environment', 'production', '--sha', sha]);
    expect(f.calls.filter(call => call.args[0] === 'workflow')).toHaveLength(1);
  });
  it('only resumes the original workflow and never dispatches another production command', () => {
    const f = fixture();
    publish(['--cloud', '--resume', '42', '--sha', sha], f.run);
    expect(f.calls.some(call => call.args[0] === 'workflow' || call.args[1] === 'list')).toBe(false);
    expect(f.calls.some(call => call.args[1] === 'watch' && call.args[2] === '42')).toBe(true);
  });
  it('readback-only bypasses GitHub, CI, cloning and deployment entirely', () => {
    const f = fixture();
    publish(['--readback-only', '--environment', 'production', '--sha', sha], f.run);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].args[0]).toMatch(/production-readback.mjs$/);
  });
  it('stops after a failed readback and directs continuation to readback-only', () => {
    const f = fixture('DEPLOY_VERIFIED', true);
    expect(() => publish(['--cloud', '--with-readback', '--sha', sha], f.run)).toThrow('READBACK_REQUIRED');
    expect(f.calls.filter(call => call.args[0] === 'workflow')).toHaveLength(1);
    expect(f.calls.at(-1)!.args[0]).toMatch(/production-readback.mjs$/);
  });
  it('preserves a submitted request if dispatch response is lost, without retrying', () => {
    const f = fixture();
    let submissions = 0;
    expect(() => dispatchCloud(sha, (program: string, args: string[]) => {
      if (args[0] === 'workflow') { submissions++; throw new Error('lost response'); }
      return f.run(program, args);
    })).toThrow('lost response');
    expect(submissions).toBe(1);
    const base = path.join(f.directory, 'quiet-room-cloud-publish');
    expect(JSON.parse(readFileSync(path.join(base, readdirSync(base)[0]), 'utf8'))).toMatchObject({ sha, status: 'submitting' });
  });
  it('rejects cross-workflow, wrong-SHA and incompatible mode receipts', () => {
    const f = fixture('PREFLIGHT_OK');
    expect(() => verifyCloudReceipt(f.receipt, sha, f.workflow)).toThrow();
    expect(() => verifyCloudReceipt({ ...f.receipt, sha: tool }, sha, f.workflow, 'doctor')).toThrow();
    expect(() => verifyCloudReceipt({ ...f.receipt, workflowRun: '41' }, sha, f.workflow, 'doctor')).toThrow();
  });
  it.each([['--prepare'], ['--with-readback'], ['--cloud', '--readback-only'], ['--cloud', '--prepare', '--with-readback'], ['--resume', '42'], ['--cloud', '--resume', 'main']])('rejects incompatible flags %s before any calls', flags => {
    const f = fixture();
    expect(() => publish([...flags, '--sha', sha], f.run)).toThrow();
    expect(f.calls).toEqual([]);
  });
  it('requires an unexpired artifact bound to the exact successful CI run and attempt before preparation', () => {
    const ci = { id: 42, run_attempt: 2 };
    const artifact = { id: 7, name: `quiet-room-image-${sha}-2-amd64`, expired: false, workflow_run: { id: 42, head_sha: sha } };
    expect(findCIImageArtifact({ artifacts: [artifact] }, sha, ci)).toEqual(artifact);
    for (const change of [{ expired: true }, { name: `quiet-room-image-${sha}-1-amd64` }, { workflow_run: { id: 43, head_sha: sha } }]) {
      expect(() => findCIImageArtifact({ artifacts: [{ ...artifact, ...change }] }, sha, ci)).toThrow();
    }
  });
});

describe('early real-path preparation orchestration', () => {
  it.each([true, false])('tests the cloud path before CI and never downloads or deploys (CI ready=%s)', async ready => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-prepare-order-'));
    directories.push(directory);
    for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'zdaiwmm/shui-IM', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: tool, GITHUB_RUN_ID: '42', RUNNER_TEMP: directory, SAS_REGION_ID: production.region, SAS_INSTANCE_ID: production.instance, PUBLISH_MODE: 'doctor' })) vi.stubEnv(key, value);
    const trace: string[] = [];
    const run = (_program: string, args: string[]) => {
      trace.push(args[1]);
      if (args[1].includes('/compare/')) return JSON.stringify({ status: 'ahead', merge_base_commit: { sha: args[1].split('/compare/')[1].split('...')[0] } });
      if (args[1].includes('runs?')) return JSON.stringify({ workflow_runs: [{ id: 42, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: ready ? 'completed' : 'in_progress', conclusion: ready ? 'success' : null }] });
      if (args[1].includes('/jobs?')) return JSON.stringify({ jobs: [{ run_id: 42, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] });
      if (args[1].includes('/artifacts?')) return JSON.stringify({ artifacts: [{ id: 7, name: `quiet-room-image-${sha}-1-amd64`, expired: false, workflow_run: { id: 42, head_sha: sha } }] });
      throw new Error('Unexpected operation');
    };
    const invokeCommand = async (_script: string, label: string) => {
      trace.push(label);
      expect(label).toBe('preflight');
      return JSON.stringify({ imageProtocol: 1, expectedPreviousProtocol: 1, publicOrigin: production.origin }) + '\nLIVE_SHA=' + 'c'.repeat(40);
    };
    const operation = cloudPublish(sha, { doctor: true, run, invokeCommand });
    if (ready) {
      await operation;
      expect(JSON.parse(readFileSync(path.join(directory, 'quiet-room-cloud-receipt.json'), 'utf8'))).toMatchObject({ status: 'PREFLIGHT_OK', artifact: { id: 7, runId: 42 } });
    } else await expect(operation).rejects.toThrow('has not passed');
    expect(trace.indexOf('preflight')).toBeLessThan(trace.findIndex(item => item.includes('runs?')));
    expect(trace.some(item => item.includes('download') || item.includes('deploy-'))).toBe(false);
  });
});
