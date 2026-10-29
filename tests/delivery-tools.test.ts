import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational script.
import { nextRelease, prepareRelease } from '../scripts/prepare-release.mjs';
// @ts-expect-error Operational script.
import { deliveryEvidence, executionFingerprint, reusableRecord, summarize, verificationContent } from '../scripts/delivery-evidence.mjs';

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

describe('local verification reuse', () => {
  const fingerprint = 'd'.repeat(64);
  const record = { version: 1, command: 'check:full', head: 'a'.repeat(40), tree: 'b'.repeat(40),
    clean: true, durationMs: 10, startedAt: '2026-10-27T00:00:00Z', result: 'passed', executionFingerprint: fingerprint };
  const select = (records: any[], head = record.head, tree = record.tree, environment = fingerprint) =>
    reusableRecord(records, record.command, head, tree, environment);
  it('requires exact command, commit, tree, clean state and execution environment', () => {
    expect(select([record])).toBe(record);
    expect(select([record], 'c'.repeat(40))).toBeUndefined();
    expect(select([record], record.head, 'c'.repeat(40))).toBeUndefined();
    expect(select([record], record.head, record.tree, 'e'.repeat(64))).toBeUndefined();
    for (const change of [{ clean: false }, { result: 'failed' }, { executionFingerprint: undefined }, { command: 'test' }]) {
      expect(select([{ ...record, ...change }])).toBeUndefined();
    }
    for (const change of [{ clean: false }, { result: 'failed' }, { result: 'interrupted' }, { executionFingerprint: undefined }]) {
      expect(select([record, { ...record, ...change }])).toBeUndefined();
    }
    expect(reusableRecord([{ ...record, command: 'deploy:production' }], 'deploy:production', record.head, record.tree, fingerprint)).toBeUndefined();
    expect(summarize([record], record.head, record.tree, fingerprint).checks[0].reusable).toBe(true);
  });
  it('executes once for ensure, forces explicit run, and invalidates after environment or tree changes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quiet-reuse-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const previousExitCode = process.exitCode;
    try {
      git('init', '-b', 'codex/fixture');
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: `node -e "require('fs').appendFileSync('.git/count', 'x')"` } }));
      git('add', 'package.json');
      git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'fixture');
      deliveryEvidence(['ensure', 'test'], root);
      deliveryEvidence(['ensure', 'test'], root);
      expect(readFileSync(path.join(root, '.git/count'), 'utf8')).toBe('x');
      deliveryEvidence(['run', 'test'], root);
      expect(readFileSync(path.join(root, '.git/count'), 'utf8')).toBe('xx');
      const originalFingerprint = executionFingerprint(root);
      expect(executionFingerprint(root, { ...process.env, QUIET_REUSE_FIXTURE: 'changed' })).not.toBe(originalFingerprint);
      writeFileSync(path.join(root, 'untracked'), 'new');
      deliveryEvidence(['ensure', 'test'], root);
      expect(readFileSync(path.join(root, '.git/count'), 'utf8')).toBe('xxx');
      expect(deliveryEvidence(['summary'], root).checks.every((check: any) => !check.reusable)).toBe(true);
    } finally { process.exitCode = previousExitCode; rmSync(root, { recursive: true, force: true }); }
  });
  it('ignores metadata-only touches while invalidating changed execution bytes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quiet-identity-'));
    try {
      mkdirSync(path.join(root, 'node_modules'));
      const lock = path.join(root, 'node_modules/.package-lock.json');
      writeFileSync(lock, '{"installed":1}');
      const before = executionFingerprint(root);
      utimesSync(lock, new Date('2020-01-01'), new Date('2020-01-01'));
      expect(executionFingerprint(root)).toBe(before);
      writeFileSync(lock, '{"installed":2}');
      expect(executionFingerprint(root)).not.toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reuses across independent CLI calls without forwarding orchestration IDs to the test', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quiet-cli-reuse-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init', '-b', 'codex/fixture');
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {
        test: `node -e "require('fs').appendFileSync('.git/count', process.env.CODEX_TOOL_CALL_ID ? 'leaked' : 'x')"`,
      } }));
      git('add', 'package.json');
      git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'fixture');
      const entry = new URL('../scripts/delivery-evidence.mjs', import.meta.url).pathname;
      const cli = (id: string) => execFileSync(process.execPath, [entry, 'ensure', 'test'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, CODEX_TOOL_CALL_ID: id },
      });
      expect(cli('first')).toContain('DELIVERY_EVIDENCE ');
      expect(cli('second')).toContain('DELIVERY_EVIDENCE_REUSED');
      expect(readFileSync(path.join(root, '.git/count'), 'utf8')).toBe('x');
      expect(executionFingerprint(root, { ...process.env, CODEX_TOOL_CALL_ID: 'first' }))
        .toBe(executionFingerprint(root, { ...process.env, CODEX_TOOL_CALL_ID: 'second' }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reuses across operational-document commits but reruns for contracts, runtime changes and non-regular documents', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quiet-doc-reuse-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = () => {
      git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture');
    };
    const previousExitCode = process.exitCode;
    try {
      git('init', '-b', 'codex/fixture');
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: `node -e "require('fs').appendFileSync('.git/count', 'x')"` } }));
      writeFileSync(path.join(root, 'AGENTS.md'), '# Workflow\n');
      writeFileSync(path.join(root, 'SECURITY.md'), '# Security contract\n');
      commit();
      const original = deliveryEvidence(['ensure', 'test'], root);
      const identity = verificationContent(root);
      writeFileSync(path.join(root, 'AGENTS.md'), '# Updated delivery record\n'); commit();
      expect(verificationContent(root)).toBe(identity);
      const reused = deliveryEvidence(['ensure', 'test'], root);
      expect(reused.head).toBe(original.head);
      expect(reused.head).not.toBe(git('rev-parse', 'HEAD'));
      expect(readFileSync(path.join(root, '.git/count'), 'utf8')).toBe('x');
      expect(deliveryEvidence(['summary'], root).checks[0].reusable).toBe(true);
      writeFileSync(path.join(root, 'SECURITY.md'), '# Changed security boundary\n'); commit();
      expect(verificationContent(root)).not.toBe(identity);
      deliveryEvidence(['ensure', 'test'], root);
      expect(readFileSync(path.join(root, '.git/count'), 'utf8')).toBe('xx');
      const contractIdentity = verificationContent(root);
      writeFileSync(path.join(root, 'runtime.mjs'), 'export const changed = true;\n'); commit();
      expect(verificationContent(root)).not.toBe(contractIdentity);
      const runtimeIdentity = verificationContent(root);
      git('rm', 'AGENTS.md');
      symlinkSync('SECURITY.md', path.join(root, 'AGENTS.md')); commit();
      expect(verificationContent(root)).not.toBe(runtimeIdentity);
    } finally { process.exitCode = previousExitCode; rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
  it('never falls back across a newer failed check even when only operational documents changed', () => {
    const content = 'e'.repeat(64);
    const previous = { ...record, verificationContent: content };
    const currentHead = 'f'.repeat(40), currentTree = 'c'.repeat(40);
    expect(reusableRecord([previous], record.command, currentHead, currentTree, fingerprint, content)).toBe(previous);
    expect(reusableRecord([previous], record.command, currentHead, currentTree, fingerprint, 'f'.repeat(64))).toBeUndefined();
    for (const change of [{ result: 'failed' }, { result: 'interrupted' }, { clean: false }, { executionFingerprint: undefined }]) {
      expect(reusableRecord([previous, { ...previous, ...change }], record.command, currentHead, currentTree, fingerprint, content)).toBeUndefined();
    }
  });
});
