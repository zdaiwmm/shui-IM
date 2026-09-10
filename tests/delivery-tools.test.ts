import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational script.
import { nextRelease, prepareRelease } from '../scripts/prepare-release.mjs';
// @ts-expect-error Operational script.
import { summarize } from '../scripts/delivery-evidence.mjs';

const current = { id: '2026.09.10.2', title: '版本更新', notes: ['existing'], createdAt: '2026-09-10T09:00:00Z' };
describe('release preparation', () => {
  it('allocates after every existing same-day ID, preserves old records and strips milliseconds', () => {
    const old = { ...current, id: '2026.09.10.8' };
    const result = nextRelease(current, [old], [' change ', 'change'], new Date('2026-09-10T10:00:00.123Z'));
    expect(result.release.id).toBe('2026.09.10.9');
    expect(result.release.createdAt).toBe('2026-09-10T10:00:00Z');
    expect(result.release.notes).toEqual(['change']);
    expect(result.history).toEqual([old, current]);
    expect(() => nextRelease(current, [current], ['change'])).toThrow();
    expect(() => nextRelease(current, [], [''])).toThrow();
  });
  it('previews without edits, applies idempotently and rejects changed sources or HEAD', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quiet-prepare-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init', '-b', 'codex/fixture');
      writeFileSync(path.join(root, 'release.json'), JSON.stringify(current));
      writeFileSync(path.join(root, 'release-history.json'), '[]');
      git('add', 'release.json', 'release-history.json');
      git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'fixture');
      const head = git('rev-parse', 'HEAD');
      const notes = path.join(root, 'notes.json'); writeFileSync(notes, '["new"]');
      const plan = prepareRelease(['--base', head, '--notes', notes], root);
      expect(JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8'))).toEqual(current);
      const { createHash } = require('node:crypto');
      const file = path.join(root, '.git/quiet-room-release-plan', createHash('sha256').update(JSON.stringify(plan)).digest('hex') + '.json');
      prepareRelease(['--base', head, '--apply', file], root);
      prepareRelease(['--base', head, '--apply', file], root);
      expect(JSON.parse(readFileSync(path.join(root, 'release-history.json'), 'utf8'))).toEqual([current]);
      writeFileSync(path.join(root, 'release.json'), '{}');
      expect(() => prepareRelease(['--base', head, '--apply', file], root)).toThrow('changed');
      expect(() => prepareRelease(['--base', 'a'.repeat(40), '--apply', file], root)).toThrow('expected task HEAD');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
it('reports stale or dirty checks without granting CI, merge, production or device acceptance', () => {
  const record = { version: 1, command: 'test', head: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true, durationMs: 10, startedAt: '2026-09-10T00:00:00Z', result: 'passed', token: 'must not persist' };
  const result = summarize([record, { ...record, clean: false }, { ...record, command: 'deploy:production' }], record.head, record.tree);
  expect(result.checks).toHaveLength(2);
  expect(result.checks.map((r: any) => r.applicable)).toEqual([true, false]);
  expect(JSON.stringify(result)).not.toContain('must not persist');
  expect(summarize([record], record.head, 'c'.repeat(40)).checks[0].applicable).toBe(false);
  expect(result.production).toBe('not queried');
  expect(result.realDevice).toBe('not verified');
});
