import { ZipReader, Uint8ArrayReader } from '@zip.js/zip.js';
import { memeContentType } from './memes.mjs';

const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_PACK = 64 * 1024 * 1024;
const invalid = () => { throw new Error('MEME_INVALID_QUERY'); };
const tooLarge = () => { throw new Error('MEME_TOO_LARGE'); };

function filename(value) {
  if (typeof value !== 'string') invalid();
  const name = value.replace(/^\.\//, '');
  if (!name || name.startsWith('/') || /[\\:\u0000-\u001f]/.test(name)
    || name.split('/').some(part => part === '..' || part === '.')) invalid();
  return name;
}

export async function parseWastickers(bytes) {
  if (!bytes.length || bytes.length > MAX_UPLOAD) tooLarge();
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, checkSignature: true });
  try {
    const files = new Map(); const names = new Set();
    let count = 0; let total = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > 205) tooLarge();
      const name = filename(entry.filename);
      if (names.has(name) || entry.encrypted) invalid();
      names.add(name);
      if (entry.directory) continue;
      const limit = /\.(json|txt)$/i.test(name) ? 256 * 1024 : MAX_IMAGE;
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > limit
        || total + entry.uncompressedSize > MAX_PACK) tooLarge();
      let size = 0; const chunks = [];
      // Enforce actual output limits too, before retaining decompressed chunks.
      await entry.getData(new WritableStream({ write(chunk) {
        size += chunk.length; total += chunk.length;
        if (size > limit || total > MAX_PACK) tooLarge();
        chunks.push(Buffer.from(chunk));
      } }));
      if (size !== entry.uncompressedSize) invalid();
      files.set(name, Buffer.concat(chunks, size));
    }
    const metadataBytes = files.get('contents.json') ?? files.get('metadata.json');
    let title; let listed;
    if (metadataBytes) {
      const metadata = JSON.parse(metadataBytes.toString('utf8'));
      title = metadata?.name ?? metadata?.title ?? '';
      if (typeof title !== 'string' || !Array.isArray(metadata?.stickers)) invalid();
      listed = metadata.stickers.map(item => filename(item?.image_file ?? item?.file));
    } else {
      if (!files.has('title.txt')) invalid();
      title = files.get('title.txt').toString('utf8').replace(/^\uFEFF/, '').trim();
      listed = [...files.keys()].filter(name => /\.(webp|png|jpe?g|gif)$/i.test(name)
        && !/^tray\.(webp|png|jpe?g|gif)$/i.test(name));
    }
    if (!listed.length || listed.length > 200 || new Set(listed).size !== listed.length) invalid();
    return { title, files: listed.map(name => {
      const image = files.get(name);
      if (!image) invalid();
      if (!image.length || image.length > MAX_IMAGE) tooLarge();
      memeContentType(image);
      return { bytes: image, title };
    }) };
  } catch (error) {
    if (['MEME_TOO_LARGE', 'MEME_INVALID_QUERY', 'MEME_INVALID_IMAGE'].includes(error.message)) throw error;
    invalid();
  } finally { await reader.close(); }
}
