import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createReleaseTimer, isMainModule } from './release-runtime.mjs';
import { verifySuccessfulCI } from './release-ci.mjs';
import { assertKeyFiles, loadConfig, validateConfig } from './deploy-config.mjs';

export { requireSuccessfulCI } from './release-ci.mjs';
export { validateConfig } from './deploy-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = 'zdaiwmm/shui-IM';
const timed = createReleaseTimer('release');

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
  const receipt = process.env.QUIET_ROOM_PUBLISH_RECEIPT;
  if (receipt && path.resolve(receipt) !== path.join(root, '.git/quiet-room-verified-sha')) throw new Error('Invalid isolated release receipt path.');
  const { config } = loadConfig(root);
  validateConfig(config);
  assertKeyFiles(config);
  const ssh = ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', config.serverKey, `${config.serverUser}@${config.serverHost}`];
  const env = { ...process.env };
  if (config.githubKey) {
    const quoted = `'${config.githubKey.replaceAll("'", "'\\''")}'`;
    env.GIT_SSH_COMMAND = `ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -i ${quoted}`;
  }
  const git = (...params) => command('git', params, { env });
  const failures = [];
  function check(label, phase, fn) {
    try { const result = timed(phase, fn); console.log(`OK ${label}${result ? `: ${result}` : ''}`); }
    catch (error) { if (!doctor) throw error; failures.push(label); console.error(`BLOCKED ${label}: ${error.message}`); }
  }
  check('GitHub code access', 'github-code-access', () => { git('ls-remote', '--exit-code', 'origin', 'refs/heads/main'); });
  check('GitHub CI access', 'github-ci-access', () => { command('gh', ['api', `repos/${repo}/actions/workflows/ci.yml`]); });
  check('Production connection and helper', 'server-preflight', () => command('ssh', [...ssh,
    'sudo -n test -x /usr/local/sbin/quiet-room-deploy && sudo -n cat /opt/quiet-room/deploy-state/current-sha']));
  if (doctor) {
    console.log('Read-only: no merge, deployment, installation, or firewall change.');
    if (failures.length) throw new Error(`${failures.length} prerequisites blocked. See DEPLOYMENT.md; do not bypass checks.`);
    return;
  }
  const sha = timed('verify-main', () => {
    if (git('branch', '--show-current') !== 'main') throw new Error('Deploy only from main after PR review and merge.');
    if (git('status', '--porcelain')) throw new Error('Working tree must be clean, including untracked files.');
    git('fetch', 'origin', 'main');
    const head = git('rev-parse', 'HEAD');
    if (head !== git('rev-parse', 'origin/main')) throw new Error('Local main must exactly match origin/main.');
    if (approved && approved !== head) throw new Error('Approved SHA does not match main.');
    return head;
  });
  console.log(`CI passed: ${timed('verify-ci', () => verifySuccessfulCI(command, sha))}`);
  console.log(`Release ${sha} to https://ai.shui.click`);
  if (!approved) {
    if (!process.stdin.isTTY) throw new Error('Noninteractive release requires --sha <exact SHA>.');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await input.question('Type DEPLOY to continue: '); } finally { input.close(); }
    if (answer !== 'DEPLOY') throw new Error('Deployment cancelled.');
  }
  // Never automatically retry a cutover after an ambiguous disconnect.
  timed('server-deploy', () => command('ssh', [...ssh, 'sudo', '-n', '/usr/local/sbin/quiet-room-deploy', sha], { stdio: 'inherit', timeout: 0 }));
  timed('readback', () => {
    const live = command('ssh', [...ssh, 'sudo -n cat /opt/quiet-room/deploy-state/current-sha']);
    if (live !== sha) throw new Error('Live SHA differs after deployment. Inspect state before retrying.');
    if (receipt) writeFileSync(receipt, `${sha}\n`, { flag: 'wx', mode: 0o600 });
  });
  console.log(`DEPLOY_VERIFIED sha=${sha} url=https://ai.shui.click`);
}

if (isMainModule(import.meta.url)) {
  timed('total', main).catch(error => { console.error(`RELEASE_BLOCKED: ${error.message}`); process.exitCode = 1; });
}
