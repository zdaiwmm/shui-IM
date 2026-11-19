import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createAixServer } from './index.mjs';

const gatewayToken = 'test-gateway-token-000000000000000000000';
const publicOrigin = 'https://aix.shui.click';
const clipA = '7123';
const clipB = '7456';
const jpeg = Buffer.from('ffd8ffc00008080002000300ffd9', 'hex');
const articleJpeg = Buffer.from('_9j_wAARCAACAAMDASIAAhEBAxEB_8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL_8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4-Tl5ufo6erx8vP09fb3-Pn6_8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL_8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3-Pn6_9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P_9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ_90ABAAB_9oADAMBAAIRAxEAPwD4t0a5uG0u2ZpXJKDksa0_Pm_56N-ZrG0X_kFW3-4K1K_qqGyP6Cnuz__Z', 'base64url');
const pixels = Buffer.from('0123456789');

function media(id, name, extra = {}) {
  return { id, type: 'video', duration: 2.125, format: 'video/mp4', url: `https://video.twimg.com/${name}-high.mp4`,
    formats: [
      { container: 'm3u8', url: `https://video.twimg.com/${name}.m3u8` },
      { container: 'mp4', bitrate: 2_300_000, url: `https://video.twimg.com/${name}.mp4` },
      { container: 'mp4', bitrate: 1_800_000, url: `https://video.twimg.com/${name}-low.mp4` },
      { container: 'mp4', bitrate: 3_500_000, url: `https://video.twimg.com/${name}-high.mp4` },
    ], ...extra };
}

function postDocument() {
  return {
    code: 200,
    status: { type: 'status', id: '123', text: `第一行\n${'长'.repeat(610)}`, possibly_sensitive: false,
      author: { name: '\u202e示例作者', screen_name: 'fixture', protected: false },
      media: { videos: [
        media(clipA, 'first', { thumbnail_url: 'https://pbs.twimg.com/cover.jpg' }),
        media(clipB, 'second', { duration: 86_401, thumbnail_url: 'https://unknown.example/cover.jpg' }),
        media(clipA, 'duplicate'),
        { id: '7999', type: 'video', format: 'video/mp4', url: 'https://unknown.example/video.mp4' },
        media('7000', 'past-limit'),
      ] },
    },
  };
}

function articleBlock(type, text, fields = {}) {
  return { type, text, data: {}, inlineStyleRanges: [], entityRanges: [], ...fields };
}

function imageAsset(id, url = `https://pbs.twimg.com/media/${id}.jpg`) {
  return { media_id: id, media_info: { __typename: 'ApiImage', original_img_url: url, ext_alt_text: '灯光照在书桌上' } };
}

function embeddedBlock(...keys) {
  return articleBlock('atomic', ' '.repeat(keys.length), {
    entityRanges: keys.map((key, offset) => ({ key, offset, length: 1 })),
  });
}

function articleDocument(article = {}) {
  const document = postDocument();
  document.status.text = 'https://x.com/i/article/456';
  document.status.media.videos = [];
  const linked = '看灯光。请继续阅读';
  document.status.article = {
    title: '在灯下写字',
    preview_text: '抬头就能看到灯光。',
    cover_media: imageAsset('cover'),
    media_entities: [imageAsset('lamp'), imageAsset('invalid', 'https://unapproved.example/image.jpg')],
    content: {
      blocks: [
        articleBlock('header-one', '晚间'),
        articleBlock('unstyled', linked, {
          inlineStyleRanges: [
            { style: 'Bold', offset: 1, length: 2 },
            { style: 'Italic', offset: 2, length: 1 },
            { style: 'Underline', offset: -1, length: 3 },
          ],
          data: { urls: [
            { fromIndex: 5, toIndex: 9, text: 'https://example.com/reference' },
            { fromIndex: 0, toIndex: 1, text: 'javascript:alert(1)' },
          ] },
        }),
        articleBlock('ordered-list-item', '放好钢笔', { depth: 1 }),
        articleBlock('unordered-list-item', '合上笔记', { depth: -1 }),
        { ...embeddedBlock(0), data: { caption: '我的书桌' } },
        articleBlock('blockquote', ' 第一行\r\n  第二行'),
        embeddedBlock(1, 2, 3),
        articleBlock('horizontal-rule', ''),
      ],
      entityMap: [
        { key: '0', value: { type: 'MEDIA', data: { mediaItems: [{ mediaId: 'lamp' }] } } },
        { key: '1', value: { type: 'MEDIA', data: { mediaItems: [{ mediaId: 'invalid' }] } } },
        { key: '2', value: { type: 'TWEET', data: { tweetId: '789' } } },
        { key: '3', value: { type: 'MARKDOWN', data: { markdown: '```sh\nprintf hi\n```' } } },
      ],
    },
    ...article,
  };
  return document;
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
  const server = createAixServer({ gatewayToken, publicOrigin, mediaEnabled: true, ...options });
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

it('looks up only the post ID at FxTwitter, preserves media order, and returns fresh plain text', async () => {
  const calls = [];
  await withRelay({ fetch: async (url, options) => {
    calls.push(url.href);
    expect(options.redirect).toBe('error');
    if (url.origin === 'https://api.fxtwitter.com') {
      expect(url.href).toBe('https://api.fxtwitter.com/2/status/123');
      expect(options.headers).toEqual({ Accept: 'application/json' });
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
      videos: [{ id: clipA, durationMs: 2_125, cover: { mimeType: 'image/jpeg', data: jpeg.toString('base64url') } }, { id: clipB }],
    });
    expect(await (await lookup('text')).json()).toEqual({ text: postDocument().status.text });
    expect(calls.map(url => new URL(url).host)).toEqual(['api.fxtwitter.com', 'pbs.twimg.com', 'api.fxtwitter.com']);
  });
});

it('returns Article metadata without images and reads ordered rich content with verified JPEGs', async () => {
  const images = [];
  await withRelay({ fetch: async (url, options) => {
    expect(options.redirect).toBe('error');
    if (url.origin === 'https://api.fxtwitter.com') {
      expect(url.href).toBe('https://api.fxtwitter.com/2/status/123');
      return Response.json(articleDocument());
    }
    expect(options.headers).toEqual({ Accept: 'image/jpeg' });
    images.push(url.href);
    return new Response(articleJpeg, { headers: { 'Content-Type': 'image/jpeg' } });
  } }, async ({ lookup }) => {
    const author = '示例作者 · @fixture';
    expect(await (await lookup('preview')).json()).toEqual({
      title: author, description: '抬头就能看到灯光。', canRead: true, videos: [], article: { title: '在灯下写字', author },
    });
    expect(await (await lookup('text')).json()).toEqual({
      text: '晚间\n\n看灯光。请继续阅读\n\n放好钢笔\n\n合上笔记\n\n我的书桌\n\n 第一行\n  第二行\n\nprintf hi',
    });
    expect(images).toEqual([]);
    const full = await lookup('article');
    expect(full.status).toBe(200);
    expect(full.headers.get('cache-control')).toBe('no-store');
    const image = { mimeType: 'image/jpeg', data: articleJpeg.toString('base64url'), width: 3, height: 2 };
    expect(await full.json()).toEqual({
      title: '在灯下写字', author,
      blocks: [
        { kind: 'image', alt: '灯光照在书桌上', image },
        { kind: 'heading', level: 2, runs: [{ text: '晚间' }] },
        { kind: 'paragraph', runs: [
          { text: '看' }, { text: '灯', bold: true }, { text: '光', bold: true, italic: true }, { text: '。请' },
          { text: '继续阅读', href: 'https://example.com/reference' },
        ] },
        { kind: 'list-item', ordered: true, depth: 1, runs: [{ text: '放好钢笔' }] },
        { kind: 'list-item', ordered: false, depth: 0, runs: [{ text: '合上笔记' }] },
        { kind: 'image', alt: '灯光照在书桌上', caption: '我的书桌', image },
        { kind: 'quote', runs: [{ text: ' 第一行\n  第二行' }] },
        { kind: 'link', href: 'https://x.com/i/web/status/123', label: 'Image on X' },
        { kind: 'link', href: 'https://x.com/i/web/status/789', label: 'Post on X' },
        { kind: 'code', runs: [{ text: 'printf hi' }] },
        { kind: 'divider' },
      ],
    });
    expect(images).toEqual([
      'https://pbs.twimg.com/media/cover.jpg?format=jpg&name=medium',
      'https://pbs.twimg.com/media/lamp.jpg?format=jpg&name=medium',
    ]);
  });
});

it('revalidates Article access and does not resolve media for unauthorized or unavailable articles', async () => {
  let mode = 'public';
  let requests = 0;
  await withRelay({ fetch: async url => {
    expect(url.origin).toBe('https://api.fxtwitter.com');
    requests++;
    if (mode === 'regular') return Response.json(postDocument());
    const document = mode === 'no-body' ? articleDocument({ content: { blocks: [] } }) : articleDocument();
    if (mode === 'protected') document.status.author.protected = true;
    if (mode === 'sensitive') document.status.possibly_sensitive = true;
    if (mode === 'withheld') document.status.withheld = { country_codes: ['XX'] };
    return Response.json(document);
  } }, async ({ lookup }) => {
    expect((await lookup('article', {}, {})).status).toBe(401);
    expect((await lookup('article', { url: 'https://example.com' })).status).toBe(400);
    expect(requests).toBe(0);
    expect((await lookup('preview')).status).toBe(200);
    for (mode of ['protected', 'sensitive', 'withheld', 'regular', 'no-body']) {
      expect((await lookup('article')).status).toBe(404);
    }
    expect(requests).toBe(6);
  });
});

it('leaves media fallback links in place when bytes exceed the Article budget or lack a JPEG scan', async () => {
  const padding = Buffer.alloc(55_000);
  padding.writeUInt16BE(0xffef, 0);
  padding.writeUInt16BE(padding.length - 2, 2);
  const largeJpeg = Buffer.concat([articleJpeg.subarray(0, 2), ...Array(4).fill(padding), articleJpeg.subarray(2)]);
  const contents = articleDocument({
    cover_media: null, media_entities: Array.from({ length: 5 }, (_, id) => imageAsset(String(id))),
    content: {
      blocks: Array.from({ length: 5 }, (_, id) => embeddedBlock(id)),
      entityMap: Array.from({ length: 5 }, (_, id) => ({
        key: String(id), value: { type: 'MEDIA', data: { mediaItems: [{ mediaId: String(id) }] } },
      })),
    },
  });
  await withRelay({ fetch: async url => {
    if (url.origin === 'https://api.fxtwitter.com') return Response.json(contents);
    return new Response(url.pathname === '/media/0.jpg' ? jpeg : largeJpeg, { headers: { 'Content-Type': 'image/jpeg' } });
  } }, async ({ lookup }) => {
    const full = await lookup('article');
    expect(full.status).toBe(200);
    expect(Number(full.headers.get('content-length'))).toBeLessThan(1536 * 1024);
    const { blocks } = await full.json();
    expect(blocks.map(block => block.kind)).toEqual(['link', 'image', 'image', 'image', 'link']);
    expect(blocks.filter(block => block.kind === 'image')
      .reduce((size, block) => size + Buffer.from(block.image.data, 'base64url').length, 0)).toBe(3 * largeJpeg.length);
  });
});

it('rejects unauthorized input, raw URLs, and unavailable posts without minting tickets', async () => {
  let mode = 'deleted';
  let lookups = 0;
  await withRelay({ fetch: async () => {
    lookups++;
    if (typeof mode === 'number') return Response.json({}, { status: mode });
    if (mode === 'tombstone') return Response.json({ code: 200, status: { type: 'tombstone' } });
    if (mode === 'deleted') return Response.json({ code: 404, status: null });
    if (mode === 'malformed') return new Response('not JSON');
    if (mode === 'redirect') return Response.redirect('https://unknown.example/status/123');
    if (mode === 'limited') return Response.json({ code: 429, status: null });
    const document = postDocument();
    if (mode === 'protected') document.status.author.protected = true;
    if (mode === 'withheld') document.status.withheld = { country_codes: ['XX'] };
    if (mode === 'sensitive') document.status.possibly_sensitive = true;
    if (mode === 'unknown-sensitivity') delete document.status.possibly_sensitive;
    if (mode === 'wrong-id') document.status.id = '321';
    return Response.json(document);
  } }, async ({ lookup, origin }) => {
    expect((await fetch(`${origin}/healthz`)).status).toBe(204);
    expect((await lookup('preview', {}, {})).status).toBe(401);
    expect((await lookup('playback', { mediaId: clipA, url: 'https://video.twimg.com/clip.mp4' })).status).toBe(400);
    expect((await lookup('preview', { postId: 'not-an-id' })).status).toBe(400);
    expect((await lookup('preview', { postId: '123\n' })).status).toBe(400);
    expect(lookups).toBe(0);
    for (mode of [401, 403, 404, 451, 'tombstone', 'deleted', 'protected', 'withheld', 'sensitive', 'unknown-sensitivity', 'wrong-id']) {
      const response = await lookup('playback', { mediaId: clipA });
      expect(response.status, String(mode)).toBe(404);
      expect(await response.json()).toEqual({ error: 'POST_UNAVAILABLE' });
    }
    mode = 'public';
    const unattached = await lookup('playback', { mediaId: '7999' });
    expect(unattached.status).toBe(404);
    expect(await unattached.json()).toEqual({ error: 'MEDIA_UNAVAILABLE' });
    for (mode of ['malformed', 'redirect']) {
      expect((await lookup('text')).status).toBe(502);
    }
    for (mode of [429, 'limited']) {
      const response = await lookup('text');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'UPSTREAM_BUSY' });
    }
  });
});

it('does not fetch covers or grant playback when media is disabled', async () => {
  let lookups = 0;
  await withRelay({ mediaEnabled: false, fetch: async url => {
    expect(url.origin).toBe('https://api.fxtwitter.com');
    lookups++;
    return Response.json(postDocument());
  } }, async ({ lookup }) => {
    expect((await (await lookup('preview')).json()).videos).toEqual([]);
    expect((await lookup('playback', { mediaId: clipA })).status).toBe(404);
    expect(lookups).toBe(1);
  });
});

it('grants two different clips and streams single ranges, unsatisfiable ranges, and expiration', async () => {
  const ranges = [];
  let clock = 10_000;
  await withRelay({ now: () => clock, fetch: async (url, options) => {
    if (url.origin === 'https://api.fxtwitter.com') return Response.json(postDocument());
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers['Accept-Encoding']).toBe('identity');
    expect(options.redirect).toBe('error');
    const range = options.headers.Range;
    ranges.push(range);
    if (url.href === 'https://video.twimg.com/first.mp4') {
      expect(range).toBe('bytes=0-1');
      return new Response('ab', { status: 206, headers: {
        'Content-Type': 'video/mp4', 'Content-Length': '2', 'Content-Range': 'bytes 0-1/10',
      } });
    }
    expect(url.href).toBe('https://video.twimg.com/second.mp4');
    if (range === 'bytes=12-') return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */10' } });
    if (range === 'bytes=3-5') return new Response(pixels.subarray(3, 6), { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '3', 'Content-Range': 'bytes 3-5/10',
    } });
    if (range === 'bytes=-2') return new Response(pixels.subarray(8), { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '2', 'Content-Range': 'bytes 8-9/10',
    } });
    return new Response(pixels, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10', 'Set-Cookie': 'ignored=1' } });
  } }, async ({ playback }) => {
    const first = await playback(clipA);
    const url = await playback(clipB);
    expect(first).not.toBe(url);
    expect(ranges).toEqual([]);
    const firstSlice = await fetch(first, { headers: { Range: 'bytes=0-1' } });
    expect(firstSlice.status).toBe(206);
    expect(await firstSlice.text()).toBe('ab');
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
    expect(ranges).toEqual(['bytes=0-1', undefined, 'bytes=3-5', 'bytes=-2', 'bytes=12-']);
    clock += 16 * 60_000;
    expect((await fetch(url)).status).toBe(410);
  });
});

it('flushes streamed bytes before completion and cancels upstream when playback is disconnected', async () => {
  let canceled;
  const upstreamCanceled = new Promise(resolve => { canceled = resolve; });
  let signal;
  await withRelay({ fetch: async (url, options) => {
    if (url.origin === 'https://api.fxtwitter.com') return Response.json(postDocument());
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
    if (url.origin === 'https://api.fxtwitter.com') return Response.json(postDocument());
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

it('starts without an X API token and sends only X media through the authenticated localhost proxy', async () => {
  const calls = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    calls.push({ target: request.url, auth: request.headers['proxy-authorization'] });
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  const proxyPort = await listen(proxy);
  const probe = createServer();
  const relayPort = await listen(probe);
  await close(probe);
  const preload = `
    import dns from 'node:dns';
    import { syncBuiltinESMExports } from 'node:module';
    const lookup = dns.lookup;
    dns.lookup = (name, options, callback) => {
      if (name !== 'api.fxtwitter.com') return lookup(name, options, callback);
      queueMicrotask(() => callback(Object.assign(new Error('Fixture DNS block'), { code: 'ENOTFOUND' })));
    };
    syncBuiltinESMExports();
    const networkFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => url.href === 'https://api.fxtwitter.com/2/status/123'
      ? Promise.resolve(Response.json(${JSON.stringify(postDocument())}))
      : networkFetch(url, options);
  `;
  const env = { ...process.env, AIX_PORT: String(relayPort), AIX_GATEWAY_TOKEN: gatewayToken,
    AIX_MEDIA_ENABLED: 'true', AIX_PUBLIC_ORIGIN: publicOrigin,
    AIX_XRAY_PROXY: `http://test-proxy-user:test-proxy-pass@127.0.0.1:${proxyPort}`, NO_PROXY: '*' };
  delete env.X_API_BEARER_TOKEN;
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload),
    fileURLToPath(new URL('./index.mjs', import.meta.url))], {
    env,
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
    const lookup = (packet) => fetch(`${origin}/v1/x/posts/lookup`, {
      method: 'POST', headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(packet),
    });
    expect((await lookup({ action: 'text', postId: '124' })).status).toBe(502);
    expect(calls).toEqual([]);
    const preview = await lookup({ action: 'preview', postId: '123' });
    expect(preview.status).toBe(200);
    const grant = await lookup({ action: 'playback', postId: '123', mediaId: clipB });
    expect(grant.status).toBe(200);
    const path = new URL((await grant.json()).url).pathname;
    const response = await fetch(origin + path, { headers: { Range: 'bytes=0-1' } });
    expect(response.status).toBe(502);
    const auth = 'Basic ' + Buffer.from('test-proxy-user:test-proxy-pass').toString('base64');
    expect(calls).toEqual([{ target: 'pbs.twimg.com:443', auth }, { target: 'video.twimg.com:443', auth }]);
  } finally {
    child.kill();
    await exited;
    await close(proxy);
  }
});
