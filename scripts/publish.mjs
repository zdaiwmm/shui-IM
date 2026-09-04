import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, copyFileSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleaseTimer, isMainModule } from './release-runtime.mjs';
import { readCIRuns, selectRun, verifySuccessfulCI } from './release-ci.mjs';

export { selectRun } from './release-ci.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = 'zdaiwmm/shui-IM';

export function approvedCommit(args) {
  if (args.length !== 2 || args[0] !== '--sha' || !/^[a-f0-9]{40}$/.test(args[1])) {
    throw new Error('Usage: node scripts/publish.mjs --sha <exact approved main SHA>');
  }
  return args[1];
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
  const timed = createReleaseTimer('publish');
  return timed('total', () => publishApproved(args, run, timed));
}

function publishApproved(args, run, timed) {
  const sha = approvedCommit(args);
  // Read-only preflight first. Never try browser login or edit network rules here.
  timed('preflight', () => run(process.execPath, [path.join(root, 'scripts/release.mjs'), '--doctor'], { stdio: 'inherit', timeout: 120000 }));
  timed('verify-main', () => {
    const remoteSHA = run('gh', ['api', `repos/${repo}/commits/main`, '--jq', '.sha']);
    if (remoteSHA !== sha) throw new Error('Approved commit is not the current GitHub main. Review the new main before publishing.');
  });
  timed('wait-ci', () => {
    const ci = selectRun(readCIRuns(run, sha), sha);
    if (ci.status !== 'completed') {
      run('gh', ['run', 'watch', String(ci.id), '--repo', repo, '--exit-status', '--interval', '5'], { stdio: 'inherit', timeout: 25 * 60 * 1000 });
    }
    // Re-read after watching: newer failed/pending runs must never fall back to
    // the watched result, and documentation-only green runs cannot authorize it.
    verifySuccessfulCI(run, sha);
  });
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'quiet-room-publish-')));
  console.log(`Isolated release directory: ${directory}`);
  // Reuse the already configured Git SSH identity without touching the working tree.
  const config = path.join(root, '.deploy.local.json');
  const localConfig = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
  const key = process.env.QUIET_ROOM_GITHUB_KEY || localConfig.githubKey;
  const ssh = key ? `ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -i '${key.replaceAll("'", "'\\''")}'`
    : run('git', ['config', '--get', 'core.sshCommand']);
  if (!ssh) throw new Error('Configure core.sshCommand or QUIET_ROOM_GITHUB_KEY before publishing.');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_SSH_COMMAND: ssh };
  timed('clone', () => {
    run('git', ['clone', '--depth', '1', '--single-branch', '--branch', 'main', `git@github.com:${repo}.git`, directory], { env, timeout: 120000 });
    if (run('git', ['rev-parse', 'HEAD'], { cwd: directory }) !== sha) throw new Error('Main changed while preparing release. Nothing deployed.');
  });
  if (existsSync(config)) {
    const target = path.join(directory, '.deploy.local.json');
    copyFileSync(config, target);
    chmodSync(target, 0o600);
  }
  // Existing entry point rechecks exact main CI, clean state, and live SHA.
  // Preserve this directory on failure for diagnosis; never automatically retry a cutover.
  timed('deploy-and-readback', () => {
    const receipt = path.join(directory, '.git/quiet-room-verified-sha');
    if (existsSync(receipt)) throw new Error('Unexpected pre-existing release receipt. Nothing deployed.');
    run(process.execPath, [path.join(directory, 'scripts/release.mjs'), '--sha', sha], {
      cwd: directory, env: { ...env, QUIET_ROOM_PUBLISH_RECEIPT: receipt }, stdio: 'inherit', timeout: 0,
    });
    if (!existsSync(receipt) || readFileSync(receipt, 'utf8') !== `${sha}\n`) {
      throw new Error('Release exited without a verified live-SHA receipt. Inspect production state before retrying.');
    }
  });
}

if (isMainModule(import.meta.url)) {
  try { publish(process.argv.slice(2)); }
  catch (error) { console.error(`PUBLISH_BLOCKED: ${error.message}`); process.exitCode = 1; }
}
