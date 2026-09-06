import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw new Error(reason); };
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
function run(command, args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
}
function git(cwd, args, optional = false) {
  const r = run('git', args, cwd);
  if (r.error || r.signal || r.status !== 0) {
    if (optional && !r.error && !r.signal && r.status === 1) return null;
    fail('GIT_CHECK_FAILED'); // Do not leak remote URLs, command stderr or file contents.
  }
  return r.stdout.trim();
}
function worktrees(repo) {
  const output = git(repo, ['worktree', 'list', '--porcelain', '-z']);
  return output.split('\0\0').filter(Boolean).map(block => Object.fromEntries(block.split('\0').filter(Boolean).map(line => {
    const space = line.indexOf(' ');
    return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
  })));
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) fail('INVALID_PATH');
  return path.resolve(value);
}
function plainFile(file) {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) fail('INVALID_EVIDENCE_FILE');
  return readFileSync(file);
}
function validate(plan) {
  if (plan?.version !== 1 || !sha(plan.releaseSha) || !Array.isArray(plan.items) || !plan.items.length || plan.items.length > 30) fail('INVALID_PLAN');
  absolute(plan.repository);
  if (!Number.isFinite(Date.parse(plan.reviewedAt)) || Date.now() - Date.parse(plan.reviewedAt) > 86400000 || Date.parse(plan.reviewedAt) > Date.now() + 60000) fail('REVIEW_EXPIRED');
  for (const key of ['releaseVerified', 'readbackVerified', 'contextSynced']) if (plan[key] !== true) fail('REVIEW_REQUIRED');
  if (!plan.evidence || !/^[a-f0-9]{64}$/.test(plan.evidence.sha256)) fail('EVIDENCE_REQUIRED');
  absolute(plan.evidence.path);
  const paths = new Set(), branches = new Set();
  for (const item of plan.items) {
    const p = absolute(item.path);
    if (paths.has(p) || branches.has(item.branch)) fail('DUPLICATE_TARGET');
    paths.add(p); branches.add(item.branch);
    if (typeof item.branch !== 'string' || !/^(codex|fix|docs)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(item.branch) || !sha(item.head)) fail('INVALID_TARGET');
    if (item.integratedCommit !== undefined && !sha(item.integratedCommit)) fail('INVALID_INTEGRATION');
    if (item.remote !== undefined && typeof item.remote !== 'boolean') fail('INVALID_REMOTE');
  }
  for (const a of paths) for (const b of paths) if (a !== b && inside(a, b)) fail('OVERLAPPING_TARGETS');
}
function remoteHead(repo, branch) {
  const output = git(repo, ['ls-remote', '--refs', 'origin', `refs/heads/${branch}`]);
  if (!output) return null;
  const lines = output.split('\n');
  const [head, ref] = lines[0].split('\t');
  if (lines.length !== 1 || !sha(head) || ref !== `refs/heads/${branch}`) fail('REMOTE_REF_INVALID');
  return head;
}
function ancestor(repo, from, to) {
  return git(repo, ['merge-base', '--is-ancestor', from, to], true) !== null;
}
export function processCheck(directory) {
  const result = run('lsof', ['-nP', '+D', directory, '-F', 'p'], path.dirname(directory));
  if (result.error || result.signal || result.stderr?.trim()) return 'PROCESS_CHECK_UNAVAILABLE';
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.status === 0 && result.stdout.trim()) return 'OPEN_FILES_OR_PROCESSES';
  return 'PROCESS_CHECK_UNAVAILABLE';
}

// The plan is an operator-reviewed handoff, not a cryptographic proof of release or inactivity.
// Git checks are independent. Unknown state always retains the resource.
export function cleanup(plan, { apply = false, probeProcesses = processCheck } = {}) {
  validate(plan);
  const repo = realpathSync(plan.repository);
  const common = realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const initial = worktrees(repo);
  const primary = realpathSync(initial[0].worktree);
  const current = realpathSync(process.cwd());
  const script = realpathSync(fileURLToPath(import.meta.url));
  const planId = digest(JSON.stringify(plan));
  const receipts = path.join(common, 'quiet-room-task-cleanup');
  if (existsSync(receipts) && lstatSync(receipts).isSymbolicLink()) fail('UNSAFE_RECEIPT_DIRECTORY');
  const receipt = path.join(receipts, `${planId}.json`);
  const lock = path.join(common, 'quiet-room-task-cleanup.lock');
  const evidence = realpathSync(plan.evidence.path);
  const checkEvidence = () => {
    if (digest(plainFile(plan.evidence.path)) !== plan.evidence.sha256) fail('EVIDENCE_CHANGED');
  };
  checkEvidence();
  for (const item of plan.items) {
    const target = absolute(item.path);
    if (inside(repo, target) || inside(primary, target) || inside(common, target) || inside(current, target) || inside(script, target) || inside(evidence, target)) fail('PROTECTED_PATH');
    if (existsSync(target) && realpathSync(target) !== target) fail('NONCANONICAL_TARGET');
  }
  const checkMain = () => {
    const main = remoteHead(repo, 'main');
    if (!main || !ancestor(repo, plan.releaseSha, main)) fail('RELEASE_NOT_ON_REMOTE_MAIN');
  };
  checkMain();
  let previous;
  if (existsSync(receipt)) {
    previous = JSON.parse(plainFile(receipt).toString());
    if (previous.planId !== planId) fail('INVALID_RECEIPT');
  }
  const result = { version: 1, planId, mode: apply ? 'apply' : 'check', releaseSha: plan.releaseSha, items: plan.items.map(item => ({ path: item.path, branch: item.branch, head: item.head, status: 'retained', worktreeRemoved: previous?.items?.some(i => i.path === item.path && i.head === item.head && i.worktreeRemoved === true) ?? false })) };
  const save = () => {
    // Before any deletion, persist the plan identity and reviewed evidence references outside targets.
    if (apply) {
      const temporary = `${receipt}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...result, evidence: plan.evidence, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, receipt);
    }
  };
  const inspect = item => {
    if (item.ownerReleased !== true || item.evidenceSaved !== true) fail('OWNER_RELEASE_REQUIRED');
    git(repo, ['check-ref-format', `refs/heads/${item.branch}`]);
    const local = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${item.branch}`], true);
    if (local !== null && local !== item.head) fail('BRANCH_MOVED');
    if (local && git(repo, ['symbolic-ref', '--quiet', `refs/heads/${item.branch}`], true) !== null) fail('SYMBOLIC_BRANCH');
    const listed = worktrees(repo);
    const target = listed.find(w => w.worktree === item.path);
    if (listed.some(w => w.branch === `refs/heads/${item.branch}` && w.worktree !== item.path)) fail('BRANCH_USED_ELSEWHERE');
    const integration = item.integratedCommit ?? item.head;
    if (!ancestor(repo, integration, plan.releaseSha)) fail('NOT_IN_RELEASE');
    if (integration !== item.head && git(repo, ['rev-parse', `${integration}^{tree}`]) !== git(repo, ['rev-parse', `${item.head}^{tree}`])) fail('INTEGRATION_TREE_MISMATCH');
    if (target) {
      if (!local || target.HEAD !== item.head || target.branch !== `refs/heads/${item.branch}`) fail('WORKTREE_CHANGED');
      if ('locked' in target || 'prunable' in target) fail('WORKTREE_LOCKED_OR_STALE');
      if (!existsSync(item.path) || realpathSync(item.path) !== item.path) fail('WORKTREE_PATH_CHANGED');
      if (!lstatSync(path.join(item.path, '.git')).isFile()) fail('NOT_LINKED_WORKTREE');
      if (realpathSync(git(item.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== common) fail('WRONG_REPOSITORY');
      if (git(item.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])) fail('WORKTREE_HAS_FILES_OR_CHANGES');
      if (git(item.path, ['ls-files', '--stage']).split('\n').some(line => line.startsWith('160000 '))) fail('SUBMODULE_PRESENT');
      const admin = realpathSync(git(item.path, ['rev-parse', '--absolute-git-dir']));
      if (inside(evidence, admin)) fail('EVIDENCE_INSIDE_WORKTREE_METADATA');
      const allowed = new Set(['HEAD', 'index', 'ORIG_HEAD', 'FETCH_HEAD', 'commondir', 'gitdir', 'logs', 'refs', 'COMMIT_EDITMSG']);
      if (readdirSync(admin).some(name => !allowed.has(name))) fail('WORKTREE_METADATA_REQUIRES_REVIEW');
      const emptyDirectories = dir => readdirSync(dir, { withFileTypes: true }).every(entry => entry.isDirectory() && emptyDirectories(path.join(dir, entry.name)));
      if (existsSync(path.join(admin, 'refs')) && (lstatSync(path.join(admin, 'refs')).isSymbolicLink() || !emptyDirectories(path.join(admin, 'refs')))) fail('WORKTREE_METADATA_REQUIRES_REVIEW');
      if (existsSync(path.join(admin, 'logs')) && (lstatSync(path.join(admin, 'logs')).isSymbolicLink() || readdirSync(path.join(admin, 'logs')).some(name => name !== 'HEAD'))) fail('WORKTREE_METADATA_REQUIRES_REVIEW');
      const processReason = probeProcesses(item.path);
      if (processReason) fail(processReason);
    } else if (existsSync(item.path)) fail('UNREGISTERED_PATH');
    else if (local && !previous?.items?.some(i => i.path === item.path && i.head === item.head && i.worktreeRemoved === true)) fail('MISSING_WORKTREE_WITHOUT_RECEIPT');
    if (item.remote) {
      if (item.remoteReviewed !== true) fail('REMOTE_REVIEW_REQUIRED');
      const fetchUrl = git(repo, ['remote', 'get-url', '--all', 'origin']);
      const pushUrl = git(repo, ['remote', 'get-url', '--push', '--all', 'origin']);
      if (fetchUrl.includes('\n') || fetchUrl !== pushUrl) fail('REMOTE_ENDPOINT_MISMATCH');
      const remote = remoteHead(repo, item.branch);
      if (remote && remote !== item.head) fail('REMOTE_BRANCH_MOVED');
    }
    return { target, local };
  };
  if (apply) {
    try { mkdirSync(lock); } catch { fail('CLEANUP_LOCKED'); }
  }
  try {
    if (apply) mkdirSync(receipts, { recursive: true, mode: 0o700 });
    for (const [index, item] of plan.items.entries()) {
      const row = result.items[index];
      try {
        const state = inspect(item);
        row.worktreeRemoved = !state.target;
        if (!apply) { row.status = state.target || state.local || (item.remote && remoteHead(repo, item.branch)) ? 'eligible' : 'absent'; continue; }
        checkEvidence(); checkMain(); inspect(item); save();
        if (state.target) {
          git(repo, ['worktree', 'remove', '--', item.path]);
          if (existsSync(item.path) || worktrees(repo).some(w => w.worktree === item.path)) fail('WORKTREE_REMOVAL_UNVERIFIED');
          row.worktreeRemoved = true; save();
        }
        if (state.local) {
          if (worktrees(repo).some(w => w.branch === `refs/heads/${item.branch}`)) fail('BRANCH_USED_ELSEWHERE');
          git(repo, ['update-ref', '--no-deref', '-d', `refs/heads/${item.branch}`, item.head]);
        }
        if (git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${item.branch}`], true)) fail('LOCAL_DELETE_UNVERIFIED');
        if (item.remote && remoteHead(repo, item.branch)) {
          git(repo, ['push', `--force-with-lease=refs/heads/${item.branch}:${item.head}`, 'origin', `:refs/heads/${item.branch}`]);
          if (remoteHead(repo, item.branch)) fail('REMOTE_DELETE_UNVERIFIED');
        }
        row.status = state.target || state.local || item.remote ? 'cleaned' : 'absent';
      } catch (error) { row.reason = error.message; }
      save();
    }
    return result;
  } finally {
    if (apply) rmdirSync(lock);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args[0] !== '--plan' || (args.length !== 2 && !(args.length === 3 && args[2] === '--apply'))) fail('USAGE: node scripts/cleanup-task-resources.mjs --plan /absolute/plan.json [--apply]');
    const file = absolute(args[1]);
    const plan = JSON.parse(plainFile(file).toString());
    if (plan.items?.some(item => inside(realpathSync(file), absolute(item.path)))) fail('PLAN_INSIDE_TARGET');
    const result = cleanup(plan, { apply: args[2] === '--apply' });
    console.log(JSON.stringify(result, null, 2));
    if (result.items.some(item => item.status === 'retained')) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', reason: error.message }));
    process.exitCode = 1;
  }
}
