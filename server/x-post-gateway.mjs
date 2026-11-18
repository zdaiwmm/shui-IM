export const X_POST_MEDIA_ORIGIN = 'https://aix.shui.click';
const POST_ID = /^\d{1,20}$/;
const MEDIA_ID = /^\w{1,64}$/;
const MEDIA_PATH = /^\/v1\/x\/media\/[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 1536 * 1024;

export function xPostRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { action, postId, mediaId } = value;
  if (typeof postId !== 'string' || !POST_ID.test(postId)) return;
  if (action === 'playback' && Object.keys(value).length === 3 && typeof mediaId === 'string' && MEDIA_ID.test(mediaId)) {
    return { action, postId, mediaId };
  }
  if ((action === 'preview' || action === 'text') && Object.keys(value).length === 2) return { action, postId };
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
    if (['image/jpeg', 'image/png', 'image/webp'].includes(item.cover?.mimeType)
      && typeof item.cover.data === 'string' && item.cover.data.length <= Math.ceil(256 * 1024 * 4 / 3)
      && /^[A-Za-z0-9_-]+$/.test(item.cover.data)) video.cover = { mimeType: item.cover.mimeType, data: item.cover.data };
    return video;
  });
  return { title: value.title, description: value.description, canRead: value.canRead, videos };
}

export function createXPostGateway({ token, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return null;
  return async (packet, signal) => {
    const response = await fetchImpl(`${X_POST_MEDIA_ORIGIN}/v1/x/posts/lookup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(packet),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 404 ? 'X_POST_NOT_FOUND' : 'X_POST_UNAVAILABLE');
    }
    const value = await boundedJson(response, MAX_RESPONSE_BYTES);
    if (packet.action === 'preview') return previewResult(value);
    if (packet.action === 'text' && typeof value?.text === 'string' && value.text.length > 0 && value.text.length <= 50_000) return { text: value.text };
    if (packet.action === 'playback' && typeof value?.url === 'string') {
      const url = new URL(value.url);
      if (value.url === `${X_POST_MEDIA_ORIGIN}${url.pathname}` && MEDIA_PATH.test(url.pathname)) return { url: value.url };
    }
    throw new Error('X_POST_UNAVAILABLE');
  };
}
