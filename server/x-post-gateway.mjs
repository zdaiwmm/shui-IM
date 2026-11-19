import { parseXArticle, xArticleMetadata } from '../src/lib/x-article-data.mjs';

export const X_POST_MEDIA_ORIGIN = 'https://aix.shui.click';
const POST_ID = /^\d{1,20}$/;
const MEDIA_ID = /^\w{1,64}$/;
const MEDIA_PATH = /^\/v1\/x\/media\/[A-Za-z0-9_-]{43}$/;
const YOUTUBE_MEDIA_PATH = /^\/v1\/youtube\/media\/[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 1536 * 1024;

export function xPostRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { action, postId, mediaId } = value;
  if (typeof postId !== 'string' || !POST_ID.test(postId)) return;
  if (action === 'playback' && Object.keys(value).length === 3 && typeof mediaId === 'string' && MEDIA_ID.test(mediaId)) {
    return { action, postId, mediaId };
  }
  if (['preview', 'text', 'article', 'article-body'].includes(action) && Object.keys(value).length === 2) return { action, postId };
}

async function boundedJson(response, limit) {
  if (!response.body || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
    || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('X_POST_UNAVAILABLE');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('X_POST_UNAVAILABLE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function cleanPreviewText(value, limit) {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
}

function previewCover(value) {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(value?.mimeType)
    && typeof value.data === 'string' && value.data.length <= Math.ceil(256 * 1024 * 4 / 3)
    && /^[A-Za-z0-9_-]+$/.test(value.data)) return { mimeType: value.mimeType, data: value.data };
}

function previewResult(value) {
  if (!value || !cleanPreviewText(value.title, 300) || !value.title.trim()
    || !cleanPreviewText(value.description, 600) || typeof value.canRead !== 'boolean'
    || !Array.isArray(value.videos) || value.videos.length > 4) throw new Error('X_POST_UNAVAILABLE');
  const ids = new Set();
  const videos = value.videos.map(item => {
    if (typeof item?.id !== 'string' || !MEDIA_ID.test(item.id) || ids.has(item.id)) throw new Error('X_POST_UNAVAILABLE');
    ids.add(item.id);
    const video = { id: item.id };
    if (Number.isInteger(item.durationMs) && item.durationMs > 0 && item.durationMs <= 86_400_000) video.durationMs = item.durationMs;
    const cover = previewCover(item.cover);
    if (cover) video.cover = cover;
    return video;
  });
  const article = value.article === undefined ? undefined : xArticleMetadata(value.article);
  if (value.article !== undefined && !article) throw new Error('X_POST_UNAVAILABLE');
  const cover = article && previewCover(value.cover);
  return { title: value.title, description: value.description, canRead: value.canRead, videos,
    ...(article ? { article } : {}), ...(cover ? { cover } : {}) };
}

function createLookup({ token, fetchImpl = fetch, path, timeout, notFound, unavailable, limit }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return null;
  return async (packet, signal) => {
    const response = await fetchImpl(`${X_POST_MEDIA_ORIGIN}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(packet),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 404 ? notFound : unavailable);
    }
    return boundedJson(response, limit);
  };
}

function playbackResult(value, path) {
  const url = typeof value?.url === 'string' && URL.parse(value.url);
  if (url && value.url === `${X_POST_MEDIA_ORIGIN}${url.pathname}` && path.test(url.pathname)) return { url: value.url };
}

export function createXPostGateway(options = {}) {
  const lookup = createLookup({ ...options, path: '/v1/x/posts/lookup', timeout: 10_000, limit: MAX_RESPONSE_BYTES,
    notFound: 'X_POST_NOT_FOUND', unavailable: 'X_POST_UNAVAILABLE' });
  if (!lookup) return null;
  return async (packet, signal) => {
    const value = await lookup(packet, signal);
    if (packet.action === 'preview') return previewResult(value);
    if (packet.action === 'article' || packet.action === 'article-body') {
      const article = parseXArticle(value);
      if (article && (packet.action === 'article' || article.blocks.every(block => block.kind !== 'image'))) return article;
    }
    if (packet.action === 'text' && typeof value?.text === 'string' && value.text.length > 0 && value.text.length <= 50_000) return { text: value.text };
    if (packet.action === 'playback') {
      const result = playbackResult(value, MEDIA_PATH);
      if (result) return result;
    }
    throw new Error('X_POST_UNAVAILABLE');
  };
}

export function youtubeRequest(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2) return;
  const { action, videoId } = value;
  if (['preview', 'playback'].includes(action) && typeof videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return { action, videoId };
  }
}

export function createYouTubeGateway(options = {}) {
  const lookup = createLookup({ ...options, path: '/v1/youtube/videos/lookup', timeout: 15_000, limit: 192 * 1024,
    notFound: 'YOUTUBE_NOT_FOUND', unavailable: 'YOUTUBE_UNAVAILABLE' });
  if (!lookup) return null;
  return async (packet, signal) => {
    const value = await lookup(packet, signal);
    if (packet.action === 'playback') {
      const result = playbackResult(value, YOUTUBE_MEDIA_PATH);
      if (result) return result;
    } else if (cleanPreviewText(value?.title, 300) && value.title.trim() && cleanPreviewText(value.channel, 260)
      && typeof value.description === 'string' && value.description.length <= 5_000
      && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value.description)
      && typeof value.playable === 'boolean') {
      const { title, channel, description, playable, durationMs, cover } = value;
      const result = { title, channel, description, playable };
      if (Number.isInteger(durationMs) && durationMs > 0 && durationMs <= 86_400_000) result.durationMs = durationMs;
      if (cover?.mimeType === 'image/jpeg' && typeof cover.data === 'string' && cover.data.length <= Math.ceil(128 * 1024 * 4 / 3)
        && /^[A-Za-z0-9_-]+$/.test(cover.data)) result.cover = { mimeType: cover.mimeType, data: cover.data };
      return result;
    }
    throw new Error('YOUTUBE_UNAVAILABLE');
  };
}
