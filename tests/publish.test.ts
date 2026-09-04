import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
// @ts-expect-error Operational Node script has no TS declarations.
import { approvedCommit, selectRun, publish } from '../scripts/publish.mjs';

const sha = 'a'.repeat(40);
const good = { id: 42, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };

describe('isolated non-GUI publishing', () => {
  it('requires explicit full SHA, never broad yes or an implicit latest release', () => {
    expect(approvedCommit(['--sha', sha])).toBe(sha);
    for (const args of [[], ['--yes'], ['--sha', 'main'], ['--sha', sha, '--force']]) expect(() => approvedCommit(args)).toThrow();
  });
  it('requires exact main push CI and uses its latest run', () => {
    expect(selectRun({ workflow_runs: [good] }, sha)).toEqual(good);
    for (const change of [{ event: 'pull_request' }, { head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }, { path: 'other.yml' }, { conclusion: 'failure' }, { id: '42;command' }]) {
      expect(() => selectRun({ workflow_runs: [{ ...good, ...change }] }, sha)).toThrow();
    }
    expect(() => selectRun({ workflow_runs: [good, { ...good, id: 43, conclusion: 'cancelled' }] }, sha)).toThrow();
    expect(selectRun({ workflow_runs: [{ ...good, status: 'in_progress', conclusion: null }] }, sha).id).toBe(42);
  });
  it('stops before cloning or deploying if main advanced', () => {
    const calls: string[] = [];
    expect(() => publish(['--sha', sha], (program: string) => {
      calls.push(program);
      return program === 'gh' ? 'b'.repeat(40) : '';
    })).toThrow('not the current GitHub main');
    expect(calls).toHaveLength(2);
    expect(calls).not.toContain('git');
  });
  it('does not clone or deploy when preflight fails', () => {
    let calls = 0;
    expect(() => publish(['--sha', sha], () => { calls++; throw new Error('SSH unavailable'); })).toThrow('SSH unavailable');
    expect(calls).toBe(1);
  });
  it('waits for CI and deploys only from the isolated, exact clone', () => {
    const calls: { program: string; args: string[]; options: Record<string, any> }[] = [];
    let directory = '';
    try {
      publish(['--sha', sha], (program: string, args: string[], options = {}) => {
        calls.push({ program, args, options });
        if (args.includes('--jq')) return sha;
        if (args[0] === 'api' && args[1].includes('runs?')) return JSON.stringify({ workflow_runs: [{ ...good, status: 'in_progress' }] });
        if (args[0] === 'clone') directory = args.at(-1)!;
        if (args[0] === 'rev-parse') return sha;
        if (args[0] === 'config') return 'ssh -o BatchMode=yes';
        return '';
      });
      const watch = calls.findIndex(call => call.args[0] === 'run');
      const clone = calls.findIndex(call => call.args[0] === 'clone');
      expect(watch).toBeGreaterThan(0);
      expect(watch).toBeLessThan(clone);
      expect(calls[watch].args).toContain('--exit-status');
      const deploy = calls.at(-1)!;
      expect(deploy.args.slice(-2)).toEqual(['--sha', sha]);
      expect(deploy.options.cwd).toBe(directory);
      expect(directory).toContain('quiet-room-publish-');
      expect(calls.filter(call => call.args.includes('reset') || call.args.includes('stash'))).toEqual([]);
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
});
