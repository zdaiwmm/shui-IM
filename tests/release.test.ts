import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { requireSuccessfulCI, validateConfig } from '../scripts/release.mjs';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { verifySuccessfulCI } from '../scripts/release-ci.mjs';

const sha = 'a'.repeat(40);
const run = { id: 1, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/1' };
const fullJob = { run_id: run.id, head_sha: sha, name: 'Full application verification', status: 'completed', conclusion: 'success' };
const jobs = { jobs: [fullJob] };

describe('release entry point', () => {
  it('accepts only exact successful main CI', () => {
    expect(requireSuccessfulCI({ workflow_runs: [run] }, sha, jobs)).toBe(run.html_url);
    expect(requireSuccessfulCI({ workflow_runs: [{ ...run, event: 'workflow_dispatch' }] }, sha, jobs)).toBe(run.html_url);
    for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
      expect(() => requireSuccessfulCI({ workflow_runs: [{ ...run, ...change }] }, sha, jobs)).toThrow();
    }
    expect(() => requireSuccessfulCI({}, sha)).toThrow();
  });
  it('does not accept an old green run when a newer run is pending or failed', () => {
    for (const change of [{ status: 'queued' }, { conclusion: 'failure' }]) {
      expect(() => requireSuccessfulCI({ workflow_runs: [run, { ...run, id: 2, event: 'workflow_dispatch', ...change }] }, sha, jobs)).toThrow();
    }
  });
  it('refuses green documentation-only runs, skipped gates and unrelated job evidence', () => {
    for (const changedJobs of [[], [{ ...fullJob, conclusion: 'skipped' }], [{ ...fullJob, status: 'in_progress' }],
      [{ ...fullJob, run_id: 99 }], [{ ...fullJob, head_sha: 'b'.repeat(40) }], [{ ...fullJob, name: 'verify' }], [fullJob, fullJob]]) {
      expect(() => requireSuccessfulCI({ workflow_runs: [run] }, sha, { jobs: changedJobs })).toThrow('Full application verification');
    }
  });
  it('reads all job pages for the latest run attempt, without accepting an older attempt', () => {
    const calls: string[][] = [];
    expect(verifySuccessfulCI((_program: string, args: string[]) => {
      calls.push(args);
      if (args[1].includes('/workflows/')) return JSON.stringify([{ workflow_runs: [run] }]);
      return JSON.stringify([{ jobs: Array.from({ length: 100 }, (_, id) => ({ ...fullJob, name: `Other ${id}` })) }, jobs]);
    }, sha)).toBe(run.html_url);
    expect(calls[1][1]).toContain('/runs/1/attempts/2/jobs?per_page=100');
    expect(calls.every(args => args.includes('--paginate') && args.includes('--slurp'))).toBe(true);
    expect(() => verifySuccessfulCI(() => JSON.stringify([{ workflow_runs: [{ ...run, run_attempt: '2/invalid' }] }]), sha)).toThrow('Invalid CI run attempt');
  });
  it.each([{ run_attempt: 3 }, { id: 2 }, { status: 'in_progress' }, { conclusion: 'failure' }])('rejects CI changing while job evidence is fetched: %s', (change) => {
    let reads = 0;
    expect(() => verifySuccessfulCI((_program: string, args: string[]) => {
      if (args[1].includes('/workflows/')) return JSON.stringify([{ workflow_runs: [{ ...run, ...(reads++ ? change : {}) }] }]);
      return JSON.stringify([jobs]);
    }, sha)).toThrow();
  });
  it('rejects shell options, remote command injection, and relative key paths', () => {
    const config = { serverHost: 'example.com', serverUser: 'admin', serverKey: '/tmp/key with spaces' };
    expect(validateConfig(config)).toEqual(config);
    for (const change of [{ serverHost: '-oProxyCommand=bad' }, { serverHost: 'host;bad' }, { serverUser: 'admin;bad' }, { serverKey: 'relative' }, { githubKey: 'relative' }]) {
      expect(() => validateConfig({ ...config, ...change })).toThrow();
    }
  });
  it('provides help without credentials or network and rejects broad yes flags', () => {
    const help = spawnSync('bash', ['scripts/deploy-production.sh', '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--sha');
    for (const args of [['--yes'], ['--sha', 'main'], ['--doctor', '--yes']]) {
      const result = spawnSync('bash', ['scripts/deploy-production.sh', ...args], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid arguments');
    }
  });
  it('executes help and argument validation through aliased directory and script paths', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-release-entry-'));
    try {
      symlinkSync(path.resolve('.'), path.join(directory, 'repo'), 'dir');
      symlinkSync(path.resolve('scripts/release.mjs'), path.join(directory, 'release-link.mjs'));
      for (const entry of [path.join(directory, 'repo/scripts/release.mjs'), path.join(directory, 'release-link.mjs')]) {
        const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('--sha');
        const invalid = spawnSync(process.execPath, [entry, '--sha', 'main'], { encoding: 'utf8' });
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain('Invalid arguments');
      }
      const publish = spawnSync(process.execPath, [path.join(directory, 'repo/scripts/publish.mjs'), '--yes'], { encoding: 'utf8' });
      expect(publish.status).toBe(1);
      expect(publish.stderr).toContain('PUBLISH_BLOCKED');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
