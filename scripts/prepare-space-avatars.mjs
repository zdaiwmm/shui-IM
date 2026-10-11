// Rebuild bundled, bounded Noto avatar derivatives. No runtime remote requests.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const run = promisify(execFile);
const root = new URL('../', import.meta.url);
const sharpPath = process.argv[2];
if (!sharpPath) throw new Error('Pass the absolute path of an installed sharp module. Asset tooling is not an application dependency.');
const sharp = (await import(pathToFileURL(sharpPath).href)).default;
const library = JSON.parse(await readFile(new URL('src/lib/additional-gifs.json', root), 'utf8')).items;
const chosen = library.filter(item => item.tags.includes('Smileys and emotions')).slice(0, 80);
const cache = path.join(tmpdir(), 'quiet-room-space-navigation-avatars');
const destination = new URL('public/space-avatars/', root);
await mkdir(cache, { recursive: true });
await mkdir(destination, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const prepared = [];
const failed = [];
const queue = [...chosen];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const item = queue.shift();
    const codepoint = item.source.match(/\/([a-f0-9_]+)\/512\.webp$/)?.[1];
    if (!codepoint || item.license !== 'CC-BY-4.0' || item.author !== 'Google Noto Emoji') throw new Error('Unexpected source');
    const file = path.join(cache, `${codepoint}.webp`);
    try {
      let bytes = await readFile(file).catch(() => null);
      if (!bytes || bytes.length !== item.size || sha(bytes) !== item.digest) {
        if (process.argv.includes('--offline')) throw new Error('Verified original unavailable in local cache');
        await run('curl', ['--fail', '--silent', '--show-error', '--max-time', '90', '--proto', '=https', '--output', file, item.source]);
        bytes = await readFile(file);
      }
      if (bytes.length !== item.size || sha(bytes) !== item.digest || !bytes.includes(Buffer.from('ANIM'))) throw new Error('Original integrity mismatch');
      prepared.push({ item, codepoint, file });
    } catch (cause) { failed.push({ codepoint, error: cause.message.split('\n')[0] }); }
  }
}));
const manifest = [];
for (const item of chosen) {
  const source = prepared.find(entry => entry.item === item);
  if (!source) continue;
  const animated = await sharp(source.file, { animated: true, limitInputPixels: 200_000_000 }).resize(96, 96).webp({ quality: 60, effort: 5, loop: 0 }).toBuffer();
  const still = await sharp(source.file, { page: 0 }).resize(96, 96).webp({ quality: 80 }).toBuffer();
  if (!animated.includes(Buffer.from('ANIM'))) throw new Error('Animation lost during resize');
  await writeFile(new URL(`${source.codepoint}.webp`, destination), animated);
  await writeFile(new URL(`${source.codepoint}-still.webp`, destination), still);
  manifest.push({ id: source.codepoint, emoji: String.fromCodePoint(...source.codepoint.split('_').map(value => parseInt(value, 16))), label: item.title,
    source: item.source, originalDigest: item.digest, originalSize: item.size, author: item.author, license: item.license, modified: true,
    modification: 'Resized to 96px; compressed WebP animation and first-frame still.',
    digest: sha(animated), size: animated.length, stillDigest: sha(still), stillSize: still.length });
}
if (manifest.length < 64) throw new Error(`Only ${manifest.length} verified animations prepared; minimum is 64. ${JSON.stringify(failed)}`);
await writeFile(new URL('src/lib/space-avatar-catalog.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ count: manifest.length, bytes: manifest.reduce((total, item) => total + item.size + item.stillSize, 0), failed }));
