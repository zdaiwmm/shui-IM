import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const canonicalHttps = 'https://github.com/zdaiwmm/shui-IM.git';
const canonicalSsh = 'git@github.com:zdaiwmm/shui-IM.git';

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    ...options,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `${program} exited with ${result.status}`);
  return result.stdout?.trim() ?? '';
}

function succeeds(program, args) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
}

export function isCanonicalRemote(url) {
  return url === canonicalHttps || url === canonicalSsh || url === canonicalHttps.slice(0, -4) || url === canonicalSsh.slice(0, -4);
}

export function validateBranch(branch) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..') || branch.includes('@{') || branch.endsWith('/')) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  return branch;
}

export function parseRemoteHead(output, branch) {
  const expectedRef = `refs/heads/${branch}`;
  const line = output.split('\n').find(item => item.endsWith(`\t${expectedRef}`));
  if (!line) throw new Error(`Remote branch not found: ${branch}`);
  const [sha] = line.split('\t');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Remote returned an invalid branch SHA');
  return sha;
}

export function checkLocalReadiness(directory = root) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
  const git = args => run('git', args, { cwd: directory });
  const directories = new Set(['--git-common-dir', '--git-dir'].map(option =>
    git(['rev-parse', '--path-format=absolute', option])));
  for (const location of directories) {
    let probe;
    try {
      probe = fs.mkdtempSync(path.join(location, 'quiet-room-write-check-'));
      fs.writeFileSync(path.join(probe, 'probe'), '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw new Error(`Git metadata write blocked (${error.code}): ${location}; retry with authorized execution permissions before changing filesystem permissions`);
    } finally {
      if (probe) {
        fs.rmSync(path.join(probe, 'probe'), { force: true });
        fs.rmdirSync(probe);
      }
    }
  }
  const missing = ['tsc', 'vite', 'vitest'].filter(name => {
    try { fs.accessSync(path.join(directory, 'node_modules/.bin', name), fs.constants.X_OK); return false; }
    catch { return true; }
  });
  if (missing.length) throw new Error(`Missing development tools (${missing.join(', ')}); run npm ci --include=dev --no-audit --no-fund in this worktree`);
  return { branch: git(['branch', '--show-current']) || 'DETACHED', sha: git(['rev-parse', 'HEAD']) };
}

function doctor(localOnly = false) {
  const local = checkLocalReadiness();
  console.log(`REPO_LOCAL_READY branch=${local.branch} sha=${local.sha}`);
  if (localOnly) return;
  const remote = run('git', ['remote', 'get-url', 'origin']);
  if (!isCanonicalRemote(remote)) throw new Error(`origin must be ${canonicalHttps} (found ${remote})`);
  try { run('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' }); }
  catch { throw new Error('GitHub authentication check failed; verify network/keyring access in an authorized host execution before requesting login again'); }
  run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
  console.log(`REPO_READY remote=${remote}`);
}

function syncMain() {
  if (run('git', ['branch', '--show-current']) !== 'main') throw new Error('repo:pull only runs on main');
  if (run('git', ['status', '--porcelain'])) throw new Error('Working tree must be clean before repo:pull');
  run('git', ['fetch', '--prune', 'origin', 'main']);
  const head = run('git', ['rev-parse', 'HEAD']);
  const remote = run('git', ['rev-parse', 'origin/main']);
  if (head === remote) {
    console.log(`REPO_SYNCED sha=${head}`);
    return;
  }
  const localContainsRemote = succeeds('git', ['merge-base', '--is-ancestor', remote, head]);
  const remoteContainsLocal = succeeds('git', ['merge-base', '--is-ancestor', head, remote]);
  if (localContainsRemote) throw new Error(`Local main is ahead of origin/main (${head}); publish or review local commits before pulling`);
  if (!remoteContainsLocal) throw new Error('Local main and origin/main have diverged; resolve in an integration worktree');
  run('git', ['merge', '--ff-only', 'origin/main']);
  console.log(`REPO_SYNCED sha=${remote}`);
}

function pushBranch() {
  const branch = validateBranch(run('git', ['branch', '--show-current']));
  if (branch === 'main') throw new Error('repo:push refuses direct pushes from main; use a task branch and pull request');
  if (run('git', ['status', '--porcelain'])) throw new Error('Working tree must be clean before repo:push');
  const local = run('git', ['rev-parse', 'HEAD']);
  run('git', ['push', '--set-upstream', 'origin', branch], { stdio: 'inherit' });
  const remote = parseRemoteHead(run('git', ['ls-remote', 'origin', `refs/heads/${branch}`]), branch);
  if (local !== remote) throw new Error(`Remote branch SHA ${remote} differs from local ${local}`);
  console.log(`REPO_PUSHED branch=${branch} sha=${local}`);
}

function main(args) {
  if (args.length === 2 && args[0] === 'doctor' && args[1] === '--local') return doctor(true);
  if (args.length !== 1 || !['doctor', 'pull', 'push'].includes(args[0])) {
    console.log('Usage: node scripts/repo.mjs <doctor [--local]|pull|push>');
    process.exitCode = 1;
    return;
  }
  ({ doctor, pull: syncMain, push: pushBranch }[args[0]])();
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`REPO_BLOCKED: ${error.message}`); process.exitCode = 1; }
}
