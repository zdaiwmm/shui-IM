import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = 'zdaiwmm/shui-IM';

export function approvedCommit(args) {
  if (args.length !== 2 || args[0] !== '--sha' || !/^[a-f0-9]{40}$/.test(args[1])) {
    throw new Error('Usage: node scripts/publish.mjs --sha <exact approved main SHA>');
  }
  return args[1];
}

export function selectRun(response, sha) {
  const run = (response.workflow_runs ?? [])
    .filter(run => run.head_sha === sha && run.head_branch === 'main' &&
      run.event === 'push' && run.path === '.github/workflows/ci.yml')
    .sort((a, b) => b.id - a.id)[0];
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0) throw new Error('No matching main CI run yet. Retry after GitHub creates it.');
  if (run.status === 'completed' && run.conclusion !== 'success') throw new Error('Latest CI failed. Fix it before publishing.');
  return run;
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, ...options,
  });
  if (result.error || result.status !== 0) throw new Error(`${program}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout?.trim() ?? '';
}

export function publish(args, run = command) {
  const sha = approvedCommit(args);
  // Read-only preflight first. Never try browser login or edit network rules here.
  run(process.execPath, [path.join(root, 'scripts/release.mjs'), '--doctor'], { stdio: 'inherit', timeout: 120000 });
  const remoteSHA = run('gh', ['api', `repos/${repo}/commits/main`, '--jq', '.sha']);
  if (remoteSHA !== sha) throw new Error('Approved commit is not the current GitHub main. Review the new main before publishing.');
  const ci = selectRun(JSON.parse(run('gh', ['api', `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`])), sha);
  if (ci.status !== 'completed') {
    run('gh', ['run', 'watch', String(ci.id), '--repo', repo, '--exit-status', '--interval', '30'], { stdio: 'inherit', timeout: 25 * 60 * 1000 });
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'quiet-room-publish-'));
  console.log(`Isolated release directory: ${directory}`);
  // Reuse the already configured Git SSH identity without touching the working tree.
  const config = path.join(root, '.deploy.local.json');
  const localConfig = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
  const key = process.env.QUIET_ROOM_GITHUB_KEY || localConfig.githubKey;
  const ssh = key ? `ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -i '${key.replaceAll("'", "'\\''")}'`
    : run('git', ['config', '--get', 'core.sshCommand']);
  if (!ssh) throw new Error('Configure core.sshCommand or QUIET_ROOM_GITHUB_KEY before publishing.');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_SSH_COMMAND: ssh };
  run('git', ['clone', '--single-branch', '--branch', 'main', `git@github.com:${repo}.git`, directory], { env, timeout: 120000 });
  if (run('git', ['rev-parse', 'HEAD'], { cwd: directory }) !== sha) throw new Error('Main changed while preparing release. Nothing deployed.');
  if (existsSync(config)) {
    const target = path.join(directory, '.deploy.local.json');
    copyFileSync(config, target);
    chmodSync(target, 0o600);
  }
  // Existing entry point rechecks exact main CI, clean state, and live SHA.
  // Preserve this directory on failure for diagnosis; never automatically retry a cutover.
  run(process.execPath, [path.join(directory, 'scripts/release.mjs'), '--sha', sha], { cwd: directory, env, stdio: 'inherit', timeout: 0 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { publish(process.argv.slice(2)); }
  catch (error) { console.error(`PUBLISH_BLOCKED: ${error.message}`); process.exitCode = 1; }
}
