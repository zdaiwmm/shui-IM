import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createAixServer } from './index.mjs';

const gatewayToken = 'test-gateway-token-000000000000000000000';
const apiToken = 'test-x-api-token';
const publicOrigin = 'https://aix.shui.click';
const clipA = '7_123';
const clipB = '7_456';
const jpeg = Buffer.from('ffd8ffc00008080002000300ffd9', 'hex');
const pixels = Buffer.from('0123456789');

function media(id, name, extra = {}) {
  return { media_key: id, type: 'video', duration_ms: 2_000, ...extra, variants: [
    { content_type: 'application/x-mpegURL', url: `https://video.twimg.com/${name}.m3u8` },
    { content_type: 'video/mp4', bit_rate: 2_300_000, url: `https://video.twimg.com/${name}.mp4` },
    { content_type: 'video/mp4', bit_rate: 1_800_000, url: `https://video.twimg.com/${name}-low.mp4` },
    { content_type: 'video/mp4', bit_rate: 3_500_000, url: `https://video.twimg.com/${name}-high.mp4` },
  ] };
}

function postDocument() {
  return {
    data: { id: '123', author_id: '456', text: 'Truncated', note_tweet: { text: `第一行\n${'长'.repeat(610)}` },
      attachments: { media_keys: [clipA, clipB, clipA, '7_bad'] } },
    includes: {
      users: [{ id: '456', name: '\u202e示例作者', username: 'fixture', protected: false }],
      media: [media(clipB, 'second', { duration_ms: 86_400_001, preview_image_url: 'https://unknown.example/cover.jpg' }),
        media(clipA, 'first', { preview_image_url: 'https://pbs.twimg.com/cover.jpg' }),
        { media_key: '7_bad', type: 'video', variants: [{ content_type: 'video/mp4', url: 'https://unknown.example/video.mp4' }] }],
    },
  };
}

async function listen(server) {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return server.address().port;
}

function close(server) {
  return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}

async function withRelay(options, run) {
  const server = createAixServer({ gatewayToken, apiToken, publicOrigin, mediaEnabled: true, ...options });
  const origin = `http://127.0.0.1:${await listen(server)}`;
  const lookup = (action, fields = {}, headers = { Authorization: `Bearer ${gatewayToken}` }) => fetch(`${origin}/v1/x/posts/lookup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action, postId: '123', ...fields }),
  });
  const playback = async (id = clipA) => {
    const response = await lookup('playback', { mediaId: id });
    expect(response.status).toBe(200);
    const { url } = await response.json();
    expect(url).toMatch(/^https:\/\/aix\.shui\.click\/v1\/x\/media\/[A-Za-z0-9_-]{43}$/);
    return `${origin}${new URL(url).pathname}`;
  };
  try {
    await run({ origin, lookup, playback });
  } finally {
    await close(server);
  }
}

it('uses the documented X endpoint, preserves media order, and returns fresh plain text', async () => {
  const calls = [];
  await withRelay({ fetch: async (url, options) => {
    calls.push(url.href);
    expect(options.redirect).toBe('error');
    if (url.origin === 'https://api.x.com') {
      expect(url.pathname).toBe('/2/tweets/123');
      expect(url.searchParams.get('expansions')).toBe('author_id,attachments.media_keys');
      expect(url.searchParams.get('tweet.fields').split(',')).toContain('note_tweet');
      expect(options.headers.Authorization).toBe(`Bearer ${apiToken}`);
      return Response.json(postDocument());
    }
    expect(url.href).toBe('https://pbs.twimg.com/cover.jpg?format=jpg&name=small');
    expect(options.headers.Authorization).toBeUndefined();
    return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
  } }, async ({ lookup }) => {
    const preview = await lookup('preview');
    expect(preview.status).toBe(200);
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(await preview.json()).toEqual({
      title: '示例作者 · @fixture', description: `第一行 ${'长'.repeat(156)}`, canRead: true,
      videos: [{ id: clipA, durationMs: 2_000, cover: { mimeType: 'image/jpeg', data: jpeg.toString('base64url') } }, { id: clipB }],
    });
    expect(await (await lookup('text')).json()).toEqual({ text: postDocument().data.note_tweet.text });
    expect(calls.map(url => new URL(url).host)).toEqual(['api.x.com', 'pbs.twimg.com', 'api.x.com']);
  });
});

it('rejects unauthorized input, raw URLs, and unavailable posts without minting tickets', async () => {
  let mode = 'deleted';
  let lookups = 0;
  await withRelay({ fetch: async () => {
    lookups++;
    if (mode === 'deleted') return Response.json({ errors: ['Post not found'] });
    const document = postDocument();
    if (mode === 'protected') document.includes.users[0].protected = true;
    if (mode === 'withheld') document.data.withheld = { country_codes: ['XX'] };
    if (mode === 'sensitive') document.data.possibly_sensitive = true;
    return Response.json(document);
  } }, async ({ lookup, origin }) => {
    expect((await fetch(`${origin}/healthz`)).status).toBe(204);
    expect((await lookup('preview', {}, {})).status).toBe(401);
    expect((await lookup('playback', { mediaId: clipA, url: 'https://video.twimg.com/clip.mp4' })).status).toBe(400);
    expect((await lookup('preview', { postId: 'not-an-id' })).status).toBe(400);
    expect((await lookup('preview', { postId: '123\n' })).status).toBe(400);
    expect(lookups).toBe(0);
    for (mode of ['deleted', 'protected', 'withheld', 'sensitive', 'public']) {
      const response = await lookup('playback', { mediaId: mode === 'public' ? '7_unattached' : clipA });
      expect(response.status).toBe(404);
      expect((await response.json()).url).toBeUndefined();
    }
  });
});

it('does not fetch covers or grant playback when media is disabled', async () => {
  let lookups = 0;
  await withRelay({ mediaEnabled: false, fetch: async url => {
    expect(url.origin).toBe('https://api.x.com');
    lookups++;
    return Response.json(postDocument());
  } }, async ({ lookup }) => {
    expect((await (await lookup('preview')).json()).videos).toEqual([]);
    expect((await lookup('playback', { mediaId: clipA })).status).toBe(404);
    expect(lookups).toBe(1);
  });
});

it('streams only the granted clip and handles single ranges, unsatisfiable ranges, and expiration', async () => {
  const ranges = [];
  let clock = 10_000;
  await withRelay({ now: () => clock, fetch: async (url, options) => {
    if (url.origin === 'https://api.x.com') return Response.json(postDocument());
    expect(url.href).toBe('https://video.twimg.com/second.mp4');
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers['Accept-Encoding']).toBe('identity');
    expect(options.redirect).toBe('error');
    const range = options.headers.Range;
    ranges.push(range);
    if (range === 'bytes=12-') return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */10' } });
    if (range === 'bytes=3-5') return new Response(pixels.subarray(3, 6), { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '3', 'Content-Range': 'bytes 3-5/10',
    } });
    if (range === 'bytes=-2') return new Response(pixels.subarray(8), { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '2', 'Content-Range': 'bytes 8-9/10',
    } });
    return new Response(pixels, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10', 'Set-Cookie': 'ignored=1' } });
  } }, async ({ playback }) => {
    const url = await playback(clipB);
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://ai.shui.click' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Range');
    const full = await fetch(url);
    expect(full.headers.get('set-cookie')).toBeNull();
    expect(full.headers.get('cache-control')).toBe('no-store');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('access-control-allow-origin')).toBe('*');
    expect(await full.text()).toBe('0123456789');
    const slice = await fetch(url, { headers: { Range: 'bytes=3-5' } });
    expect(slice.status).toBe(206);
    expect(slice.headers.get('content-range')).toBe('bytes 3-5/10');
    expect(await slice.text()).toBe('345');
    expect(await (await fetch(url, { headers: { Range: 'bytes=-2' } })).text()).toBe('89');
    const unsatisfiable = await fetch(url, { headers: { Range: 'bytes=12-' } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */10');
    expect((await fetch(url, { headers: { Range: 'bytes=0-2,5-6' } })).status).toBe(416);
    expect(ranges).toEqual([undefined, 'bytes=3-5', 'bytes=-2', 'bytes=12-']);
    clock += 16 * 60_000;
    expect((await fetch(url)).status).toBe(410);
  });
});

it('flushes streamed bytes before completion and cancels upstream when playback is disconnected', async () => {
  let canceled;
  const upstreamCanceled = new Promise(resolve => { canceled = resolve; });
  let signal;
  await withRelay({ fetch: async (url, options) => {
    if (url.origin === 'https://api.x.com') return Response.json(postDocument());
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(9, 8, 7)); },
      cancel() { canceled(); },
    }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10' } });
  } }, async ({ playback }) => {
    const client = new AbortController();
    const response = await fetch(await playback(), { signal: client.signal });
    const chunk = await response.body.getReader().read();
    expect([...chunk.value]).toEqual([9, 8, 7]);
    client.abort();
    await upstreamCanceled;
    expect(signal.aborted).toBe(true);
  });
});

it('rejects upstream redirect, MIME substitution, and a range for different bytes', async () => {
  let mode = 'redirect';
  await withRelay({ fetch: async (url, options) => {
    if (url.origin === 'https://api.x.com') return Response.json(postDocument());
    expect(options.redirect).toBe('error');
    if (mode === 'redirect') return Response.redirect('https://unknown.example/redirected');
    if (mode === 'mime') return new Response(pixels, { headers: { 'Content-Type': 'text/html', 'Content-Length': '10' } });
    return new Response(pixels.subarray(0, 3), { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '3', 'Content-Range': 'bytes 0-2/10',
    } });
  } }, async ({ playback }) => {
    const url = await playback();
    for (mode of ['redirect', 'mime', 'range']) {
      const response = await fetch(url, { headers: { Range: 'bytes=3-5' } });
      expect(response.status).toBe(502);
      expect(response.headers.get('location')).toBeNull();
    }
  });
});

it('starts the standalone service and sends X HTTPS through the configured local proxy', async () => {
  const calls = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    calls.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  const proxyPort = await listen(proxy);
  const probe = createServer();
  const relayPort = await listen(probe);
  await close(probe);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.mjs', import.meta.url))], {
    env: { ...process.env, AIX_PORT: String(relayPort), AIX_GATEWAY_TOKEN: gatewayToken, X_API_BEARER_TOKEN: apiToken,
      AIX_PUBLIC_ORIGIN: publicOrigin, AIX_XRAY_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '*' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childError = '';
  child.stderr.on('data', chunk => { childError += chunk; });
  const exited = once(child, 'exit');
  const origin = `http://127.0.0.1:${relayPort}`;
  try {
    let status;
    for (let retry = 0; retry < 40 && status === undefined && child.exitCode === null; retry++) {
      status = await fetch(`${origin}/healthz`).then(response => response.status, () => undefined);
      if (status === undefined) await setTimeout(25);
    }
    expect(status, childError).toBe(204);
    const response = await fetch(`${origin}/v1/x/posts/lookup`, {
      method: 'POST', headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'preview', postId: '123' }),
    });
    expect(response.status).toBe(502);
    expect(calls).toEqual(['api.x.com:443']);
  } finally {
    child.kill();
    await exited;
    await close(proxy);
  }
});
