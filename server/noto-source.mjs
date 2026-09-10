export const NOTO_DIRECTORY = 'https://googlefonts.github.io/noto-emoji-animation/data/api.json';
export function createNotoSource(fetchResource, now = Date.now) {
  let cache; let refreshed = -Infinity;
  async function list(signal) {
    signal?.throwIfAborted();
    if (cache && now() - refreshed < 3600000) return cache;
    const data = JSON.parse((await fetchResource(NOTO_DIRECTORY, 8 * 1024 * 1024, signal)).toString('utf8'));
    if (!Array.isArray(data.icons) || data.icons.length > 10000) throw new Error('MEME_INVALID_CATALOG');
    cache = data.icons.filter(item => /^[a-f0-9]{4,6}(?:_[a-f0-9]{4,6}){0,10}$/.test(item.codepoint)).map(item => {
      const tags = [...(Array.isArray(item.tags) ? item.tags : []), ...(Array.isArray(item.categories) ? item.categories : [])].filter(x => typeof x === 'string');
      const title = (tags[0] || item.codepoint).replace(/:/g, '').replace(/-/g, ' ').slice(0, 120);
      return { id: `noto-${item.codepoint}`, title, tags: tags.join(' ').slice(0, 2048), author: 'Google Noto Emoji · CC BY 4.0', animated: true,
        source: 'https://googlefonts.github.io/noto-emoji-animation/', url: `https://fonts.gstatic.com/s/e/notoemoji/latest/${item.codepoint}/512.webp` };
    });
    if (!cache.length) throw new Error('MEME_INVALID_CATALOG');
    refreshed = now(); return cache;
  }
  async function pack(id, signal) {
    const row = (await list(signal)).find(row => row.id === id);
    if (!row) throw new Error('MEME_NOT_FOUND');
    const item = { id: 0, title: row.title, url: row.url };
    return { ...row, cover: item, items: [item] };
  }
  return { list, pack };
}
