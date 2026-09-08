import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { memeContentType } from './memes.mjs';
import { publicStickerAnimated } from './sticker-source.mjs';

export const GIF_ADDITIONS_BATCH = 'noto-gifs-20260909';
export function* shippedGifAdditions({ libraryPath, publicDir }) {
  const library = JSON.parse(readFileSync(libraryPath, 'utf8'));
  const invalid = () => { throw new Error('SHIPPED_EXPRESSION_INTEGRITY'); };
  if (library.id !== GIF_ADDITIONS_BATCH || !Array.isArray(library.items) || library.items.length !== 400
    || new Set(library.items.map(item => item.digest)).size !== 400) invalid();
  for (const item of library.items) {
    if (!/^[a-f0-9]{64}$/.test(item.digest) || item.asset !== `/gifs/${item.digest}.webp`
      || item.id !== `noto-gif-${item.digest}` || item.author !== 'Google Noto Emoji' || item.modified !== false
      || item.license !== 'CC-BY-4.0' || !/^https:\/\/fonts\.gstatic\.com\/s\/e\/notoemoji\/latest\/[a-f0-9_]+\/512\.webp$/.test(item.source)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120
      || typeof item.tags !== 'string' || item.tags.length > 2048) invalid();
    const bytes = readFileSync(path.join(publicDir, item.asset));
    if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.digest
      || memeContentType(bytes) !== 'image/webp' || !publicStickerAnimated(bytes)) invalid();
    yield { entry: { id: item.id, kind: 'gifs', title: item.title, tags: item.tags, author: item.author, source: item.source },
      files: [{ title: item.title, bytes }] };
  }
}
