const API_ORIGIN = 'https://api.x.com';
const MEDIA_ORIGIN = 'https://video.twimg.com';
const COVER_ORIGIN = 'https://pbs.twimg.com';
const API_LIMIT = 512 * 1024;
const COVER_LIMIT = 256 * 1024;
const TEXT_LIMIT = 50_000;
const EXCERPT_LIMIT = 160;

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

function playableVariant(media) {
  if (!Array.isArray(media.variants)) return null;
  const variants = media.variants.flatMap(variant => {
    if (variant?.content_type !== 'video/mp4') return [];
    const url = cdnUrl(variant.url, MEDIA_ORIGIN);
    if (!url?.pathname.endsWith('.mp4')) return [];
    const bitrate = Number.isSafeInteger(variant.bit_rate) && variant.bit_rate > 0 ? variant.bit_rate : 0;
    return [{ url, bitrate }];
  }).sort((a, b) => a.bitrate - b.bitrate);
  return (variants.findLast(variant => variant.bitrate <= 2_500_000) ?? variants[0])?.url ?? null;
}

function postData(document, id, mediaEnabled) {
  const post = document.data;
  const author = Array.isArray(document.includes?.users)
    ? document.includes.users.find(user => user?.id === post?.author_id)
    : null;
  if (post?.id !== id || author?.protected !== false || post.withheld || author.withheld || post.possibly_sensitive === true) {
    throw new AixError(404, 'POST_UNAVAILABLE');
  }
  const username = typeof author.username === 'string' && /^\w{1,15}$/.test(author.username) ? `@${author.username}` : '';
  if (!username) throw new AixError(502, 'UPSTREAM_RESPONSE');
  const name = plainText(author.name, 260);
  const title = name ? `${name} · ${username}` : username;
  const text = plainText(post.note_tweet?.text ?? post.text, TEXT_LIMIT, true);
  const videos = [];
  if (mediaEnabled && Array.isArray(post.attachments?.media_keys) && Array.isArray(document.includes?.media)) {
    for (const key of new Set(post.attachments.media_keys.slice(0, 4))) {
      if (typeof key !== 'string' || !MEDIA_ID.test(key)) continue;
      const media = document.includes.media.find(item => item?.media_key === key && item.type === 'video');
      const url = media && playableVariant(media);
      if (!url) continue;
      const duration = media.duration_ms;
      const durationMs = Number.isSafeInteger(duration) && duration >= 1 && duration <= 86_400_000 ? duration : undefined;
      videos.push({ id: key, ...(durationMs === undefined ? {} : { durationMs }), url,
        coverUrl: cdnUrl(media.preview_image_url, COVER_ORIGIN) });
    }
  }
  return { title, text, videos };
}

export function createXProvider({ apiToken, mediaEnabled, fetch: fetchResource }) {
  async function lookup(postId, signal) {
    const url = new URL(`/2/tweets/${postId}`, API_ORIGIN);
    url.search = new URLSearchParams({
      'tweet.fields': 'author_id,attachments,note_tweet,possibly_sensitive,withheld',
      expansions: 'author_id,attachments.media_keys',
      'user.fields': 'name,username,protected,withheld',
      'media.fields': 'type,duration_ms,preview_image_url,variants',
    });
    const response = await fetchResource(url, { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
      redirect: 'error', signal });
    if ([403, 404, 451].includes(response.status) || response.status === 429) {
      await response.body?.cancel();
      throw response.status === 429 ? new AixError(503, 'UPSTREAM_BUSY') : new AixError(404, 'POST_UNAVAILABLE');
    }
    const bytes = await boundedBody(response, API_LIMIT);
    return postData(JSON.parse(bytes.toString('utf8')), postId, mediaEnabled);
  }

  async function preview(post, signal) {
    const description = plainText(post.text, EXCERPT_LIMIT);
    const videos = await Promise.all(post.videos.map(async ({ id, durationMs, coverUrl }) => {
      const cover = coverUrl ? await fetchCover(coverUrl, signal, fetchResource).catch(() => undefined) : undefined;
      return { id, ...(durationMs === undefined ? {} : { durationMs }), ...(cover ? { cover } : {}) };
    }));
    signal.throwIfAborted();
    return { title: post.title, description, canRead: post.text !== description, videos };
  }

  return { lookup, preview };
}

async function fetchCover(url, signal, fetchResource) {
  url.searchParams.set('format', 'jpg');
  url.searchParams.set('name', 'small');
  const coverSignal = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
  const response = await fetchResource(url, { headers: { Accept: 'image/jpeg' }, redirect: 'error', signal: coverSignal });
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg') {
    await response.body?.cancel();
    return undefined;
  }
  const bytes = await boundedBody(response, COVER_LIMIT);
  if (!boundedJpeg(bytes)) return undefined;
  return { mimeType: 'image/jpeg', data: bytes.toString('base64url') };
}

function boundedJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset++] === 0xff) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length || marker === 0xda || marker === 0xd9) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 && width <= 1_600 && height <= 1_600;
    }
    offset += length;
  }
  return false;
}
