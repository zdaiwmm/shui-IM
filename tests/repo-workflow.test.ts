import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { checkLocalReadiness, isCanonicalRemote, parseRemoteHead, validateBranch } from '../scripts/repo.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('fixed GitHub repository workflow', () => {
  it('checks both linked Git directories and missing tools without GitHub access', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'repo-local-check-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
      git('init', '-b', 'main');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture');
      const tree = path.join(directory, 'task');
      git('worktree', 'add', '-b', 'codex/fixture', tree);
      expect(() => checkLocalReadiness(tree)).toThrow('npm ci --include=dev');
      mkdirSync(path.join(tree, 'node_modules/.bin'), { recursive: true });
      for (const name of ['tsc', 'vite', 'vitest']) writeFileSync(path.join(tree, 'node_modules/.bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      expect(checkLocalReadiness(tree)).toEqual({ branch: 'codex/fixture', sha: git('rev-parse', 'HEAD') });
      for (const dir of [path.join(directory, '.git'), path.join(directory, '.git/worktrees/task')]) {
        expect(readdirSync(dir).filter(name => name.startsWith('quiet-room-write-check-'))).toEqual([]);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('accepts only the canonical HTTPS or SSH origin', () => {
    expect(isCanonicalRemote('https://github.com/zdaiwmm/shui-IM.git')).toBe(true);
    expect(isCanonicalRemote('git@github.com:zdaiwmm/shui-IM.git')).toBe(true);
    expect(isCanonicalRemote('https://github.com/other/repo.git')).toBe(false);
  });

  it('rejects unsafe branch names and verifies remote heads', () => {
    expect(validateBranch('codex/fix-thing')).toBe('codex/fix-thing');
    for (const branch of ['../main', '-bad', 'bad..name', 'bad@{x}', 'bad/']) expect(() => validateBranch(branch)).toThrow();
    expect(parseRemoteHead(`${'a'.repeat(40)}\trefs/heads/codex/fix-thing\n`, 'codex/fix-thing')).toBe('a'.repeat(40));
    expect(() => parseRemoteHead('not-a-head\trefs/heads/main\n', 'main')).toThrow();
  });
});
