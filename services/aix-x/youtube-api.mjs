import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AixError, boundedBody, plainText } from './x-api.mjs';

const run = promisify(execFile);
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const METADATA_TTL = 120_000;
const MAX_VIDEO_BYTES = 768 * 1024 * 1024;

export function createYouTubeExtractor({ binary = 'yt-dlp', proxy } = {}) {
  return async (id, signal) => {
    const args = [
      '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-playlist', '--skip-download',
      '--no-check-formats', '--ignore-no-formats-error', '--socket-timeout', '5', '--extractor-retries', '0',
      '--dump-single-json', ...(proxy ? [] : ['--proxy', '']), '--', `https://www.youtube.com/watch?v=${id}`,
    ];
    const { stdout } = await run(binary, args, {
      signal, timeout: 11_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...(proxy ? { http_proxy: proxy, https_proxy: proxy } : {}) },
    });
    return JSON.parse(stdout);
  };
}

function supportedVideo(data, id) {
  return data?.id === id && data.extractor_key === 'Youtube' && data.availability === 'public'
    && !(data.age_limit >= 18) && !data.is_live && !['is_live', 'is_upcoming', 'post_live'].includes(data.live_status);
}

function streamFormat(format, duration) {
  if (format?.ext !== 'mp4' || format.protocol !== 'https' || format.has_drm || format.fragments
    || !/^avc[13]\./i.test(format.vcodec) || !/^mp4a\./i.test(format.acodec)
    || !/^\d{1,8}$/.test(format.format_id) || !(format.width > 0 && format.height > 0)
    || Math.min(format.width, format.height) > 720 || Math.max(format.width, format.height) > 1280
    || (format.filesize ?? format.filesize_approx) > MAX_VIDEO_BYTES
    || typeof format.url !== 'string' || format.url.length > 8192) return;
  const url = URL.parse(format.url);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !/^[a-z0-9-]+\.googlevideo\.com$/.test(url.hostname) || url.pathname !== '/videoplayback') return;
  const bitrate = format.tbr || format.filesize * 8 / duration / 1000;
  if (!(bitrate > 0 && bitrate <= 2500)) return;
  const userAgent = format.http_headers?.['User-Agent'];
  const headers = typeof userAgent === 'string' && /^[ -~]{1,512}$/.test(userAgent)
    ? { 'User-Agent': userAgent }
    : {};
  return { url, headers, formatId: format.format_id, size: format.filesize, bitrate };
}

function streamFormats(data) {
  return (Array.isArray(data.formats) ? data.formats : [])
    .map(format => streamFormat(format, data.duration)).filter(Boolean).sort((a, b) => b.bitrate - a.bitrate);
}

export function createYouTubeProvider({ extract, fetch: fetchResource, now }) {
  const cached = new Map();

  async function lookup(id, signal) {
    if (!YOUTUBE_VIDEO_ID.test(id)) throw new AixError(400, 'INVALID_LOOKUP');
    const data = await extract(id, signal);
    signal.throwIfAborted();
    if (!supportedVideo(data, id)) throw new AixError(404, 'VIDEO_UNAVAILABLE');
    return data;
  }

  async function preview(id, signal) {
    const current = cached.get(id);
    if (current && current.expires > now()) return current.value;
    const data = await lookup(id, signal);
    const title = plainText(data.title, 300);
    if (!title) throw new AixError(502, 'UPSTREAM_RESPONSE');
    const channel = plainText(data.channel || data.uploader, 260);
    const description = plainText(data.description, 5_000, true);
    const durationMs = Math.round(data.duration * 1000);
    const playable = streamFormats(data).length > 0;
    const cover = await fetchCover(id, signal, fetchResource).catch(() => undefined);
    signal.throwIfAborted();
    const value = { title, channel, description, playable, ...(cover ? { cover } : {}),
      ...(durationMs > 0 && durationMs <= 86_400_000 ? { durationMs } : {}) };
    cached.delete(id);
    if (cached.size >= 128) cached.delete(cached.keys().next().value);
    cached.set(id, { value, expires: now() + METADATA_TTL });
    return value;
  }

  async function playback(id, signal, previous) {
    const data = await lookup(id, signal);
    const selected = streamFormats(data).find(item => !previous ||
      item.formatId === previous.formatId && item.size === previous.size);
    if (!selected) throw new AixError(404, 'VIDEO_UNAVAILABLE');
    return selected;
  }

  return { preview, playback };
}

async function fetchCover(id, signal, fetchResource) {
  const cover = await fetchResource(new URL(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`), {
    headers: { Accept: 'image/jpeg' }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(2_500)]),
  });
  if (cover.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg') {
    await cover.body?.cancel();
    return undefined;
  }
  const bytes = await boundedBody(cover, 128 * 1024);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    return { mimeType: 'image/jpeg', data: bytes.toString('base64url') };
  }
}
