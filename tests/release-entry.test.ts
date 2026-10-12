import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

// Execute the actual Node entry from an alias, with isolated source and synthetic
// command stand-ins. No production config, network access or privileged helper.
it.each(['older', 'same', 'newer'])('checks the production boundary before invoking the helper (%s)', boundary => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'quiet-release-synthetic-')));
  const sha = 'a'.repeat(40);
  try {
    const repo = path.join(directory, 'source');
    const bin = path.join(directory, 'bin');
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    mkdirSync(path.join(repo, '.git'));
    mkdirSync(bin);
    for (const script of ['release.mjs', 'release-ci.mjs', 'release-runtime.mjs', 'deploy-config.mjs', 'ci-image.mjs']) {
      copyFileSync(new URL(`../scripts/${script}`, import.meta.url), path.join(repo, 'scripts', script));
    }
    const fixture = path.join(directory, 'image-fixture'); mkdirSync(fixture);
    const configHash = createHash('sha256').update('{}').digest('hex');
    writeFileSync(path.join(fixture, `${configHash}.json`), '{}');
    writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify([{ Config: `${configHash}.json`, RepoTags: [`quiet-room-app:${sha}`], Layers: [] }]));
    execFileSync('tar', ['-czf', path.join(fixture, 'image.tar.gz'), '-C', fixture, 'manifest.json', `${configHash}.json`]);
    const archive = readFileSync(path.join(fixture, 'image.tar.gz'));
    writeFileSync(path.join(fixture, 'image.json'), JSON.stringify({ version: 1, sha, runId: 42, attempt: 1, platform: 'linux/amd64', imageId: `sha256:${configHash}`, archiveSha256: createHash('sha256').update(archive).digest('hex'), archiveBytes: archive.length }));
    const alias = path.join(directory, 'alias');
    symlinkSync(repo, alias, 'dir');
    const fake = path.join(bin, 'stand-in.mjs');
    writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
const sha = '${sha}';
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({ name, args }) + '\\n');
if (name === 'git') {
  if (args[0] === 'branch') console.log('main');
  else if (args[0] === 'rev-parse' || args[0] === 'ls-remote') console.log(sha);
  else if (args[0] === 'merge-base' && args[2] === 'b'.repeat(40) && process.env.TEST_BOUNDARY === 'newer') process.exit(1);
  else if (!['status', 'fetch', 'merge-base'].includes(args[0])) process.exit(88);
} else if (name === 'gh') {
  if (args[0] === 'run' && args[1] === 'download') {
    for (const f of ['image.json', 'image.tar.gz']) copyFileSync(path.join(process.env.TEST_IMAGE_FIXTURE, f), path.join(args.at(-1), f));
  }
  else if (args[1].includes('/artifacts?')) console.log(JSON.stringify({ artifacts: [{ name: 'quiet-room-image-'+sha+'-1-amd64', expired: false, workflow_run: { id: 42, head_sha: sha } }] }));
  else if (args[1].includes('/jobs?')) console.log(JSON.stringify([{ jobs: [{ run_id: 42, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] }]));
  else if (args[1].includes('runs?')) console.log(JSON.stringify([{ workflow_runs: [{ id: 42, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'workflow_dispatch', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/42' }] }]));
  else if (args[1].endsWith('/ci.yml')) console.log('{}');
  else process.exit(88);
} else if (name === 'ssh') {
  if (args.at(-1) === '--describe') console.log(JSON.stringify({ imageProtocol: 1, publicOrigin: 'https://ai.shui.click' }));
  else if (args.at(-1).includes('current-sha')) {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const state = process.env.TEST_COMMAND_LOG + '.state';
    let count = 0; try { count = Number(readFileSync(state, 'utf8')); } catch {}
    writeFileSync(state, String(count + 1)); console.log(count < 2 && process.env.TEST_BOUNDARY !== 'same' ? 'b'.repeat(40) : sha);
  }
  else if (args.includes(sha) && args.includes('/usr/local/sbin/quiet-room-deploy')) console.log('DEPLOY_OK synthetic=true');
  else process.exit(88);
} else process.exit(88);
`, { mode: 0o755 });
    for (const name of ['git', 'gh', 'ssh']) symlinkSync(fake, path.join(bin, name));
    const key = path.join(directory, 'synthetic-key');
    writeFileSync(key, 'synthetic fixture only');
    const receipt = path.join(repo, '.git/quiet-room-verified-sha');
    const result = spawnSync(process.execPath, [path.join(alias, 'scripts/release.mjs'), '--sha', sha], {
      encoding: 'utf8', cwd: alias, env: {
        ...process.env, TEST_IMAGE_FIXTURE: fixture, TEST_BOUNDARY: boundary, PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: path.join(directory, 'commands'),
        QUIET_ROOM_SERVER_HOST: 'synthetic.invalid', QUIET_ROOM_SERVER_USER: 'synthetic', QUIET_ROOM_SERVER_KEY: key,
        QUIET_ROOM_GITHUB_KEY: '', QUIET_ROOM_PUBLISH_RECEIPT: receipt,
      },
    });
    if (boundary !== 'older') {
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('DEPLOY_VERIFIED');
      const log = readFileSync(path.join(directory, 'commands'), 'utf8');
      expect(log.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(call => call.name === 'ssh' && call.args.includes('/usr/local/sbin/quiet-room-deploy') && !call.args.includes('--describe'))).toBe(false);
      return;
    }
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`DEPLOY_VERIFIED sha=${sha}`);
    expect(result.stdout).toContain('RELEASE_TIMING scope=release phase=readback result=success');
    expect(readFileSync(receipt, 'utf8')).toBe(`${sha}\n`);
    const commands = readFileSync(path.join(directory, 'commands'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(call => call.name === 'ssh' && call.args.includes(sha) && call.args.includes('/usr/local/sbin/quiet-room-deploy'))).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
