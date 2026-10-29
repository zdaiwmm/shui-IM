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
  it('stops before cloning or deploying for an invalid main identity', () => {
    const calls: string[] = [];
    expect(() => publish(['--sha', sha], (program: string) => {
      calls.push(program);
      return program === 'gh' ? 'invalid' : '';
    })).toThrow('Invalid GitHub main identity');
    expect(calls).toHaveLength(2);
    expect(calls).not.toContain('git');
  });
  it.each(['behind', 'diverged', 'unknown'])('rejects a batch outside main (%s)', status => {
    const calls: string[][] = [];
    expect(() => publish(['--sha', sha], (_program: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--jq')) return 'b'.repeat(40);
      return JSON.stringify({ status, merge_base_commit: { sha } });
    })).toThrow('not an ancestor');
    expect(calls.some(args => args[0] === 'clone')).toBe(false);
  });
  it('does not clone or deploy when preflight fails', () => {
    let calls = 0;
    expect(() => publish(['--sha', sha], () => { calls++; throw new Error('SSH unavailable'); })).toThrow('SSH unavailable');
    expect(calls).toBe(1);
  });
  it('bounds a slow clone to ten minutes and stops before deployment if it expires', () => {
    const calls: { args: string[]; options: Record<string, any> }[] = [];
    let directory = '';
    try {
      expect(() => publish(['--sha', sha], (_program: string, args: string[], options: Record<string, any> = {}) => {
        calls.push({ args, options });
        if (args.includes('--jq')) return sha;
        if (args[1]?.includes('/compare/')) return JSON.stringify({ status: 'identical', merge_base_commit: { sha } });
        if (args[1]?.includes('runs?')) return JSON.stringify([{ workflow_runs: [good] }]);
        if (args[1]?.includes('/jobs?')) return JSON.stringify([jobs]);
        if (args[0] === 'clone') {
          directory = args.at(-1)!;
          throw new Error('git: spawnSync git ETIMEDOUT');
        }
        return '';
      })).toThrow('git: spawnSync git ETIMEDOUT');
      const clones = calls.filter(call => call.args[0] === 'clone');
      expect(clones).toHaveLength(1);
      expect(clones[0].options.timeout).toBe(600000);
      expect(calls[0].options.timeout).toBe(120000);
      expect(calls.some(call => call.args.at(-2) === '--sha')).toBe(false);
      expect(calls.some(call => call.args[0] === 'checkout')).toBe(false);
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([[true, false], [false, false], [true, true]])('waits for CI and requires an isolated receipt (receipt=%s, cache=%s)', (hasReceipt, cacheImages) => {
    const calls: { program: string; args: string[]; options: Record<string, any> }[] = [];
    let directory = '';
    let ciReads = 0;
    try {
      const operation = () => publish([...(cacheImages ? ['--cache-images'] : []), '--sha', sha], (program: string, args: string[], options: Record<string, any> = {}) => {
        calls.push({ program, args, options });
        if (args.includes('--jq')) return 'b'.repeat(40);
        if (args[1]?.includes('/compare/')) return JSON.stringify({ status: 'ahead', merge_base_commit: { sha } });
        if (args[0] === 'api' && args[1].includes('runs?')) return JSON.stringify([{ workflow_runs: [{ ...good, status: ++ciReads === 1 ? 'in_progress' : 'completed' }] }]);
        if (args[0] === 'api' && args[1].includes('/jobs?')) return JSON.stringify([jobs]);
        if (args[0] === 'clone') { directory = args.at(-1)!; mkdirSync(path.join(directory, '.git')); }
        if (args[0] === 'rev-parse') return args.includes('--git-common-dir') ? '/synthetic/git-common' : sha;
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
      expect(calls[clone].args.slice(0, 4)).toEqual(['clone', '--filter=blob:none', '--single-branch', '--branch']);
      expect(calls[clone].args.at(-2)).toBe('https://github.com/zdaiwmm/shui-IM.git');
      expect(calls[clone].options.env.GIT_CONFIG_VALUE_0).toBe('!gh auth git-credential');
      const deploy = calls.at(-1)!;
      expect(deploy.args.slice(-2)).toEqual(['--sha', sha]);
      expect(deploy.options.cwd).toBe(directory);
      expect(deploy.options.env.QUIET_ROOM_CI_IMAGE_CACHE).toBe(cacheImages ? '/synthetic/git-common/quiet-room-ci-image-cache-v1' : process.env.QUIET_ROOM_CI_IMAGE_CACHE);
      expect(calls.some(call => call.args.join(' ') === `checkout -B main ${sha}` && call.options.cwd === directory
        && call.options.env.GIT_CONFIG_VALUE_0 === '!gh auth git-credential')).toBe(true);
      expect(calls.some(call => call.args.join(' ') === `merge-base --is-ancestor ${sha} origin/main`)).toBe(true);
      expect(directory).toContain('quiet-room-publish-');
      expect(directory).toBe(realpathSync(directory));
      expect(calls.filter(call => call.args.includes('reset') || call.args.includes('stash'))).toEqual([]);
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(['--cloud', '--readback-only', '--cache-images'])('rejects an incompatible or duplicate cache option: %s', flag => {
    expect(() => publish(['--cache-images', flag, '--sha', sha], () => { throw new Error('Must stop before I/O'); })).toThrow(/Image cache requires direct publishing|Duplicate image cache flag/);
  });
  it('stops before cloning when CI is green but complete application verification was skipped', () => {
    const calls: string[][] = [];
    expect(() => publish(['--sha', sha], (_program: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--jq')) return 'b'.repeat(40);
        if (args[1]?.includes('/compare/')) return JSON.stringify({ status: 'ahead', merge_base_commit: { sha } });
      if (args[1]?.includes('runs?')) return JSON.stringify([{ workflow_runs: [good] }]);
      if (args[1]?.includes('/jobs?')) return JSON.stringify([{ jobs: [{ ...jobs.jobs[0], conclusion: 'skipped' }] }]);
      return '';
    })).toThrow('Documentation-only CI cannot authorize release');
    expect(calls.some(args => args[0] === 'clone' || args.at(-2) === '--sha')).toBe(false);
  });
});
