import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { memeContentType } from './memes.mjs';
import { publicStickerAnimated } from './sticker-source.mjs';

export function* shippedExpressions({ libraryPath, publicDir }) {
  const library = JSON.parse(readFileSync(libraryPath, 'utf8'));
  const sources = JSON.parse(readFileSync(path.join(publicDir, 'stickers/sources.json'), 'utf8')).records;
  const invalid = () => { throw new Error('SHIPPED_EXPRESSION_INTEGRITY'); };
  const file = item => {
    if (!/^\/stickers\/[a-f0-9]{64}\.(png|jpeg|gif|webp)$/.test(item.asset)) invalid();
    const bytes = readFileSync(path.join(publicDir, item.asset));
    if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.digest) invalid();
    memeContentType(bytes);
    return { bytes, title: item.title };
  };
  const attribution = (item, pack) => {
    const source = sources.find(row => row.sha256 === item.digest && (!pack || row.pack === pack));
    if (!source || source.modified !== false || source.bytes !== item.size
      || source.directory !== `https://signalstickers.org/pack/${source.pack}`
      || !/^[a-f0-9]{32}$/.test(source.pack) || typeof source.author !== 'string') invalid();
    return { author: source.author, source: source.directory };
  };
  if (!Array.isArray(library.packs) || library.packs.length !== 30 || !Array.isArray(library.gifs) || library.gifs.length !== 100
    || new Set(library.packs.map(pack => pack.id)).size !== 30 || new Set(library.gifs.map(item => item.digest)).size !== 100) invalid();
  for (const pack of library.packs) {
    if (!/^[a-f0-9]{32}$/.test(pack.id) || !pack.items.length) invalid();
    const files = pack.items.map(item => { attribution(item, pack.id); return file(item); });
    yield { entry: { id: pack.id, kind: 'stickers', title: pack.title, tags: '', ...attribution(pack.items[0], pack.id) }, files };
  }
  for (const item of library.gifs) {
    const original = file(item);
    if (!publicStickerAnimated(original.bytes)) invalid();
    yield { entry: { id: `shipped-gif-${item.digest}`, kind: 'gifs', title: item.title, tags: '', ...attribution(item) }, files: [original] };
  }
}
