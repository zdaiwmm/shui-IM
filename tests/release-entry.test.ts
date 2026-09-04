import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

// Execute the actual Node entry from an alias, with isolated source and synthetic
// command stand-ins. No production config, network access or privileged helper.
it('runs an aliased release entry through verification and writes a live-SHA receipt', () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'quiet-release-synthetic-')));
  const sha = 'a'.repeat(40);
  try {
    const repo = path.join(directory, 'source');
    const bin = path.join(directory, 'bin');
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    mkdirSync(path.join(repo, '.git'));
    mkdirSync(bin);
    for (const script of ['release.mjs', 'release-ci.mjs', 'release-runtime.mjs']) {
      copyFileSync(new URL(`../scripts/${script}`, import.meta.url), path.join(repo, 'scripts', script));
    }
    const alias = path.join(directory, 'alias');
    symlinkSync(repo, alias, 'dir');
    const fake = path.join(bin, 'stand-in.mjs');
    writeFileSync(fake, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import path from 'node:path';
const sha = '${sha}';
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({ name, args }) + '\\n');
if (name === 'git') {
  if (args[0] === 'branch') console.log('main');
  else if (args[0] === 'rev-parse' || args[0] === 'ls-remote') console.log(sha);
  else if (!['status', 'fetch'].includes(args[0])) process.exit(88);
} else if (name === 'gh') {
  if (args[1].includes('/jobs?')) console.log(JSON.stringify([{ jobs: [{ run_id: 42, head_sha: sha, name: 'Full application verification', status: 'completed', conclusion: 'success' }] }]));
  else if (args[1].includes('runs?')) console.log(JSON.stringify([{ workflow_runs: [{ id: 42, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'workflow_dispatch', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/42' }] }]));
  else if (args[1].endsWith('/ci.yml')) console.log('{}');
  else process.exit(88);
} else if (name === 'ssh') {
  if (args.at(-1).includes('current-sha')) console.log(sha);
  else if (args.at(-1) === sha && args.at(-2) === '/usr/local/sbin/quiet-room-deploy') console.log('DEPLOY_OK synthetic=true');
  else process.exit(88);
} else process.exit(88);
`, { mode: 0o755 });
    for (const name of ['git', 'gh', 'ssh']) symlinkSync(fake, path.join(bin, name));
    const key = path.join(directory, 'synthetic-key');
    writeFileSync(key, 'synthetic fixture only');
    const receipt = path.join(repo, '.git/quiet-room-verified-sha');
    const result = spawnSync(process.execPath, [path.join(alias, 'scripts/release.mjs'), '--sha', sha], {
      encoding: 'utf8', cwd: alias, env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: path.join(directory, 'commands'),
        QUIET_ROOM_SERVER_HOST: 'synthetic.invalid', QUIET_ROOM_SERVER_USER: 'synthetic', QUIET_ROOM_SERVER_KEY: key,
        QUIET_ROOM_GITHUB_KEY: '', QUIET_ROOM_PUBLISH_RECEIPT: receipt,
      },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`DEPLOY_VERIFIED sha=${sha}`);
    expect(result.stdout).toContain('RELEASE_TIMING scope=release phase=readback result=success');
    expect(readFileSync(receipt, 'utf8')).toBe(`${sha}\n`);
    const commands = readFileSync(path.join(directory, 'commands'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(call => call.name === 'ssh' && call.args.at(-1) === sha)).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
