export const POST_LOOKUP_ORIGIN = 'https://api.fxtwitter.com';
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
  return { title, text, videos };
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
