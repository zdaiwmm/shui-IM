import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script has no TS declarations.
import { artifactName, downloadCIImage, hashFile, validateImage } from '../scripts/ci-image.mjs';

const sha = 'a'.repeat(40);
const run = { id: 42, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
function fixture(directory: string, tags = [`quiet-room-app:${sha}`]) {
  const config = '{}'; const configHash = createHash('sha256').update(config).digest('hex');
  writeFileSync(path.join(directory, `${configHash}.json`), config);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify([{ Config: `${configHash}.json`, RepoTags: tags, Layers: [] }]));
  execFileSync('tar', ['-czf', path.join(directory, 'image.tar.gz'), '-C', directory, 'manifest.json', `${configHash}.json`]);
  rmSync(path.join(directory, 'manifest.json')); rmSync(path.join(directory, `${configHash}.json`));
  const archive = path.join(directory, 'image.tar.gz');
  const manifest = { version: 1, sha, runId: 42, attempt: 2, platform: 'linux/amd64', imageId: `sha256:${configHash}`, archiveSha256: hashFile(archive), archiveBytes: readFileSync(archive).length };
  writeFileSync(path.join(directory, 'image.json'), JSON.stringify(manifest));
  return manifest;
}

describe('CI image provenance and transfer', () => {
  it('accepts only the verified commit, attempt and platform, with a complete archive checksum', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-image-'));
    try {
      fixture(directory);
      expect(validateImage(directory, sha, run, 'linux/amd64').sha).toBe(sha);
      for (const [s, r, p] of [['b'.repeat(40), run, 'linux/amd64'], [sha, { ...run, run_attempt: 3 }, 'linux/amd64'], [sha, run, 'linux/arm64']] as const) {
        expect(() => validateImage(directory, s, r, p)).toThrow();
      }
      writeFileSync(path.join(directory, 'image.tar.gz'), 'truncated');
      expect(() => validateImage(directory, sha, run, 'linux/amd64')).toThrow('checksum mismatch');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('rejects extra Docker tags and filesystem links before server import', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-image-'));
    try {
      fixture(directory, [`quiet-room-app:${sha}`, 'quiet-room-app:production']);
      expect(() => validateImage(directory, sha, run, 'linux/amd64')).toThrow('unexpected tags');
      rmSync(path.join(directory, 'image.tar.gz'));
      symlinkSync(path.join(directory, 'image.json'), path.join(directory, 'image.tar.gz'));
      expect(() => validateImage(directory, sha, run, 'linux/amd64')).toThrow('Invalid CI image file');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(['expired', 'wrong-sha', 'wrong-run', 'duplicate', 'missing'])('does not download an untrusted artifact (%s)', mode => {
    let downloads = 0;
    const command = (_program: string, args: string[]) => {
      const api = args[1] ?? '';
      if (api.includes('/jobs?')) return JSON.stringify({ jobs: [{ run_id: 42, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] });
      if (api.includes('runs?')) return JSON.stringify({ workflow_runs: [run] });
      if (api.includes('/artifacts?')) {
        const artifact = { name: artifactName(sha, 2, 'linux/amd64'), expired: mode === 'expired', workflow_run: { id: mode === 'wrong-run' ? 43 : 42, head_sha: mode === 'wrong-sha' ? 'b'.repeat(40) : sha } };
        return JSON.stringify({ artifacts: mode === 'missing' ? [] : mode === 'duplicate' ? [artifact, artifact] : [artifact] });
      }
      downloads++; throw new Error('Unexpected download');
    };
    expect(() => downloadCIImage(command, sha, '/unused')).toThrow('missing or expired');
    expect(downloads).toBe(0);
  });
  it.each([false, true])('rechecks CI identity after downloading (changed=%s)', changed => {
    const parent = mkdtempSync(path.join(tmpdir(), 'quiet-download-'));
    let reads = 0;
    const command = (_program: string, args: string[]) => {
      const api = args[1] ?? '';
      if (api.includes('/jobs?')) return JSON.stringify({ jobs: [{ run_id: 42, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] });
      if (api.includes('runs?')) { reads++; return JSON.stringify({ workflow_runs: [{ ...run, run_attempt: changed && reads > 2 ? 3 : 2 }] }); }
      if (api.includes('/artifacts?')) return JSON.stringify({ artifacts: [{ name: artifactName(sha, 2, 'linux/amd64'), expired: false, workflow_run: { id: 42, head_sha: sha } }] });
      if (args[0] === 'run' && args[1] === 'download') { fixture(args.at(-1)!); return ''; }
      throw new Error('Unexpected command');
    };
    try {
      const operation = () => downloadCIImage(command, sha, path.join(parent, 'artifact'));
      if (changed) expect(operation).toThrow('CI changed');
      else expect(operation().sha).toBe(sha);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
