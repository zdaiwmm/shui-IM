import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './release-runtime.mjs';
import { repository, verifySuccessfulCI } from './release-ci.mjs';

export function hashFile(file) {
  const descriptor = openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try { for (;;) { const bytes = readSync(descriptor, buffer, 0, buffer.length, null); if (!bytes) break; hash.update(buffer.subarray(0, bytes)); } }
  finally { closeSync(descriptor); }
  return hash.digest('hex');
}

export function artifactName(sha, attempt, platform) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !Number.isSafeInteger(attempt) || attempt < 1 || !['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Invalid CI image identity');
  return `quiet-room-image-${sha}-${attempt}-${platform.split('/')[1]}`;
}

export function validateImageManifest(manifest, sha, run, platform = 'linux/amd64') {
  if (manifest?.version !== 1 || manifest.sha !== sha || manifest.runId !== run.id || manifest.attempt !== run.run_attempt || manifest.platform !== platform ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId) || !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) ||
      !Number.isSafeInteger(manifest.archiveBytes) || manifest.archiveBytes < 1 || manifest.archiveBytes > 2 * 1024 ** 3) throw new Error('CI image manifest identity mismatch');
  if (manifest.validationVersion !== 2 || !/^[a-f0-9]{40}$/.test(manifest.sourceTree)) throw new Error('CI image has no full build-time validation proof');
  return manifest;
}

export function sealImage(directory, manifest, sourceTree) {
  writeFileSync(path.join(directory, 'image.json'), JSON.stringify(manifest) + '\n');
  // Never stamp the proof until the entire archive/hash/unique tag/config check passed.
  validateImage(directory, manifest.sha, { id: manifest.runId, run_attempt: manifest.attempt }, manifest.platform);
  const sealed = { ...manifest, validationVersion: 2, sourceTree };
  validateImageManifest(sealed, manifest.sha, { id: manifest.runId, run_attempt: manifest.attempt }, manifest.platform);
  writeFileSync(path.join(directory, 'image.json'), JSON.stringify(sealed) + '\n');
  return sealed;
}

export function validateImage(directory, sha, run, platform) {
  if (readdirSync(directory).sort().join(',') !== 'image.json,image.tar.gz') throw new Error('Unexpected CI image files');
  for (const name of ['image.json', 'image.tar.gz']) {
    const info = lstatSync(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > (name === 'image.json' ? 8192 : 2 * 1024 ** 3)) throw new Error('Invalid CI image file');
  }
  const manifest = JSON.parse(readFileSync(path.join(directory, 'image.json'), 'utf8'));
  const archive = path.join(directory, 'image.tar.gz');
  if (manifest.version !== 1 || manifest.sha !== sha || manifest.runId !== run.id || manifest.attempt !== run.run_attempt || manifest.platform !== platform ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId) || !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) ||
      manifest.archiveBytes !== lstatSync(archive).size || hashFile(archive) !== manifest.archiveSha256) throw new Error('CI image manifest or checksum mismatch');
  const saved = spawnSync('tar', ['-xOzf', archive, 'manifest.json'], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  if (saved.error || saved.status !== 0) throw new Error('Invalid Docker image archive');
  const entries = JSON.parse(saved.stdout);
  const imageHash = manifest.imageId.slice(7);
  if (!Array.isArray(entries) || entries.length !== 1 || JSON.stringify(entries[0].RepoTags) !== JSON.stringify([`quiet-room-app:${sha}`]) ||
      ![`${imageHash}.json`, `blobs/sha256/${imageHash}`].includes(entries[0].Config)) throw new Error('Image archive contains unexpected tags or configuration');
  return { ...manifest, archive };
}

export function findCIImageArtifact(response, sha, run, platform = 'linux/amd64') {
  const name = artifactName(sha, run.run_attempt, platform);
  const pages = Array.isArray(response) ? response : [response];
  if (pages.some(page => !Array.isArray(page.artifacts))) throw new Error('Invalid CI image artifact listing');
  const artifacts = pages.flatMap(page => page.artifacts).filter(item => item.name === name);
  if (artifacts.length !== 1 || artifacts[0].expired !== false || artifacts[0].workflow_run?.id !== run.id || artifacts[0].workflow_run?.head_sha !== sha) throw new Error('Exact CI image is missing or expired; rerun this exact commit CI');
  return artifacts[0];
}

export function downloadCIImage(command, sha, directory, platform = 'linux/amd64') {
  const run = verifySuccessfulCI(command, sha, { details: true });
  const name = artifactName(sha, run.run_attempt, platform);
  const response = JSON.parse(command('gh', ['api', `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`, '--paginate', '--slurp']));
  findCIImageArtifact(response, sha, run, platform);
  mkdirSync(directory, { mode: 0o700 });
  command('gh', ['run', 'download', String(run.id), '--repo', repository, '--name', name, '--dir', directory], { timeout: 15 * 60 * 1000 });
  const image = validateImage(directory, sha, run, platform);
  const latest = verifySuccessfulCI(command, sha, { details: true });
  if (latest.id !== run.id || latest.run_attempt !== run.run_attempt) throw new Error('CI changed while downloading the image');
  return image;
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] !== 'manifest') throw new Error('Use manifest inside the CI image job');
  const directory = process.argv[3];
  const sha = process.env.GITHUB_SHA;
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const platform = process.env.IMAGE_PLATFORM;
  artifactName(sha, attempt, platform);
  const imageId = process.env.IMAGE_ID;
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')) throw new Error('Invalid built image ID');
  const archive = path.join(directory, 'image.tar.gz');
  const tree = spawnSync('git', ['rev-parse', `${sha}^{tree}`], { encoding: 'utf8' });
  if (tree.status !== 0) throw new Error('CI source tree unavailable');
  sealImage(directory, { version: 1, sha, runId: Number(process.env.GITHUB_RUN_ID), attempt, platform, imageId,
    archiveSha256: hashFile(archive), archiveBytes: lstatSync(archive).size }, tree.stdout.trim());
}
