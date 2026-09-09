import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational Node script has no TS declarations.
import { determineScope, parseChangedPaths, requireVerification } from '../scripts/ci-scope.mjs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function repository() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'quiet-room-ci-scope-'));
  directories.push(cwd);
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'CI test']);
  git(['config', 'user.email', 'ci-test@example.invalid']);
  const write = (file: string, content: string) => { mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); writeFileSync(path.join(cwd, file), content); };
  const commit = () => { git(['add', '.']); git(['commit', '-qm', 'Synthetic CI fixture']); return git(['rev-parse', 'HEAD']).trim(); };
  write('RELEASING.md', '# Release\n');
  write('docs/context/status.md', '# Status\n');
  write('src/example.ts', 'export const example = 1;\n');
  const before = commit();
  const scope = (after: string, changes = {}) => determineScope({
    eventName: 'push', event: { before, after, ref: 'refs/heads/main', ...changes }, runGit: git,
  });
  return { cwd, git, write, commit, before, scope };
}

describe('CI documentation scope', () => {
  it('uses only a verified main push range and a strict documentation allowlist', () => {
    const repo = repository();
    repo.write('docs/context/status.md', '# Updated status\n');
    const after = repo.commit();
    expect(repo.scope(after).mode).toBe('docs');
    for (const change of [{ before: '0'.repeat(40) }, { before: 'f'.repeat(40) }, { after: 'f'.repeat(40) },
      { ref: 'refs/heads/feature' }, { forced: true }, { deleted: true }]) expect(repo.scope(after, change).mode).toBe('full');
  });

  it('falls back to full verification for empty changes, unavailable events and manual runs', () => {
    const repo = repository();
    expect(repo.scope(repo.before).mode).toBe('full');
    for (const eventName of ['workflow_dispatch', 'schedule', 'unknown', undefined]) {
      expect(determineScope({ eventName, event: {}, runGit: repo.git }).mode).toBe('full');
    }
    expect(determineScope({ eventName: 'push', event: null, runGit: repo.git }).mode).toBe('full');
    expect(determineScope({ eventName: 'pull_request', event: {}, runGit: repo.git }).mode).toBe('full');
  });

  it('never treats product/security documents, new context paths or configuration as light changes', () => {
    const repo = repository();
    for (const file of ['SECURITY.md', 'PRODUCT.md', 'README.md', 'docs/context/new.md', '.github/workflows/ci.yml', 'scripts/example.mjs']) {
      repo.write(file, '# Fixture\n');
      expect(repo.scope(repo.commit()).mode).toBe('full');
    }
  });

  it('includes deleted code and both sides of renamed files', () => {
    const removed = repository();
    rmSync(path.join(removed.cwd, 'src/example.ts'));
    expect(removed.scope(removed.commit()).mode).toBe('full');
    const renamed = repository();
    renameSync(path.join(renamed.cwd, 'src/example.ts'), path.join(renamed.cwd, 'docs/context/maintenance.md'));
    const after = renamed.commit();
    const changes = renamed.git(['diff', '--name-status', '-z', '--find-renames', `${renamed.before}..${after}`]);
    expect(parseChangedPaths(changes)).toContain('src/example.ts');
    expect(renamed.scope(after).mode).toBe('full');
  });

  it('recognizes allowlisted deletions while leaving broken inbound links to documentation checks', () => {
    const repo = repository();
    rmSync(path.join(repo.cwd, 'docs/context/status.md'));
    expect(repo.scope(repo.commit()).mode).toBe('docs');
  });

  it('compares the whole PR against its merge base rather than only the last commit', () => {
    const repo = repository();
    repo.git(['checkout', '-qb', 'feature']);
    repo.write('src/example.ts', 'export const example = 2;\n');
    repo.commit();
    repo.write('docs/context/status.md', '# Last commit is only documentation\n');
    const proposed = repo.commit();
    const event = { pull_request: { base: { sha: repo.before }, head: { sha: proposed } } };
    expect(determineScope({ eventName: 'pull_request', event, runGit: repo.git }).mode).toBe('full');
  });

  it('handles normal GitHub PR merge checkouts and rejects a checkout missing the proposed head', () => {
    const repo = repository();
    repo.git(['checkout', '-qb', 'feature']);
    repo.write('docs/context/status.md', '# PR note\n');
    const proposed = repo.commit();
    repo.git(['checkout', '-q', 'main']);
    repo.write('src/example.ts', 'export const example = 3;\n');
    const base = repo.commit();
    const event = { pull_request: { base: { sha: base }, head: { sha: proposed } } };
    expect(determineScope({ eventName: 'pull_request', event, runGit: repo.git }).mode).toBe('full');
    repo.git(['merge', '--no-ff', '-qm', 'Synthetic merge', 'feature']);
    expect(determineScope({ eventName: 'pull_request', event, runGit: repo.git }).mode).toBe('docs');
  });

  it('does not infer success from corrupt, unknown or truncated diff output', () => {
    for (const output of ['', 'M\0RELEASING.md', 'M\0', 'T\0RELEASING.md\0', 'R100\0old\0', 'X\0RELEASING.md\0']) {
      expect(() => parseChangedPaths(output)).toThrow();
    }
    expect(parseChangedPaths('R100\0src/old.ts\0RELEASING.md\0D\0src/deleted.ts\0')).toEqual(['src/old.ts', 'RELEASING.md', 'src/deleted.ts']);
    expect(parseChangedPaths('M\0src/name\nwith-newline.ts\0')).toEqual(['src/name\nwith-newline.ts']);
    for (const output of ['M\0../RELEASING.md\0', 'M\0/RELEASING.md\0']) expect(() => parseChangedPaths(output)).toThrow();
  });

  it('falls back to full when any Git comparison fails or documentation changes file type', () => {
    const sha = 'a'.repeat(40);
    const event = { before: 'b'.repeat(40), after: sha, ref: 'refs/heads/main' };
    const valid = (args: string[]) => args[0] === 'rev-parse' ? `${sha}\n` : args[0] === 'diff' ? 'M\0RELEASING.md\0' : args[0] === 'ls-tree' ? `100644 blob ${sha}\tRELEASING.md\0` : '';
    for (const failing of ['rev-parse', 'merge-base', 'diff', 'ls-tree']) {
      const runGit = (args: string[]) => { if (args[0] === failing) throw new Error('Synthetic unavailable history'); return valid(args); };
      expect(determineScope({ eventName: 'push', event, runGit }).mode).toBe('full');
    }
    const runGit = (args: string[]) => args[0] === 'ls-tree' ? `120000 blob ${sha}\tRELEASING.md\0` : valid(args);
    expect(determineScope({ eventName: 'push', event, runGit }).mode).toBe('full');
  });
});

function results(mode = 'full'): Record<string, { result: string; outputs?: { mode: string } }> {
  return {
    scope: { result: 'success', outputs: { mode } }, docs: { result: 'success' }, secret_scan: { result: 'success' },
    ...Object.fromEntries(['build', 'browser', 'calls', 'audit'].map(name => [name, { result: mode === 'full' ? 'success' : 'skipped' }])),
  };
}

describe('CI verification summaries', () => {
  it('accepts complete full coverage and the expected documentation-only job shape', () => {
    expect(requireVerification(results())).toBe('full');
    expect(requireVerification(results(), 'full')).toBe('full');
    expect(requireVerification(results('docs'))).toBe('docs');
    expect(() => requireVerification(results('docs'), 'full')).toThrow();
  });

  it('rejects every missing, failed, cancelled or unexpectedly skipped required job', () => {
    for (const gate of ['verify', 'full']) {
      const required = ['scope', 'docs', 'secret_scan', 'build', 'browser', 'calls', 'audit'];
      for (const name of required) {
        for (const result of ['failure', 'cancelled', 'skipped', 'unknown']) {
          const needs = results(); needs[name].result = result;
          expect(() => requireVerification(needs, gate)).toThrow();
        }
        const needs = results(); delete needs[name];
        expect(() => requireVerification(needs, gate)).toThrow();
      }
    }
  });

  it('requires documentation and credential checks even when application jobs are intentionally skipped', () => {
    for (const name of ['scope', 'docs', 'secret_scan']) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        const needs = results('docs'); needs[name].result = result;
        expect(() => requireVerification(needs)).toThrow();
      }
    }
    for (const name of ['build', 'browser', 'calls', 'audit']) {
      for (const result of ['success', 'failure', 'cancelled']) {
        const needs = results('docs'); needs[name].result = result;
        expect(() => requireVerification(needs)).toThrow();
      }
      const needs = results('docs'); delete needs[name];
      expect(() => requireVerification(needs)).toThrow();
    }
  });

  it('rejects missing or unknown scope and invalid summary formats', () => {
    for (const needs of [undefined, null, [], {}, results('unknown')]) expect(() => requireVerification(needs)).toThrow();
    expect(() => requireVerification(results(), 'unknown')).toThrow();
  });
});
