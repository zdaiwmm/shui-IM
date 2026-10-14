import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational Node entry.
import { sealImage, validateImageManifest } from '../scripts/ci-image.mjs';
// @ts-expect-error Operational Node entry.
import { publish } from '../scripts/publish.mjs';
// @ts-expect-error Operational Node entry.
import { validateServerState } from '../scripts/production-readback.mjs';
const sha = 'a'.repeat(40), tree = 'b'.repeat(40), config = '{}';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function archive(tags: string[]) {
  const directory = mkdtempSync(path.join(tmpdir(), 'quiet-v2-image-')); directories.push(directory);
  const digest = createHash('sha256').update(config).digest('hex');
  writeFileSync(path.join(directory, digest + '.json'), config);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify([{ Config: digest + '.json', RepoTags: tags, Layers: [] }]));
  execFileSync('tar', ['-czf', path.join(directory, 'image.tar.gz'), '-C', directory, 'manifest.json', digest + '.json']);
  rmSync(path.join(directory, 'manifest.json')); rmSync(path.join(directory, digest + '.json'));
  const bytes = readFileSync(path.join(directory, 'image.tar.gz'));
  return { directory, manifest: { version: 1, sha, runId: 42, attempt: 1, platform: 'linux/amd64', imageId: 'sha256:' + digest, archiveSha256: createHash('sha256').update(bytes).digest('hex'), archiveBytes: bytes.length } };
}
describe('V2 release preparation preserves complete validation', () => {
  it('seals proof only after full archive identity, checksum and unique tag validation', () => {
    const good = archive(['quiet-room-app:' + sha]);
    const sealed = sealImage(good.directory, good.manifest, tree);
    expect(validateImageManifest(sealed, sha, { id: 42, run_attempt: 1 }).sourceTree).toBe(tree);
    const bad = archive(['quiet-room-app:' + sha, 'quiet-room-app:production']);
    expect(() => sealImage(bad.directory, bad.manifest, tree)).toThrow('unexpected tags');
    expect(JSON.parse(readFileSync(path.join(bad.directory, 'image.json'), 'utf8')).validationVersion).toBeUndefined();
    for (const change of [{ validationVersion: undefined }, { sourceTree: 'bad' }, { archiveBytes: 0 }, { imageId: 'bad' }, { archiveSha256: 'bad' }]) {
      expect(() => validateImageManifest({ ...sealed, ...change }, sha, { id: 42, run_attempt: 1 })).toThrow();
    }
  });
  it('waits only for explicit backup-starting, using the readback-only path', () => {
    const calls: string[][] = []; let probes = 0;
    publish(['--readback-only', '--sha', sha], (_program: string, args: string[]) => {
      calls.push(args);
      if (args[0].endsWith('production-readback.mjs') && probes++ === 0) throw Object.assign(new Error('starting'), { exitCode: 75 });
      return '';
    });
    expect(probes).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(['-e', 'setTimeout(() => {}, 10000)']);
    expect(calls.some(args => args.includes('workflow') || args.includes('--activate'))).toBe(false);
  });
  it('bounds startup-only polling and never retries an unknown, unhealthy or wrong-image state', () => {
    let calls = 0;
    expect(() => publish(['--readback-only', '--sha', sha], () => { calls++; throw Object.assign(new Error('starting'), { exitCode: 75 }); })).toThrow('READBACK_REQUIRED');
    // The first simulated wait command itself fails; no second probe is issued.
    expect(calls).toBe(2);
    calls = 0;
    expect(() => publish(['--readback-only', '--sha', sha], (_program: string, args: string[]) => { calls++; if (args[0].endsWith('production-readback.mjs')) throw Object.assign(new Error('starting'), { exitCode: 75 }); return ''; })).toThrow('READBACK_REQUIRED');
    expect(calls).toBe(73);
    for (const code of [1, 64, 70]) {
      calls = 0;
      expect(() => publish(['--readback-only', '--sha', sha], () => { calls++; throw Object.assign(new Error('blocked'), { exitCode: code }); })).toThrow('READBACK_REQUIRED');
      expect(calls).toBe(1);
    }
  });
  it('does not weaken the backup health predicate, and pins the opt-in startup overlay content', () => {
    const overlay = readFileSync('deploy/compose.startup-health.yaml');
    const helper = readFileSync('deploy/server/quiet-room-deploy', 'utf8');
    expect(helper).toContain(createHash('sha256').update(overlay).digest('hex'));
    expect(overlay.toString()).toContain('start_interval: 5s');
    expect(overlay.toString()).not.toMatch(/test:|disable:|retries:|start_period:/);
    const state = { currentSha: sha, deployedAt: '20261014T120000Z', release: '/opt/quiet-room/git-releases/20261014T120000Z-' + sha.slice(0,12), maintenance: 'absent', adminEnabled: '0', callsEnabled: '0', appRunning: 'true', appHealth: 'healthy', backupRunning: 'true', backupHealth: 'starting', turnRunning: 'absent', turnHealth: 'absent', targetImageId: 'sha256:'+'c'.repeat(64), appImageId: 'sha256:'+'c'.repeat(64), backupImageId: 'sha256:'+'c'.repeat(64), appImageRef: 'quiet-room-app:'+sha, backupImageRef: 'quiet-room-app:'+sha };
    expect(() => validateServerState(state, sha)).toThrow('still starting');
    expect(() => validateServerState({ ...state, backupImageId: 'sha256:'+'d'.repeat(64) }, sha)).toThrow('immutable image');
    expect(() => validateServerState({ ...state, backupHealth: 'unhealthy' }, sha)).toThrow('declared health');
  });
});
