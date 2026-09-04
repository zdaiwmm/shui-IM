import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = 'zdaiwmm/shui-IM';

export function validateConfig(config) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(config.serverHost ?? '')) throw new Error('Missing or invalid serverHost');
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(config.serverUser ?? '')) throw new Error('Missing or invalid serverUser');
  for (const key of ['serverKey', 'githubKey']) {
    if ((key === 'serverKey' || config[key]) && (typeof config[key] !== 'string' || !path.isAbsolute(config[key]))) {
      throw new Error(`${key} must be an absolute path`);
    }
  }
  return config;
}

export function requireSuccessfulCI(response, sha) {
  const runs = (response.workflow_runs ?? []).filter(run => run.head_sha === sha &&
    run.head_branch === 'main' && run.event === 'push' && run.path === '.github/workflows/ci.yml');
  runs.sort((a, b) => b.id - a.id);
  if (!runs.length || runs[0].status !== 'completed' || runs[0].conclusion !== 'success') {
    throw new Error('Latest CI push run for the exact main commit has not passed.');
  }
  return runs[0].html_url;
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 30000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${program}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout?.trim() ?? '';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Production: https://ai.shui.click\nUsage: npm run deploy:doctor\n       npm run deploy:production [-- --sha <exact 40-character main SHA>]\nConfig: .deploy.local.json or QUIET_ROOM_* environment settings.\n--sha confirms only that exact commit; all safety checks still run.');
    return;
  }
  const doctor = args.length === 1 && args[0] === '--doctor';
  const approved = args.length === 2 && args[0] === '--sha' && /^[0-9a-f]{40}$/.test(args[1]) ? args[1] : null;
  if (args.length && !doctor && !approved) throw new Error('Invalid arguments; use --help.');
  const configPath = path.join(root, '.deploy.local.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  for (const [key, env] of Object.entries({ serverHost: 'QUIET_ROOM_SERVER_HOST', serverUser: 'QUIET_ROOM_SERVER_USER', serverKey: 'QUIET_ROOM_SERVER_KEY', githubKey: 'QUIET_ROOM_GITHUB_KEY' })) {
    if (process.env[env]) config[key] = process.env[env];
  }
  validateConfig(config);
  for (const key of ['serverKey', 'githubKey']) {
    if (config[key] && !existsSync(config[key])) throw new Error(`Key file unavailable: ${key}`);
  }
  const ssh = ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', config.serverKey, `${config.serverUser}@${config.serverHost}`];
  const env = { ...process.env };
  if (config.githubKey) {
    const quoted = `'${config.githubKey.replaceAll("'", "'\\''")}'`;
    env.GIT_SSH_COMMAND = `ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -i ${quoted}`;
  }
  const git = (...params) => command('git', params, { env });
  const failures = [];
  function check(label, fn) {
    try { const result = fn(); console.log(`OK ${label}${result ? `: ${result}` : ''}`); }
    catch (error) { if (!doctor) throw error; failures.push(label); console.error(`BLOCKED ${label}: ${error.message}`); }
  }
  check('GitHub code access', () => { git('ls-remote', '--exit-code', 'origin', 'refs/heads/main'); });
  check('GitHub CI access', () => { command('gh', ['api', `repos/${repo}/actions/workflows/ci.yml`]); });
  check('Production connection and helper', () => command('ssh', [...ssh,
    'sudo -n test -x /usr/local/sbin/quiet-room-deploy && sudo -n cat /opt/quiet-room/deploy-state/current-sha']));
  if (doctor) {
    console.log('Read-only: no merge, deployment, installation, or firewall change.');
    if (failures.length) throw new Error(`${failures.length} prerequisites blocked. See DEPLOYMENT.md; do not bypass checks.`);
    return;
  }
  if (git('branch', '--show-current') !== 'main') throw new Error('Deploy only from main after PR review and merge.');
  if (git('status', '--porcelain')) throw new Error('Working tree must be clean, including untracked files.');
  git('fetch', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  if (sha !== git('rev-parse', 'origin/main')) throw new Error('Local main must exactly match origin/main.');
  if (approved && approved !== sha) throw new Error('Approved SHA does not match main.');
  const runs = JSON.parse(command('gh', ['api', `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`]));
  console.log(`CI passed: ${requireSuccessfulCI(runs, sha)}`);
  console.log(`Release ${sha} to https://ai.shui.click`);
  if (!approved) {
    if (!process.stdin.isTTY) throw new Error('Noninteractive release requires --sha <exact SHA>.');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await input.question('Type DEPLOY to continue: '); } finally { input.close(); }
    if (answer !== 'DEPLOY') throw new Error('Deployment cancelled.');
  }
  // Never automatically retry a cutover after an ambiguous disconnect.
  command('ssh', [...ssh, 'sudo', '-n', '/usr/local/sbin/quiet-room-deploy', sha], { stdio: 'inherit', timeout: 0 });
  const live = command('ssh', [...ssh, 'sudo -n cat /opt/quiet-room/deploy-state/current-sha']);
  if (live !== sha) throw new Error('Live SHA differs after deployment. Inspect state before retrying.');
  console.log(`DEPLOY_VERIFIED sha=${sha} url=https://ai.shui.click`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`RELEASE_BLOCKED: ${error.message}`); process.exitCode = 1; });
}
