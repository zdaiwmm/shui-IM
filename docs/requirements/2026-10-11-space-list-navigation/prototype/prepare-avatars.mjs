// Local prototype fixtures only. Never imported by the product or browser.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { avatarCatalog } from './avatar-catalog.mjs';

const cache = path.join(tmpdir(), 'quiet-room-space-navigation-avatars');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
await mkdir(cache, { recursive: true });
let downloaded = 0;
// Four bounded workers; only exact public Google Noto files are requested.
const queue = [...avatarCatalog];
const failures = [];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const item = queue.shift(), target = path.join(cache, `${item.codepoint}.webp`);
    try { const bytes = await readFile(target); if (digest(bytes) === item.digest) continue; } catch {}
    const source = `https://fonts.gstatic.com/s/e/notoemoji/latest/${item.codepoint}/512.webp`;
    // curl respects the configured host proxy and certificate trust. No redirects.
    let bytes;
    try { ({ stdout: bytes } = await run('curl', ['--fail', '--silent', '--show-error', '--max-time', '90', '--proto', '=https', source], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })); }
    catch (error) { failures.push(`${item.codepoint}: download failed (${error.code})`); continue; }
    if (bytes.length !== item.size || digest(bytes) !== item.digest) throw new Error(`Noto source changed: ${item.codepoint}. Review catalog before replacing fixtures.`);
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || !bytes.includes(Buffer.from('ANIM'))) throw new Error(`Not animated WebP: ${item.codepoint}`);
    await writeFile(target, bytes); downloaded++; console.log(`Prepared ${item.codepoint}`);
  }
}));
console.log(`Prototype avatars verified: ${avatarCatalog.length - failures.length}/${avatarCatalog.length}, downloaded ${downloaded}. Cache: ${cache}`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
