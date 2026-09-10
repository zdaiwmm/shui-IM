import https from 'node:https';
import { lookup } from 'node:dns';
import { randomUUID } from 'node:crypto';
import { STICKER_DIRECTORY, createStickerSource, decryptPublicSticker, matchStickerPacks } from './sticker-source.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 24;
const TTL = 15 * 60_000;

export function allowedMemeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn-ca.signal.org' && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/stickers\/[a-f0-9]{32}\/(manifest\.proto|full\/\d{1,5})$/.test(url.pathname);
  } catch { return false; }
}

export function publicMemeAddress(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && [0, 2, 168].includes(b)) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
}

// The socket uses this exact validated DNS answer; redirects are never followed.
export function fetchMemeResource(url, limit, signal) {
  if (url !== STICKER_DIRECTORY && url !== 'https://googlefonts.github.io/noto-emoji-animation/data/api.json' && !/^https:\/\/fonts\.gstatic\.com\/s\/e\/notoemoji\/latest\/[a-f0-9_]{4,80}\/512\.webp$/.test(url) && !allowedMemeUrl(url)) throw new Error('MEME_SOURCE_REJECTED');
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const request = https.get(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: { Accept: url === STICKER_DIRECTORY ? 'application/json' : 'application/octet-stream' },
      lookup: (hostname, options, callback) => lookup(hostname, { family: 4, all: true }, (error, addresses) => {
        if (error || !addresses?.length || addresses.some(item => !publicMemeAddress(item.address))) {
          callback(new Error('MEME_DNS_REJECTED')); return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, 4);
      }),
    }, response => {
      if (response.statusCode !== 200 || Number(response.headers['content-length'] || 0) > limit) {
        response.destroy(); reject(new Error('MEME_UPSTREAM_UNAVAILABLE')); return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { response.destroy(new Error('MEME_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
    request.on('close', () => clearTimeout(timeout));
  });
}

export function memeContentType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('MEME_INVALID_IMAGE');
}

export function createMemeService({ fetchResource = fetchMemeResource, now = Date.now } = {}) {
  const source = createStickerSource(fetchResource, now);
  let activeMedia = 0;
  const grants = new Map();
  function grant(owner, item) {
    for (const [id, value] of grants) if (value.expires <= now()) grants.delete(id);
    while (grants.size >= 4000) grants.delete(grants.keys().next().value);
    const id = randomUUID(); grants.set(id, { ...item, owner, expires: now() + TTL }); return { id, title: item.title };
  }
  return {
    async search(owner, body, signal) {
      if (!body || typeof body.keyword !== 'string' || body.keyword.length > 80 || /[\u0000-\u001f]/.test(body.keyword)
        || !['gifs', 'stickers'].includes(body.kind) || !Number.isInteger(body.page) || body.page < 1 || body.page > 1000) throw new Error('MEME_INVALID_QUERY');
      signal?.throwIfAborted();
      const rows = matchStickerPacks(await source.list(signal), body.keyword, body.kind === 'gifs');
      signal?.throwIfAborted();
      if (body.kind === 'gifs') {
        const row = rows[body.page - 1];
        const pack = row ? await source.pack(row.id, signal) : null;
        signal?.throwIfAborted();
        return { items: pack?.items.map(item => grant(owner, item)) ?? [], nextPage: body.page < Math.min(rows.length, 1000) ? body.page + 1 : null, source: 'Signal Stickers · 动画' };
      }
      const start = (body.page - 1) * PAGE_SIZE;
      return { items: [], packs: rows.slice(start, start + PAGE_SIZE).map(pack => ({ id: pack.id, title: pack.title, cover: grant(owner, { packId: pack.id, title: pack.title }).id })),
        nextPage: body.page < 1000 && start + PAGE_SIZE < rows.length ? body.page + 1 : null, source: 'Signal Stickers · 合集' };
    },
    async pack(owner, id, signal) {
      const pack = await source.pack(id, signal); signal?.throwIfAborted();
      return { id: pack.id, title: pack.title, items: pack.items.map(item => grant(owner, item)) };
    },
    async media(owner, id, signal) {
      const grant = grants.get(id);
      if (!grant || grant.owner !== owner || grant.expires <= now()) throw new Error('MEME_NOT_FOUND');
      if (activeMedia >= 8) throw new Error('MEME_BUSY');
      activeMedia++;
      try {
        const item = grant.packId ? (await source.pack(grant.packId, signal)).cover : grant;
        const bytes = decryptPublicSticker(await fetchResource(item.url, MAX_BYTES + 64, signal), item.key);
        signal?.throwIfAborted();
        if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('MEME_TOO_LARGE');
        return { bytes, type: memeContentType(bytes) };
      } finally { activeMedia--; }
    },
  };
}
