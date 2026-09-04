import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { requireSuccessfulCI, validateConfig } from '../scripts/release.mjs';

const sha = 'a'.repeat(40);
const run = { id: 1, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/1' };

describe('release entry point', () => {
  it('accepts only exact successful main CI', () => {
    expect(requireSuccessfulCI({ workflow_runs: [run] }, sha)).toBe(run.html_url);
    for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
      expect(() => requireSuccessfulCI({ workflow_runs: [{ ...run, ...change }] }, sha)).toThrow();
    }
    expect(() => requireSuccessfulCI({}, sha)).toThrow();
  });
  it('does not accept an old green run when a newer run is pending or failed', () => {
    for (const change of [{ status: 'queued' }, { conclusion: 'failure' }]) {
      expect(() => requireSuccessfulCI({ workflow_runs: [run, { ...run, id: 2, ...change }] }, sha)).toThrow();
    }
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
});
