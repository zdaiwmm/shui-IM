export const POST_LOOKUP_ORIGIN = 'https://api.fxtwitter.com';
const MEDIA_ORIGIN = 'https://video.twimg.com';
const COVER_ORIGIN = 'https://pbs.twimg.com';
const API_LIMIT = 512 * 1024;
const COVER_LIMIT = 256 * 1024;
const TEXT_LIMIT = 50_000;
const EXCERPT_LIMIT = 160;
const ARTICLE_BLOCK_LIMIT = 512;
const ARTICLE_RUN_LIMIT = 2_048;
const ARTICLE_RANGE_LIMIT = 128;
const ARTICLE_URL_BUDGET = 64 * 1024;
const ARTICLE_IMAGE_BUDGET = 768 * 1024;
const ARTICLE_RESPONSE_LIMIT = 1536 * 1024;
const ARTICLE_IMAGE_REQUESTS = 24;
const ARTICLE_MEDIA_CONCURRENCY = 4;
const ARTICLE_STYLES = new Map([
  ['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'],
  ['strikethrough', 'strike'], ['code', 'code'],
]);

export const POST_ID = /^\d{1,20}$/;
export const MEDIA_ID = /^\w{1,64}$/;

export class AixError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function cdnUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}

async function boundedBody(response, maxBytes) {
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes || !response.body) {
    await response.body?.cancel();
    throw new AixError(502, 'UPSTREAM_RESPONSE');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new AixError(502, 'UPSTREAM_SIZE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function plainText(value, maxLength, preserveLines = false) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  const text = preserveLines ? clean : clean.replace(/[\u200b-\u200d]/g, '').replace(/\s+/g, ' ');
  return text.trim().slice(0, maxLength).replace(/[\ud800-\udbff]$/u, '').trimEnd();
}

function articleText(value) {
  return value.toWellFormed().replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

function canonicalPostUrl(id) {
  return `https://x.com/i/web/status/${id}`;
}

function articleLink(value) {
  if (typeof value !== 'string' || value.length > 2_048 || /[\u0000-\u0020\u007f]/.test(value)) return;
  const url = URL.parse(value);
  if (url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2_048) {
    return url.href;
  }
}

function rangeWithin(start, end, text) {
  const splitSurrogate = index => /[\ud800-\udbff]/.test(text[index - 1] ?? '') && /[\udc00-\udfff]/.test(text[index] ?? '');
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end && end <= text.length
    && !splitSurrogate(start) && !splitSurrogate(end);
}

function boundedArray(value) {
  return Array.isArray(value) ? value.slice(0, ARTICLE_RANGE_LIMIT) : [];
}

function entityReference(entities, range) {
  return Number.isSafeInteger(range?.key) ? entities.get(String(range.key)) : undefined;
}

function articleRuns(block, source, start, end, entities, budget) {
  if (start >= end || budget.text <= 0) return [];
  const text = source.slice(start, Math.min(end, start + budget.text)).replace(/[\ud800-\udbff]$/u, '');
  if (!text.length) return [];
  const ranges = [];
  const add = (from, to, marks) => {
    if (!rangeWithin(from, to, source)) return;
    const first = Math.max(0, from - start);
    const last = Math.min(text.length, to - start);
    if (first < last) ranges.push({ first, last, marks });
  };
  for (const style of boundedArray(block.inlineStyleRanges)) {
    const mark = typeof style?.style === 'string' && ARTICLE_STYLES.get(style.style.toLowerCase());
    if (mark) add(style.offset, style.offset + style.length, { [mark]: true });
  }
  for (const link of boundedArray(block.data?.urls)) {
    const href = articleLink(link?.text);
    if (href) add(link.fromIndex, link.toIndex, { href });
  }
  for (const entity of boundedArray(block.entityRanges)) {
    const value = entityReference(entities, entity);
    const href = value?.type === 'LINK' && articleLink(value.data?.url);
    if (href) add(entity.offset, entity.offset + entity.length, { href });
  }
  const edges = [...new Set([0, text.length, ...ranges.flatMap(({ first, last }) => [first, last])])].sort((a, b) => a - b);
  const maxRuns = Math.max(1, budget.runs - (ARTICLE_BLOCK_LIMIT - budget.blocks - 1));
  const runs = [];
  for (let index = 0; index < edges.length - 1; index++) {
    const first = edges[index];
    if (runs.length + 1 === maxRuns && index < edges.length - 2) {
      const tail = articleText(text.slice(first));
      if (tail) runs.push({ text: tail });
      break;
    }
    const last = edges[index + 1];
    const output = articleText(text.slice(first, last));
    if (!output) continue;
    const marks = {};
    for (const range of ranges) {
      if (range.first <= first && range.last >= last) Object.assign(marks, range.marks);
    }
    if (marks.href) {
      if (marks.href.length > budget.urls) delete marks.href;
      else budget.urls -= marks.href.length;
    }
    runs.push({ text: output, ...marks });
  }
  budget.text -= runs.reduce((length, run) => length + run.text.length, 0);
  budget.runs -= runs.length;
  return runs;
}

function articleBlockType(block) {
  switch (block.type) {
    case 'header-one': return { kind: 'heading', level: 2 };
    case 'header-two': return { kind: 'heading', level: 3 };
    case 'header-three': return { kind: 'heading', level: 4 };
    case 'blockquote': return { kind: 'quote' };
    case 'code-block': return { kind: 'code' };
    case 'ordered-list-item':
    case 'unordered-list-item':
      return { kind: 'list-item', ordered: block.type === 'ordered-list-item',
        depth: Number.isSafeInteger(block.depth) && block.depth >= 0 ? Math.min(block.depth, 4) : 0 };
    default: return { kind: 'paragraph' };
  }
}

function articlePhoto(item, block, source) {
  const info = item?.media_info;
  const href = canonicalPostUrl(source);
  const url = info?.__typename === 'ApiImage' ? cdnUrl(info.original_img_url, COVER_ORIGIN) : null;
  if (!url || !/^\/media\/[a-z0-9_-]+(?:\.[a-z0-9]+)?$/i.test(url.pathname)) {
    const video = ['ApiVideo', 'ApiGif'].includes(info?.__typename);
    return { kind: 'link', href, label: video ? 'Video on X' : 'Image on X' };
  }
  url.search = '';
  const alt = plainText(info.ext_alt_text ?? item.ext_alt_text ?? block?.data?.altText, 300);
  const caption = plainText(block?.data?.caption, 300, true);
  return { kind: 'photo', url, alt, ...(caption ? { caption } : {}), fallback: { kind: 'link', href, label: 'Image on X' } };
}

function normalizeArticle(raw, author, source) {
  const title = plainText(raw?.title, 300);
  if (!title) return undefined;
  const summary = plainText(raw.preview_text, EXCERPT_LIMIT);
  const entries = Array.isArray(raw.content?.entityMap) ? raw.content.entityMap.slice(0, ARTICLE_BLOCK_LIMIT) : [];
  const entities = new Map(entries.filter(entry => entry && typeof entry.key === 'string').map(entry => [entry.key, entry.value]));
  const assets = new Map();
  for (const item of boundedArray(raw.media_entities)) {
    for (const id of [item?.media_id, item?.id, item?.media_key]) if (typeof id === 'string') assets.set(id, item);
  }
  const budget = { blocks: 0, runs: ARTICLE_RUN_LIMIT, text: TEXT_LIMIT, urls: ARTICLE_URL_BUDGET };
  const blocks = [];
  const append = value => {
    if (budget.blocks < ARTICLE_BLOCK_LIMIT) {
      blocks.push(value);
      budget.blocks++;
    }
  };
  const cover = raw.cover_media && articlePhoto(raw.cover_media, null, source);
  if (cover) append(cover);
  const contentStart = blocks.length;
  for (const block of Array.isArray(raw.content?.blocks) ? raw.content.blocks.slice(0, ARTICLE_BLOCK_LIMIT) : []) {
    if (budget.blocks >= ARTICLE_BLOCK_LIMIT) break;
    if (!block || typeof block.text !== 'string') continue;
    if (['horizontal-rule', 'divider'].includes(block.type)) {
      append({ kind: 'divider' });
      continue;
    }
    const text = block.text;
    const placement = boundedArray(block.entityRanges).flatMap(range => {
      const value = entityReference(entities, range);
      if (!range || !['MEDIA', 'TWEET', 'MARKDOWN'].includes(value?.type)
        || !rangeWithin(range.offset, range.offset + range.length, text)) return [];
      return [{ offset: range.offset, end: range.offset + range.length, value }];
    }).sort((a, b) => a.offset - b.offset);
    const appendText = (first, last) => {
      if (budget.blocks >= ARTICLE_BLOCK_LIMIT) return;
      const runs = articleRuns(block, text, first, last, entities, budget);
      if (runs.length || block.type === 'unstyled' && !text.length) append({ ...articleBlockType(block), runs });
    };
    let start = 0;
    for (const { offset, end, value } of placement) {
      if (offset < start || budget.blocks >= ARTICLE_BLOCK_LIMIT) continue;
      if (offset > start) appendText(start, offset);
      if (value.type === 'MEDIA') {
        for (const media of boundedArray(value.data?.mediaItems)) append(articlePhoto(assets.get(media?.mediaId), block, source));
      } else if (value.type === 'TWEET') {
        const tweet = value.data?.tweetId;
        if (typeof tweet === 'string' && POST_ID.test(tweet)) append({ kind: 'link', href: canonicalPostUrl(tweet), label: 'Post on X' });
      } else if (typeof value.data?.markdown === 'string' && budget.text > 0 && budget.blocks < ARTICLE_BLOCK_LIMIT) {
        const fence = /^```[^\n]*\n([\s\S]*?)\n```\s*$/u.exec(value.data.markdown);
        const raw = fence?.[1] ?? value.data.markdown;
        const text = articleText(raw.slice(0, budget.text).replace(/[\ud800-\udbff]$/u, ''));
        if (text) {
          append({ kind: fence ? 'code' : 'quote', runs: [{ text }] });
          budget.text -= text.length;
          budget.runs--;
        }
      }
      start = end;
    }
    if (start < text.length || !text.length && !placement.length) appendText(start, text.length);
  }
  const ordered = blocks.slice(contentStart);
  const text = ordered.map(block => block.runs?.map(run => run.text).join('') ?? block.caption ?? '').filter(Boolean)
    .join('\n\n').slice(0, TEXT_LIMIT).replace(/[\ud800-\udbff]$/u, '');
  return { title, author, summary: summary || plainText(text, EXCERPT_LIMIT), text, blocks, hasBody: ordered.some(block =>
    block.kind !== 'divider' && (block.kind === 'photo' || block.kind === 'link' || block.runs?.some(run => run.text.trim()))) };
}

function playableVariant(media) {
  const formats = Array.isArray(media.formats) ? media.formats : [];
  const variants = formats.flatMap(variant => {
    if (variant?.container !== 'mp4') return [];
    const url = cdnUrl(variant.url, MEDIA_ORIGIN);
    if (!url?.pathname.endsWith('.mp4')) return [];
    const bitrate = Number.isSafeInteger(variant.bitrate) && variant.bitrate > 0 ? variant.bitrate : 0;
    return [{ url, bitrate }];
  }).sort((a, b) => a.bitrate - b.bitrate);
  const selected = variants.findLast(variant => variant.bitrate <= 2_500_000) ?? variants[0];
  if (selected) return selected.url;
  const fallback = media.format === 'video/mp4' ? cdnUrl(media.url, MEDIA_ORIGIN) : null;
  return fallback?.pathname.endsWith('.mp4') ? fallback : null;
}

function postData(post, id, mediaEnabled) {
  const author = post?.author;
  if (post?.type !== 'status' || post.id !== id || author?.protected !== false
    || post.withheld || author.withheld || post.possibly_sensitive !== false) {
    throw new AixError(404, 'POST_UNAVAILABLE');
  }
  const username = typeof author.screen_name === 'string' && /^\w{1,15}$/.test(author.screen_name)
    ? `@${author.screen_name}` : '';
  if (!username) throw new AixError(502, 'UPSTREAM_RESPONSE');
  const name = plainText(author.name, 260);
  const title = name ? `${name} · ${username}` : username;
  const text = plainText(post.text, TEXT_LIMIT, true);
  const videos = [];
  if (mediaEnabled && Array.isArray(post.media?.videos)) {
    const seen = new Set();
    for (const media of post.media.videos.slice(0, 4)) {
      if (media?.type !== 'video' || typeof media.id !== 'string' || !MEDIA_ID.test(media.id) || seen.has(media.id)) continue;
      const url = playableVariant(media);
      if (!url) continue;
      seen.add(media.id);
      const durationMs = typeof media.duration === 'number' ? Math.round(media.duration * 1_000) : NaN;
      videos.push({ id: media.id, ...(durationMs >= 1 && durationMs <= 86_400_000 ? { durationMs } : {}), url,
        coverUrl: cdnUrl(media.thumbnail_url, COVER_ORIGIN) });
    }
  }
  return { title, text, videos, article: normalizeArticle(post.article, title, id) };
}

function lookupError(code) {
  if (code === 429) return new AixError(503, 'UPSTREAM_BUSY');
  if ([401, 403, 404, 451].includes(code)) return new AixError(404, 'POST_UNAVAILABLE');
  return new AixError(502, 'UPSTREAM_RESPONSE');
}

export function createXProvider({ mediaEnabled, fetch: fetchResource }) {
  async function lookup(postId, signal) {
    const url = new URL(`/2/status/${postId}`, POST_LOOKUP_ORIGIN);
    const response = await fetchResource(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw lookupError(response.status);
    }
    const bytes = await boundedBody(response, API_LIMIT);
    const document = JSON.parse(bytes.toString('utf8'));
    if (document?.code !== 200) throw lookupError(document?.code);
    return postData(document.status, postId, mediaEnabled);
  }

  async function preview(post, signal) {
    const description = post.article?.summary || plainText(post.text, EXCERPT_LIMIT);
    const videos = await Promise.all(post.videos.map(async ({ id, durationMs, coverUrl }) => {
      const cover = coverUrl ? await fetchCover(coverUrl, signal, fetchResource).catch(() => undefined) : undefined;
      return { id, ...(durationMs === undefined ? {} : { durationMs }), ...(cover ? { cover } : {}) };
    }));
    signal.throwIfAborted();
    const article = post.article && { title: post.article.title, author: post.article.author };
    return { title: post.title, description, canRead: Boolean(article) || post.text !== description, videos,
      ...(article ? { article } : {}) };
  }

  async function article(post, signal) {
    if (!post.article?.hasBody) throw new AixError(404, 'ARTICLE_UNAVAILABLE');
    signal.throwIfAborted();
    const { title, author, blocks } = post.article;
    const result = { title, author, blocks: blocks.map(block => block.kind === 'photo' ? block.fallback : block) };
    if (!mediaEnabled) return result;
    const requests = new Map();
    for (const [index, block] of blocks.entries()) {
      if (block.kind !== 'photo') continue;
      const href = block.url.href;
      if (requests.has(href)) requests.get(href).indexes.push(index);
      else if (requests.size < ARTICLE_IMAGE_REQUESTS) requests.set(href, { url: block.url, indexes: [index] });
    }
    const images = [...requests.values()];
    const imageSignal = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
    let rawRemaining = ARTICLE_IMAGE_BUDGET;
    let encodedRemaining = ARTICLE_RESPONSE_LIMIT - Buffer.byteLength(JSON.stringify(result));
    for (let offset = 0; offset < images.length && rawRemaining && !imageSignal.aborted; offset += ARTICLE_MEDIA_CONCURRENCY) {
      const batch = images.slice(offset, offset + ARTICLE_MEDIA_CONCURRENCY);
      const fetched = await Promise.all(batch.map(({ url }) => fetchJpeg(url, imageSignal, fetchResource, 'medium').catch(() => undefined)));
      for (const [position, item] of fetched.entries()) {
        if (!item) continue;
        const { image, bytes } = item;
        for (const index of batch[position].indexes) {
          if (bytes > rawRemaining) break;
          const { alt, caption } = blocks[index];
          const replacement = { kind: 'image', alt, ...(caption ? { caption } : {}), image };
          const delta = Buffer.byteLength(JSON.stringify(replacement)) - Buffer.byteLength(JSON.stringify(result.blocks[index]));
          if (delta > encodedRemaining) continue;
          result.blocks[index] = replacement;
          rawRemaining -= bytes;
          encodedRemaining -= delta;
        }
      }
    }
    signal.throwIfAborted();
    return result;
  }

  return { lookup, preview, article };
}

async function fetchCover(url, signal, fetchResource) {
  const coverSignal = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
  const result = await fetchJpeg(url, coverSignal, fetchResource, 'small');
  if (result) return { mimeType: result.image.mimeType, data: result.image.data };
}

async function fetchJpeg(url, signal, fetchResource, size) {
  const target = new URL(url);
  target.searchParams.set('format', 'jpg');
  target.searchParams.set('name', size);
  const response = await fetchResource(target, { headers: { Accept: 'image/jpeg' }, redirect: 'error', signal });
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg') {
    await response.body?.cancel();
    return undefined;
  }
  const bytes = await boundedBody(response, COVER_LIMIT);
  const dimensions = jpegDimensions(bytes, size === 'medium');
  if (!dimensions) return undefined;
  return { image: { mimeType: 'image/jpeg', data: bytes.toString('base64url'), ...dimensions }, bytes: bytes.length };
}

function jpegDimensions(bytes, requireScan) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8
    || requireScan && (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)) return undefined;
  let offset = 2;
  let frame;
  while (offset + 4 <= bytes.length && bytes[offset++] === 0xff) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length || marker === 0xd9) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (marker === 0xda) return requireScan && length >= 6 && offset + length < bytes.length - 2 ? frame : undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > 1_600 || height > 1_600 || frame) return undefined;
      if (!requireScan) return { width, height };
      const components = bytes[offset + 7];
      if (![0xc0, 0xc1, 0xc2].includes(marker) || bytes[offset + 2] !== 8 || ![1, 3].includes(components)
        || length !== 8 + 3 * components) return undefined;
      frame = { width, height };
    }
    offset += length;
  }
  return undefined;
}
