import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { AixError, MEDIA_ID, POST_ID, POST_LOOKUP_ORIGIN, createXProvider } from './x-api.mjs';

const LOOKUP_PATH = '/v1/x/posts/lookup';
const MEDIA_PATH = /^\/v1\/x\/media\/([A-Za-z0-9_-]{43})$/;
const TICKET_TTL_MS = 15 * 60_000;
const MAX_REQUEST_BYTES = 1_024;
const MAX_VIDEO_BYTES = 768 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest();

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

async function readLookup(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AixError(415, 'JSON_REQUIRED');
  }
  if (Number(request.headers['content-length']) > MAX_REQUEST_BYTES) throw new AixError(413, 'REQUEST_SIZE');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new AixError(413, 'REQUEST_SIZE');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AixError(400, 'INVALID_LOOKUP');
  }
  const { action, postId, mediaId, ...extra } = body ?? {};
  if (!['preview', 'text', 'article', 'playback'].includes(action) || typeof postId !== 'string' || !POST_ID.test(postId)
    || Object.keys(extra).length || (action === 'playback' ? typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId) : mediaId !== undefined)) {
    throw new AixError(400, 'INVALID_LOOKUP');
  }
  return { action, postId, mediaId };
}

function parseRange(value) {
  if (value === undefined) return null;
  const parts = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(value);
  if (!parts || (!parts[1] && !parts[2])) throw new AixError(416, 'INVALID_RANGE');
  const start = parts[1] ? Number(parts[1]) : null;
  const end = parts[2] ? Number(parts[2]) : null;
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))
    || (start === null && end === 0) || (start !== null && end !== null && end < start)) {
    throw new AixError(416, 'INVALID_RANGE');
  }
  return { start, end };
}

function streamHeaders(upstream, range) {
  const length = Number(upstream.headers.get('content-length'));
  const mime = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const encoding = upstream.headers.get('content-encoding');
  if (mime !== 'video/mp4' || (encoding && encoding !== 'identity') || !Number.isSafeInteger(length)
    || length < 1 || length > MAX_VIDEO_BYTES || !upstream.body) throw new AixError(502, 'UPSTREAM_MEDIA');
  const headers = { 'Content-Type': 'video/mp4', 'Content-Length': length, 'Accept-Ranges': 'bytes' };
  if (!range && upstream.status === 200) return headers;
  const contentRange = upstream.headers.get('content-range') ?? '';
  const parts = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  if (!range || upstream.status !== 206 || !parts) throw new AixError(502, 'UPSTREAM_RANGE');
  const [first, last, total] = parts.slice(1).map(Number);
  const expectedFirst = range.start ?? Math.max(0, total - range.end);
  const expectedLast = range.start === null ? total - 1 : Math.min(range.end ?? total - 1, total - 1);
  if (!Number.isSafeInteger(total) || total > MAX_VIDEO_BYTES || last < first || length !== last - first + 1
    || first !== expectedFirst || last !== expectedLast) throw new AixError(502, 'UPSTREAM_RANGE');
  return { ...headers, 'Content-Range': contentRange };
}

async function streamVideo(request, response, { url }, signal, fetchResource) {
  const range = parseRange(request.headers.range);
  const upstreamTimeout = new AbortController();
  const timer = setTimeout(() => upstreamTimeout.abort(), 8_000);
  const streamSignal = AbortSignal.any([signal, upstreamTimeout.signal, AbortSignal.timeout(30 * 60_000)]);
  let upstream;
  try {
    upstream = await fetchResource(url, { redirect: 'error', signal: streamSignal, headers: {
      Accept: 'video/mp4', 'Accept-Encoding': 'identity', ...(range ? { Range: request.headers.range } : {}),
    } });
  } finally {
    clearTimeout(timer);
  }
  try {
    if (range && upstream.status === 416) {
      const contentRange = upstream.headers.get('content-range') ?? '';
      if (/^bytes \*\/\d{1,16}$/.test(contentRange)) response.setHeader('Content-Range', contentRange);
      throw new AixError(416, 'RANGE_NOT_SATISFIABLE');
    }
    const headers = streamHeaders(upstream, range);
    response.writeHead(upstream.status, headers);
    await pipeline(Readable.fromWeb(upstream.body), response, { signal: streamSignal });
  } finally {
    if (!upstream.body?.locked) await upstream.body?.cancel().catch(() => {});
  }
}

function createTickets(publicOrigin, now) {
  const entries = new Map();
  return {
    issue(url) {
      const time = now();
      for (const [token, entry] of entries) if (entry.expires <= time) entries.delete(token);
      if (entries.size >= 256) throw new AixError(503, 'MEDIA_BUSY');
      const token = randomBytes(32).toString('base64url');
      entries.set(token, { url, expires: time + TICKET_TTL_MS, active: 0 });
      return new URL(`/v1/x/media/${token}`, publicOrigin).href;
    },
    get(token) {
      const entry = entries.get(token);
      if (entry && entry.expires <= now()) entries.delete(token);
      return entries.get(token);
    },
  };
}

export function createAixServer({ gatewayToken, publicOrigin, mediaEnabled = false,
  fetch: fetchResource = globalThis.fetch, now = Date.now }) {
  const expectedAuthorization = digest(`Bearer ${gatewayToken}`);
  const provider = createXProvider({ mediaEnabled, fetch: fetchResource });
  const tickets = createTickets(publicOrigin, now);
  let lookups = 0;
  let streams = 0;

  async function handle(request, response, signal) {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'POST' && request.url === LOOKUP_PATH) {
      if (!timingSafeEqual(expectedAuthorization, digest(request.headers.authorization ?? ''))) throw new AixError(401, 'UNAUTHORIZED');
      if (lookups >= 4) throw new AixError(503, 'LOOKUP_BUSY');
      lookups++;
      try {
        const { action, postId, mediaId } = await readLookup(request);
        if (action === 'playback' && !mediaEnabled) throw new AixError(404, 'MEDIA_UNAVAILABLE');
        const upstreamSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
        const post = await provider.lookup(postId, upstreamSignal);
        if (action === 'preview') {
          sendJson(response, 200, await provider.preview(post, upstreamSignal));
        } else if (action === 'text') {
          sendJson(response, 200, { text: post.article?.text || post.text });
        } else if (action === 'article') {
          sendJson(response, 200, await provider.article(post, upstreamSignal));
        } else {
          const video = post.videos.find(item => item.id === mediaId);
          if (!video) throw new AixError(404, 'MEDIA_UNAVAILABLE');
          sendJson(response, 200, { url: tickets.issue(video.url) });
        }
      } finally {
        lookups--;
      }
      return;
    }

    const media = MEDIA_PATH.exec(request.url);
    if (!media || !['GET', 'OPTIONS'].includes(request.method)) throw new AixError(404, 'NOT_FOUND');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Range' }).end();
      return;
    }
    response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range');
    const ticket = tickets.get(media[1]);
    if (!ticket) throw new AixError(410, 'MEDIA_EXPIRED');
    if (streams >= 8 || ticket.active >= 4) throw new AixError(503, 'MEDIA_BUSY');
    streams++;
    ticket.active++;
    try {
      await streamVideo(request, response, ticket, signal, fetchResource);
    } finally {
      streams--;
      ticket.active--;
    }
  }

  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8 * 1024 }, (request, response) => {
    const client = new AbortController();
    response.once('close', () => { if (!response.writableFinished) client.abort(); });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    handle(request, response, client.signal).catch(error => {
      if (!response.destroyed && !response.headersSent) {
        if (!request.complete) response.setHeader('Connection', 'close');
        const failure = error instanceof AixError ? error : new AixError(502, 'UPSTREAM_UNAVAILABLE');
        sendJson(response, failure.status, { error: failure.message });
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });
  server.setTimeout(30_000, socket => socket.destroy());
  return server;
}

function validatedUrl(value, predicate, configName) {
  const url = URL.parse(value ?? '');
  if (!url || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !predicate(url)) {
    throw new Error(`INVALID_${configName}`);
  }
  return url.origin;
}

function startService(env) {
  const { AIX_GATEWAY_TOKEN: gatewayToken } = env;
  if (!gatewayToken || !/^[A-Za-z0-9_-]{32,256}$/.test(gatewayToken)) throw new Error('INVALID_AIX_GATEWAY_TOKEN');
  const port = Number(env.AIX_PORT ?? '18087');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('INVALID_AIX_PORT');
  const publicOrigin = validatedUrl(env.AIX_PUBLIC_ORIGIN, url => url.protocol === 'https:', 'AIX_PUBLIC_ORIGIN');
  if (env.AIX_XRAY_PROXY) {
    const proxy = URL.parse(env.AIX_XRAY_PROXY);
    const validCredentials = proxy && ((!proxy.username && !proxy.password)
      || (/^[A-Za-z0-9_-]+$/.test(proxy.username) && /^[A-Za-z0-9_-]+$/.test(proxy.password)));
    if (!validCredentials || proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port
      || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('INVALID_AIX_XRAY_PROXY');
    if (typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('AIX_XRAY_PROXY_REQUIRES_NODE_24_14');
    http.setGlobalProxyFromEnv({ https_proxy: proxy.href, no_proxy: `127.0.0.1,${new URL(POST_LOOKUP_ORIGIN).hostname}` });
  }
  const mediaEnabled = env.AIX_MEDIA_ENABLED === 'true';
  createAixServer({ gatewayToken, publicOrigin, mediaEnabled }).listen(port, '127.0.0.1');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) startService(process.env);
