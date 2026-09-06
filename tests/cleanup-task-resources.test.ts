import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Operational script has no declaration file.
import { cleanup, processCheck } from '../scripts/cleanup-task-resources.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'quiet-cleanup-'))); dirs.push(root);
  const repo = path.join(root, 'repo'), target = path.join(root, 'task'), remote = path.join(root, 'origin.git');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  git('add', '.gitignore'); git('commit', '-m', 'base');
  git('init', '--bare', remote); git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  git('worktree', 'add', '-b', 'codex/task', target, 'main');
  const head = git('rev-parse', 'HEAD');
  const evidence = path.join(root, 'reviewed-evidence.txt'); writeFileSync(evidence, 'Fixture release/readback/context evidence\n');
  const plan = { version: 1, repository: repo, releaseSha: head, reviewedAt: new Date().toISOString(),
    releaseVerified: true, readbackVerified: true, contextSynced: true,
    evidence: { path: evidence, sha256: createHash('sha256').update(readFileSync(evidence)).digest('hex') },
    items: [{ path: target, branch: 'codex/task', head, ownerReleased: true, evidenceSaved: true }] };
  const check = (apply = false, probeProcesses = () => null) => cleanup(plan, { apply, probeProcesses });
  return { root, repo, target, git, plan, check };
}

describe('task cleanup safety and execution', () => {
  it('defaults to check-only, removes an exact merged worktree and branch, and supports repeat execution', () => {
    const f = fixture();
    expect(f.check().items[0].status).toBe('eligible'); expect(existsSync(f.target)).toBe(true);
    expect(f.check(true).items[0].status).toBe('cleaned'); expect(existsSync(f.target)).toBe(false);
    expect(f.git('branch', '--list', 'codex/task')).toBe('');
    expect(f.check(true).items[0].status).toBe('absent');
    expect(existsSync(path.join(f.repo, '.git', 'quiet-room-task-cleanup'))).toBe(true);
  });
  it.each(['untracked', 'ignored', 'tracked', 'staged'])('retains %s content', kind => {
    const f = fixture();
    if (kind === 'ignored') { mkdirSync(path.join(f.target, 'ignored')); writeFileSync(path.join(f.target, 'ignored', 'evidence'), 'keep'); }
    else if (kind === 'tracked') writeFileSync(path.join(f.target, '.gitignore'), 'changed');
    else { writeFileSync(path.join(f.target, 'note'), 'keep'); if (kind === 'staged') f.git('-C', f.target, 'add', 'note'); }
    expect(f.check(true).items[0].reason).toBe('WORKTREE_HAS_FILES_OR_CHANGES'); expect(existsSync(f.target)).toBe(true);
  });
  it('retains active or unprobeable resources and missing owner release', () => {
    const f = fixture();
    expect(f.check(true, () => 'OPEN_FILES_OR_PROCESSES').items[0].reason).toBe('OPEN_FILES_OR_PROCESSES');
    expect(f.check(true, () => 'PROCESS_CHECK_UNAVAILABLE').items[0].reason).toBe('PROCESS_CHECK_UNAVAILABLE');
    f.plan.items[0].ownerReleased = false;
    expect(f.check(true).items[0].reason).toBe('OWNER_RELEASE_REQUIRED');
  });
  it('retains locked worktrees and private Git metadata', () => {
    const f = fixture(); f.git('worktree', 'lock', f.target);
    expect(f.check(true).items[0].reason).toBe('WORKTREE_LOCKED_OR_STALE');
    f.git('worktree', 'unlock', f.target);
    const admin = f.git('-C', f.target, 'rev-parse', '--absolute-git-dir'); writeFileSync(path.join(admin, 'release-receipt'), 'keep');
    expect(f.check(true).items[0].reason).toBe('WORKTREE_METADATA_REQUIRES_REVIEW');
  });
  it('rejects protected directories, symlink targets, duplicate targets and stale review', () => {
    const f = fixture(); const item = { ...f.plan.items[0] };
    f.plan.items[0].path = f.repo; expect(() => f.check(true)).toThrow('PROTECTED_PATH');
    const alias = path.join(f.root, 'alias'); symlinkSync(f.target, alias); f.plan.items[0].path = alias;
    expect(() => f.check(true)).toThrow('NONCANONICAL_TARGET');
    f.plan.items = [item, { ...item }]; expect(() => f.check(true)).toThrow('DUPLICATE_TARGET');
    f.plan.items = [item]; f.plan.reviewedAt = '2000-01-01'; expect(() => f.check(true)).toThrow('REVIEW_EXPIRED');
  });
  it('rejects changed evidence and missing release review', () => {
    const f = fixture(); writeFileSync(f.plan.evidence.path, 'changed'); expect(() => f.check(true)).toThrow('EVIDENCE_CHANGED');
    f.plan.releaseVerified = false; expect(() => f.check(true)).toThrow('REVIEW_REQUIRED');
  });
  it('retains moved branch heads and worktrees on other branches', () => {
    const f = fixture(); f.git('-C', f.target, 'commit', '--allow-empty', '-m', 'new');
    expect(f.check(true).items[0].reason).toBe('BRANCH_MOVED');
  });
  it('retains a clean but unmerged commit', () => {
    const f = fixture(); f.git('-C', f.target, 'commit', '--allow-empty', '-m', 'unmerged');
    f.plan.items[0].head = f.git('-C', f.target, 'rev-parse', 'HEAD');
    expect(f.check(true).items[0].reason).toBe('NOT_IN_RELEASE');
  });
  it('accepts a squash mapping only with identical complete trees', () => {
    const f = fixture(); writeFileSync(path.join(f.target, 'feature'), 'yes'); f.git('-C', f.target, 'add', 'feature'); f.git('-C', f.target, 'commit', '-m', 'feature');
    f.plan.items[0].head = f.git('-C', f.target, 'rev-parse', 'HEAD');
    f.git('merge', '--squash', 'codex/task'); f.git('commit', '-m', 'squashed'); f.git('push', 'origin', 'main');
    f.plan.releaseSha = f.git('rev-parse', 'HEAD'); Object.assign(f.plan.items[0], { integratedCommit: f.plan.releaseSha });
    expect(f.check().items[0].status).toBe('eligible');
    expect(f.check(true).items[0].status).toBe('cleaned');
  });
  it('rejects an integration mapping whose tree differs', () => {
    const f = fixture(); writeFileSync(path.join(f.target, 'feature'), 'no'); f.git('-C', f.target, 'add', 'feature'); f.git('-C', f.target, 'commit', '-m', 'unmerged');
    f.plan.items[0].head = f.git('-C', f.target, 'rev-parse', 'HEAD'); Object.assign(f.plan.items[0], { integratedCommit: f.plan.releaseSha });
    expect(f.check(true).items[0].reason).toBe('INTEGRATION_TREE_MISMATCH');
  });
  it('deletes only an explicitly reviewed remote branch and retains a changed remote', () => {
    const f = fixture(); f.git('push', 'origin', 'codex/task'); Object.assign(f.plan.items[0], { remote: true, remoteReviewed: true });
    expect(f.check(true).items[0].status).toBe('cleaned'); expect(f.git('ls-remote', '--heads', 'origin', 'codex/task')).toBe('');
    const g = fixture(); g.git('push', 'origin', 'codex/task'); Object.assign(g.plan.items[0], { remote: true, remoteReviewed: true });
    g.git('commit', '--allow-empty', '-m', 'other'); g.git('push', 'origin', 'HEAD:refs/heads/codex/task');
    expect(g.check(true).items[0].reason).toBe('REMOTE_BRANCH_MOVED'); expect(existsSync(g.target)).toBe(true);
  });
  it('resumes only a worktree removal recorded in its own receipt', () => {
    const f = fixture(); f.git('worktree', 'remove', f.target);
    expect(f.check(true).items[0].reason).toBe('MISSING_WORKTREE_WITHOUT_RECEIPT');
  });
  it('rechecks a moved head before any deletion', () => {
    const f = fixture(); let calls = 0;
    const probe = () => { if (++calls === 1) f.git('-C', f.target, 'commit', '--allow-empty', '-m', 'concurrent'); return null; };
    expect(f.check(true, probe).items[0].reason).toBe('BRANCH_MOVED'); expect(existsSync(f.target)).toBe(true);
  });
  it('retains targets on cleanup lock contention', () => {
    const f = fixture(); mkdirSync(path.join(f.repo, '.git', 'quiet-room-task-cleanup.lock'));
    expect(() => f.check(true)).toThrow('CLEANUP_LOCKED'); expect(existsSync(f.target)).toBe(true);
  });
  it('resumes after worktree removal when branch deletion fails', () => {
    const f = fixture(); let calls = 0;
    const branchLock = path.join(f.repo, '.git', 'refs', 'heads', 'codex', 'task.lock');
    const probe = () => { if (++calls === 2) writeFileSync(branchLock, 'held'); return null; };
    const first = f.check(true, probe).items[0];
    expect(first.status).toBe('retained'); expect(first.worktreeRemoved).toBe(true);
    expect(existsSync(f.target)).toBe(false); expect(f.git('branch', '--list', 'codex/task')).toContain('codex/task');
    rmSync(branchLock);
    expect(f.check(true).items[0].status).toBe('cleaned');
  });
  it('remote compare-and-swap preserves a ref moved at push time', () => {
    const f = fixture(); f.git('push', 'origin', 'codex/task');
    f.git('commit', '--allow-empty', '-m', 'new-main'); f.git('push', 'origin', 'main');
    const newer = f.git('rev-parse', 'HEAD');
    Object.assign(f.plan.items[0], { remote: true, remoteReviewed: true });
    const hook = path.join(f.repo, '.git', 'hooks', 'pre-push');
    const remote = path.join(f.root, 'origin.git');
    writeFileSync(hook, `#!/bin/sh\ngit --git-dir="${remote}" update-ref refs/heads/codex/task ${newer}\n`); chmodSync(hook, 0o755);
    expect(f.check(true).items[0].status).toBe('retained');
    expect(f.git('ls-remote', '--heads', 'origin', 'codex/task')).toContain(newer);
  });
  it('rejects mismatched push endpoints before local deletion', () => {
    const f = fixture(); Object.assign(f.plan.items[0], { remote: true, remoteReviewed: true });
    f.git('remote', 'set-url', '--push', 'origin', path.join(f.root, 'other.git'));
    expect(f.check(true).items[0].reason).toBe('REMOTE_ENDPOINT_MISMATCH'); expect(existsSync(f.target)).toBe(true);
  });
  it('rejects evidence kept in disposable worktree Git metadata', () => {
    const f = fixture(); const admin = f.git('-C', f.target, 'rev-parse', '--absolute-git-dir');
    f.plan.evidence.path = path.join(admin, 'HEAD');
    f.plan.evidence.sha256 = createHash('sha256').update(readFileSync(f.plan.evidence.path)).digest('hex');
    expect(f.check(true).items[0].reason).toBe('EVIDENCE_INSIDE_WORKTREE_METADATA');
  });
  it('refuses to delete a branch checked out in a different worktree', () => {
    const f = fixture(); const other = path.join(f.root, 'other');
    f.git('worktree', 'move', f.target, other);
    expect(f.check(true).items[0].reason).toBe('BRANCH_USED_ELSEWHERE'); expect(existsSync(other)).toBe(true);
  });
  it('processes independent items without deleting a dirty sibling', () => {
    const f = fixture(); const second = path.join(f.root, 'second');
    f.git('worktree', 'add', '-b', 'codex/second', second, 'main');
    f.plan.items.push({ ...f.plan.items[0], path: second, branch: 'codex/second' });
    writeFileSync(path.join(second, 'untracked-note'), 'keep');
    const result = f.check(true);
    expect(result.items.map((item: { status: string }) => item.status)).toEqual(['cleaned', 'retained']);
    expect(existsSync(f.target)).toBe(false); expect(existsSync(second)).toBe(true);
    expect(f.check(true).items.map((item: { status: string }) => item.status)).toEqual(['absent', 'retained']);
  });
  it('never follows a symbolic task branch into main', () => {
    const f = fixture(); f.git('symbolic-ref', 'refs/heads/codex/task', 'refs/heads/main');
    expect(f.check(true).items[0].reason).toBe('SYMBOLIC_BRANCH');
    expect(f.git('rev-parse', 'main')).toBe(f.plan.releaseSha); expect(existsSync(f.target)).toBe(true);
  });
  it('CLI is check-only and rejects unknown flags', () => {
    const f = fixture(); const file = path.join(f.root, 'plan.json'); writeFileSync(file, JSON.stringify(f.plan));
    const script = path.resolve('scripts/cleanup-task-resources.mjs');
    try { execFileSync(process.execPath, [script, '--plan', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) {
      // lsof may be unavailable in CI; retaining is the required behavior.
      expect((error as { status: number }).status).toBe(2);
    }
    expect(existsSync(f.target)).toBe(true);
    expect(() => execFileSync(process.execPath, [script, '--plan', file, '--force'], { stdio: 'pipe' })).toThrow();
  });
  it('process probe returns a reason on inaccessible paths', () => {
    expect(processCheck('/nonexistent/quiet-room')).toBe('PROCESS_CHECK_UNAVAILABLE');
  });
});
