import { hkdfSync, createHmac, timingSafeEqual, createDecipheriv } from 'node:crypto';
import protobuf from 'protobufjs';

export const STICKER_DIRECTORY = 'https://api.signalstickers.org/v1/packs/';
const schema = protobuf.parse('syntax="proto2"; message Pack { optional string title=1; optional string author=2; message Sticker { optional uint32 id=1; optional string emoji=2; } optional Sticker cover=3; repeated Sticker stickers=4; }').root.lookupType('Pack');
const hexId = /^[a-f0-9]{32}$/;

// Signal's public sticker transport is independent of Quiet Room's message keys.
// https://github.com/signalapp/Signal-Desktop/blob/main/protos/Stickers.proto
export function decryptPublicSticker(bytes, key) {
  if (!/^[a-f0-9]{64}$/.test(key) || bytes.length < 64 || (bytes.length - 48) % 16 !== 0) throw new Error('MEME_INVALID_IMAGE');
  const keys = Buffer.from(hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.alloc(32), 'Sticker Pack', 64));
  const mac = createHmac('sha256', keys.subarray(32)).update(bytes.subarray(0, -32)).digest();
  if (!timingSafeEqual(mac, bytes.subarray(-32))) throw new Error('MEME_INVALID_IMAGE');
  const decipher = createDecipheriv('aes-256-cbc', keys.subarray(0, 32), bytes.subarray(0, 16));
  return Buffer.concat([decipher.update(bytes.subarray(16, -32)), decipher.final()]);
}

export function createStickerSource(fetchResource, now = Date.now) {
  let directory; let refreshed = -Infinity; let pending;
  const manifests = new Map();
  async function list(signal) {
    if (directory && now() - refreshed < 60 * 60_000) return directory;
    pending ??= (async () => {
      const parsed = JSON.parse((await fetchResource(STICKER_DIRECTORY, 8 * 1024 * 1024)).toString('utf8'));
      if (!Array.isArray(parsed) || parsed.length > 30_000) throw new Error('MEME_INVALID_CATALOG');
      const result = parsed.filter(pack => pack && hexId.test(pack.meta?.id) && /^[a-f0-9]{64}$/.test(pack.meta?.key)
        && !pack.meta.nsfw && typeof pack.manifest?.title === 'string' && pack.manifest.title.length <= 250)
        .map(pack => ({ id: pack.meta.id, key: pack.meta.key, title: pack.manifest.title.slice(0, 120), author: String(pack.manifest.author ?? '').slice(0, 120),
          tags: Array.isArray(pack.meta.tags) ? pack.meta.tags.filter(tag => typeof tag === 'string').join(' ').slice(0, 2048) : '',
          animated: pack.meta.animated === true, original: pack.meta.original === true, featured: pack.meta.editorschoice === true,
          popularity: Number(pack.meta.hotviews) || 0, source: typeof pack.meta.source === 'string' ? pack.meta.source.slice(0, 500) : '' }));
      if (!result.length) throw new Error('MEME_INVALID_CATALOG');
      directory = result.sort((a, b) => b.popularity - a.popularity); refreshed = now(); return directory;
    })().finally(() => { pending = undefined; });
    const result = await pending; signal?.throwIfAborted(); return result;
  }
  async function pack(id, signal) {
    if (!hexId.test(id)) throw new Error('MEME_NOT_FOUND');
    const entry = (await list(signal)).find(item => item.id === id); if (!entry) throw new Error('MEME_NOT_FOUND');
    const cached = manifests.get(id); if (cached && now() - cached.time < 60 * 60_000) return cached.value;
    const encrypted = await fetchResource(`https://cdn-ca.signal.org/stickers/${id}/manifest.proto`, 256 * 1024, signal);
    const decoded = schema.toObject(schema.decode(decryptPublicSticker(encrypted, entry.key)), { defaults: true });
    if (!Array.isArray(decoded.stickers) || !decoded.stickers.length || decoded.stickers.length > 200
      || decoded.stickers.some(item => !Number.isSafeInteger(item.id) || item.id < 0 || item.id > 10000)) throw new Error('MEME_INVALID_CATALOG');
    const ids = new Set();
    const items = decoded.stickers.filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true; })
      .map(item => ({ id: item.id, title: `${entry.title} ${typeof item.emoji === 'string' ? item.emoji : ''}`.trim().slice(0, 120), url: `https://cdn-ca.signal.org/stickers/${id}/full/${item.id}`, key: entry.key }));
    const cover = items.find(item => item.id === decoded.cover?.id) ?? items[0];
    const result = { ...entry, items, cover };
    while (manifests.size >= 100) manifests.delete(manifests.keys().next().value);
    manifests.set(id, { value: result, time: now() }); return result;
  }
  return { list, pack };
}

const aliases = { '开心': 'happy', '笑': 'laugh', '笑死': 'funny', '搞笑': 'funny', '猫': 'cat', '猫咪': 'cat', '狗': 'dog', '狗狗': 'dog', '可爱': 'cute', '抱抱': 'hug', '爱': 'love', '爱你': 'love', '喜欢': 'love', '生气': 'angry', '无语': 'reaction', '晚安': 'sleep', '你好': 'hello', '谢谢': 'thanks', '哭': 'cry', '难过': 'sad', '小熊': 'bear', '兔子': 'bunny', '小黄人': 'minion', '海绵宝宝': 'spongebob', '皮卡丘': 'pikachu', '柴犬': 'shiba', '动漫': 'anime', '动画': 'animated', '龙猫': 'totoro', '青蛙': 'frog', '熊猫': 'panda', '仓鼠': 'hamster', '派大星': 'patrick', '打工': 'work', '收到': 'ok', '好的': 'ok', '加油': 'cheer', '庆祝': 'party', '亲亲': 'kiss', '思考': 'think', '赞': 'thumb', '早安': 'morning' };
export function matchStickerPacks(packs, keyword, animated = false) {
  const query = keyword.trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean).map(term => [term, aliases[term]].filter(Boolean));
  return packs.filter(pack => (!animated || pack.animated) && terms.every(alternatives => alternatives.some(term => `${pack.title} ${pack.author} ${pack.tags}`.toLocaleLowerCase().includes(term))));
}

export function publicStickerAnimated(bytes) {
  if (bytes.subarray(0, 3).toString() === 'GIF') return true;
  if (bytes.subarray(0, 4).toString() === 'RIFF') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4); if (bytes.subarray(offset, offset + 4).toString() === 'ANIM') return true;
      offset += 8 + size + (size % 2);
    }
  } else if (bytes[0] === 137) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset); if (bytes.subarray(offset + 4, offset + 8).toString() === 'acTL') return true;
      offset += 12 + size;
    }
  }
  return false;
}
