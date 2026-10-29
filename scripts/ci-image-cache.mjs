import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// The digest comes from the authenticated GitHub artifact listing, not from a
// locally writable manifest. Cached bytes never replace live CI/expiry checks.
const limit = 2 * 1024 ** 3;
const cacheLimit = 4 * 1024 ** 3;
const extract = `import json,stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist()
 if sorted(e.filename for e in entries)!=['image.json','image.tar.gz']: raise ValueError('Unexpected image members')
 for e in entries:
  maximum=8192 if e.filename=='image.json' else 2*1024**3
  mode=e.external_attr>>16
  if e.flag_bits&1 or e.is_dir() or not 0<e.file_size<=maximum or stat.S_ISLNK(mode): raise ValueError('Invalid image member')
 z.extractall(sys.argv[2])
`;

export function extractCachedImage(command, artifact, cacheDirectory, destination, hashFile) {
  // Older GitHub artifact metadata may lack a ZIP digest: keep the original
  // download path rather than weakening provenance to enable a cache hit.
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
      || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > limit) return false;
  if (!path.isAbsolute(cacheDirectory)) throw new Error('CI image cache must be absolute');
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(cacheDirectory);
  if (!parent.isDirectory() || parent.isSymbolicLink()
      || typeof process.getuid === 'function' && parent.uid !== process.getuid()
      || (parent.mode & 0o077) !== 0) throw new Error('CI image cache must be a private owned directory');
  const digest = artifact.digest.slice(7);
  const file = path.join(cacheDirectory, `${artifact.id}-${digest}.zip`);
  const verify = () => {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size_in_bytes || hashFile(file) !== digest) {
      throw new Error('Cached CI artifact checksum mismatch; nothing deployed');
    }
  };
  const hit = existsSync(file);
  if (!hit) {
    // Do not evict another active publisher's files. At the cap, use the normal
    // isolated download instead. Only this invocation's temporary file is removed.
    const bytes = readdirSync(cacheDirectory).reduce((total, name) => total + lstatSync(path.join(cacheDirectory, name)).size, 0);
    if (bytes + artifact.size_in_bytes > cacheLimit) return false;
    const temporary = path.join(cacheDirectory, `${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      try {
        command('gh', ['api', `repos/zdaiwmm/shui-IM/actions/artifacts/${artifact.id}/zip`], {
          stdio: ['ignore', descriptor, 'pipe'], timeout: 15 * 60_000,
        });
      } finally { closeSync(descriptor); }
      const info = lstatSync(temporary);
      if (info.size !== artifact.size_in_bytes || hashFile(temporary) !== digest) throw new Error('Downloaded CI artifact checksum mismatch');
      renameSync(temporary, file);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  verify();
  command('python3', ['-c', extract, file, destination], { timeout: 120_000 });
  console.log(`CI_IMAGE_CACHE ${hit ? 'hit' : 'stored'} artifact=${artifact.id}`);
  return true;
}
