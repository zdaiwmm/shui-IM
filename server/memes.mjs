import https from 'node:https';
import { lookup } from 'node:dns';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 24;
const TTL = 15 * 60_000;
const categories = {
  搞笑: /drake|buttons|boyfriend|gru|spongebob|disaster|batman|doge|cheems|laugh|clown/i,
  可爱: /cat|doge|cheems|baby|kid|puppy|penguin|pooh/i,
  开心: /success|happy|handshake|cheer|laugh|smile|cinema|celebrat/i,
  无语: /skeleton|pablo|waiting|picard|awkward|confused|pigeon|facepalm|fry|fine|distracted/i,
  生气: /angry|yell|slap|rage|batman|disaster/i,
  晚安: /sleep|bed/i,
  打工: /paid|office|meeting|work|boss|trade|support|bernie|buttons|trophy/i,
};
const aliases = [
  [/drake/i, '德雷克 不要 好的 拒绝 选择'], [/buttons/i, '按钮 纠结 选择 困难'],
  [/boyfriend/i, '男友 分心 回头'], [/skeleton|waiting/i, '等待 等你 累了'],
  [/pablo/i, '难过 孤独 发呆'], [/cat/i, '猫 猫咪'], [/doge|cheems/i, '狗 狗头 柴犬'],
  [/spongebob/i, '海绵宝宝 嘲讽'], [/success/i, '成功 好耶 加油'],
  [/handshake/i, '握手 合作 赞同'], [/paid|office|work/i, '上班 工资 打工'],
  [/brain/i, '大脑 聪明 思考'], [/fine/i, '没事 无所谓'], [/yell|slap/i, '吵架 生气'],
];

export function allowedMemeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'i.imgflip.com' && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/[a-z0-9]+\.(jpg|jpeg|png|gif|webp)$/i.test(url.pathname);
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
  if (url !== 'https://api.imgflip.com/get_memes' && !allowedMemeUrl(url)) throw new Error('MEME_SOURCE_REJECTED');
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const request = https.get(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: { Accept: url.includes('/get_memes') ? 'application/json' : 'image/*' },
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
  let catalog = [];
  let refreshedAt = -Infinity;
  let pending;
  let activeMedia = 0;
  const grants = new Map();
  async function loadCatalog() {
    if (now() - refreshedAt < TTL) return catalog;
    if (!pending) pending = (async () => {
      const bytes = await fetchResource('https://api.imgflip.com/get_memes', 512 * 1024);
      const body = JSON.parse(bytes.toString('utf8'));
      if (body?.success !== true || !Array.isArray(body.data?.memes) || body.data.memes.length > 500) throw new Error('MEME_INVALID_CATALOG');
      const rows = body.data.memes.filter(item => typeof item.name === 'string' && item.name.length <= 120 && allowedMemeUrl(item.url)
        && Number.isInteger(item.width) && Number.isInteger(item.height) && item.width > 0 && item.height > 0
        && item.width <= 8192 && item.height <= 8192 && item.width * item.height <= 16_000_000);
      catalog = [...new Map(rows.map(item => [item.url, item])).values()];
      if (!catalog.length) throw new Error('MEME_INVALID_CATALOG');
      refreshedAt = now(); return catalog;
    })().finally(() => { pending = undefined; });
    return pending;
  }
  return {
    async search(owner, body, signal) {
      if (!body || typeof body.keyword !== 'string' || body.keyword.length > 80 || /[\u0000-\u001f]/.test(body.keyword)
        || !Number.isInteger(body.page) || body.page < 1 || body.page > 100) throw new Error('MEME_INVALID_QUERY');
      const rows = await loadCatalog(); signal?.throwIfAborted();
      const query = body.keyword.trim().toLocaleLowerCase();
      const terms = query.split(/\s+/).filter(Boolean);
      const filtered = !query || query === '热门' ? rows : rows.filter(item => {
        const tags = Object.entries(categories).filter(([, pattern]) => pattern.test(item.name)).map(([tag]) => tag);
        const names = aliases.filter(([pattern]) => pattern.test(item.name)).map(([, label]) => label);
        const searchable = [item.name, ...tags, ...names].join(' ').toLocaleLowerCase();
        return terms.every(term => searchable.includes(term));
      });
      for (const [id, grant] of grants) if (grant.expires <= now()) grants.delete(id);
      const start = (body.page - 1) * PAGE_SIZE;
      const items = filtered.slice(start, start + PAGE_SIZE).map(item => {
        while (grants.size >= 2000) grants.delete(grants.keys().next().value);
        const id = randomUUID(); grants.set(id, { owner, url: item.url, expires: now() + TTL });
        return { id, title: item.name };
      });
      return { items, nextPage: start + PAGE_SIZE < filtered.length ? body.page + 1 : null, source: 'Imgflip', scope: 'popular-catalog' };
    },
    async media(owner, id, signal) {
      const grant = grants.get(id);
      if (!grant || grant.owner !== owner || grant.expires <= now()) throw new Error('MEME_NOT_FOUND');
      if (activeMedia >= 8) throw new Error('MEME_BUSY');
      activeMedia++;
      try {
        const bytes = await fetchResource(grant.url, MAX_BYTES, signal);
        signal?.throwIfAborted();
        if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('MEME_TOO_LARGE');
        return { bytes, type: memeContentType(bytes) };
      } finally { activeMedia--; }
    },
  };
}
