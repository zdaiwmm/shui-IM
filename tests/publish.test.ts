import { describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error Operational Node script has no TS declarations.
import { approvedCommit, selectRun, publish } from '../scripts/publish.mjs';

const sha = 'a'.repeat(40);
const good = { id: 42, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
const jobs = { jobs: [{ run_id: 42, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] };

describe('isolated non-GUI publishing', () => {
  it('requires explicit full SHA, never broad yes or an implicit latest release', () => {
    expect(approvedCommit(['--sha', sha])).toBe(sha);
    for (const args of [[], ['--yes'], ['--sha', 'main'], ['--sha', sha, '--force']]) expect(() => approvedCommit(args)).toThrow();
  });
  it('requires exact main push or manually dispatched CI and uses its latest run', () => {
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
  it.each([true, false])('waits for CI and requires an isolated release receipt (receipt=%s)', (hasReceipt) => {
    const calls: { program: string; args: string[]; options: Record<string, any> }[] = [];
    let directory = '';
    let ciReads = 0;
    try {
      const operation = () => publish(['--sha', sha], (program: string, args: string[], options: Record<string, any> = {}) => {
        calls.push({ program, args, options });
        if (args.includes('--jq')) return sha;
        if (args[0] === 'api' && args[1].includes('runs?')) return JSON.stringify([{ workflow_runs: [{ ...good, status: ++ciReads === 1 ? 'in_progress' : 'completed' }] }]);
        if (args[0] === 'api' && args[1].includes('/jobs?')) return JSON.stringify([jobs]);
        if (args[0] === 'clone') { directory = args.at(-1)!; mkdirSync(path.join(directory, '.git')); }
        if (args[0] === 'rev-parse') return sha;
        if (args[0] === 'config') return 'ssh -o BatchMode=yes';
        if (args.at(-2) === '--sha' && hasReceipt) writeFileSync(options.env.QUIET_ROOM_PUBLISH_RECEIPT, `${sha}\n`);
        return '';
      });
      if (hasReceipt) operation();
      else expect(operation).toThrow('without a verified live-SHA receipt');
      const watch = calls.findIndex(call => call.args[0] === 'run');
      const clone = calls.findIndex(call => call.args[0] === 'clone');
      expect(watch).toBeGreaterThan(0);
      expect(watch).toBeLessThan(clone);
      expect(calls[watch].args).toContain('--exit-status');
      expect(calls[watch].args.slice(-2)).toEqual(['--interval', '5']);
      expect(calls[clone].args.slice(0, 5)).toEqual(['clone', '--depth', '1', '--single-branch', '--branch']);
      expect(calls[clone].args.at(-2)).toBe('https://github.com/zdaiwmm/shui-IM.git');
      expect(calls[clone].options.env.GIT_CONFIG_VALUE_0).toBe('!gh auth git-credential');
      const deploy = calls.at(-1)!;
      expect(deploy.args.slice(-2)).toEqual(['--sha', sha]);
      expect(deploy.options.cwd).toBe(directory);
      expect(directory).toContain('quiet-room-publish-');
      expect(directory).toBe(realpathSync(directory));
      expect(calls.filter(call => call.args.includes('reset') || call.args.includes('stash'))).toEqual([]);
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
  it('stops before cloning when CI is green but complete application verification was skipped', () => {
    const calls: string[][] = [];
    expect(() => publish(['--sha', sha], (_program: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--jq')) return sha;
      if (args[1]?.includes('runs?')) return JSON.stringify([{ workflow_runs: [good] }]);
      if (args[1]?.includes('/jobs?')) return JSON.stringify([{ jobs: [{ ...jobs.jobs[0], conclusion: 'skipped' }] }]);
      return '';
    })).toThrow('Documentation-only CI cannot authorize release');
    expect(calls.some(args => args[0] === 'clone' || args.at(-2) === '--sha')).toBe(false);
  });
});
