import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { publicStickerAnimated } from '../server/sticker-source.mjs';

// Offline preparation only; the application serves these unchanged files locally.
const root = new URL('../', import.meta.url);
const destination = new URL('public/gifs/', root);
await mkdir(destination, { recursive: true });
const metadataURL = 'https://googlefonts.github.io/noto-emoji-animation/data/api.json';
const fetchBytes = async url => {
  if (url !== metadataURL && !/^https:\/\/fonts\.gstatic\.com\/s\/e\/notoemoji\/latest\/[a-f0-9_]+\/512\.webp$/.test(url)) throw new Error('Unexpected source');
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024) throw new Error('Resource too large');
      return bytes;
    } catch (error) { if (attempt === 2) throw error; }
  }
};
const metadata = JSON.parse((await fetchBytes(metadataURL)).toString());
const icons = metadata.icons.filter(icon => /^[a-f0-9_]+$/.test(icon.codepoint));
const library = JSON.parse(await readFile(new URL('src/lib/starter-library.json', root), 'utf8'));
const seen = new Set([...library.packs.flatMap(pack => pack.items), ...library.gifs].map(item => item.digest));
const items = [];
let totalBytes = 0;
for (let offset = 0; offset < icons.length && items.length < 400; offset += 3) {
  const fetched = await Promise.all(icons.slice(offset, offset + 3).map(async icon => {
    const source = `https://fonts.gstatic.com/s/e/notoemoji/latest/${icon.codepoint}/512.webp`;
    return { icon, source, bytes: await fetchBytes(source) };
  }));
  for (const { icon, source, bytes } of fetched) {
    if (items.length === 400) break;
    if (!publicStickerAnimated(bytes)) throw new Error('Expected animation');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (seen.has(digest)) continue;
    totalBytes += bytes.length;
    if (totalBytes > 160 * 1024 * 1024) throw new Error('GIF batch exceeds size budget');
    await writeFile(new URL(`${digest}.webp`, destination), bytes);
    items.push({ id: `noto-gif-${digest}`, title: (icon.tags[0] ?? icon.name).replaceAll(':', '').replaceAll('-', ' '),
      tags: [...icon.tags, ...icon.categories].join(' '), asset: `/gifs/${digest}.webp`, digest, size: bytes.length,
      author: 'Google Noto Emoji', source, license: 'CC-BY-4.0', modified: false });
    seen.add(digest);
  }
  if (items.length % 30 === 0 || items.length === 400) console.log(JSON.stringify({ added: items.length, totalBytes }));
}
if (items.length !== 400) throw new Error(`Insufficient animations: ${items.length}`);
await writeFile(new URL('src/lib/additional-gifs.json', root), JSON.stringify({ id: 'noto-gifs-20260909', items }, null, 2) + '\n');
await writeFile(new URL('sources.json', destination), JSON.stringify({ source: 'https://googlefonts.github.io/noto-emoji-animation/',
  license: 'https://creativecommons.org/licenses/by/4.0/', items }, null, 2) + '\n');
