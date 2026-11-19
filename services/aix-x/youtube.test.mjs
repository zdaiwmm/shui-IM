import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAixServer } from './index.mjs';
import { createYouTubeExtractor, createYouTubeProvider } from './youtube-api.mjs';

const videoId = 'TestVideo01';
const token = 'test-youtube-gateway-token-0000000000000';
const publicOrigin = 'https://aix.shui.click';
const format = {
  url: 'https://r1---sn-test.googlevideo.com/videoplayback?test=live',
  format_id: '18', ext: 'mp4', protocol: 'https', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2',
  width: 640, height: 360, tbr: 700, filesize: 10,
  http_headers: { 'User-Agent': 'fixture-client', Cookie: 'discard', Authorization: 'discard' },
};
const metadata = {
  id: videoId, extractor_key: 'Youtube', availability: 'public', title: 'A fixture', channel: 'Example',
  description: 'First line\nSecond line', duration: 10, formats: [format],
};

it('passes the private proxy configuration through the extractor environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aix-youtube-extractor-'));
  try {
    const binary = join(directory, 'fixture-extractor');
    await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), proxy: process.env.https_proxy }));\n',
      { mode: 0o700 });
    const proxy = 'http://test-user:test-pass@127.0.0.1:10809/';
    const extract = createYouTubeExtractor({ binary, proxy });
    const result = await extract(videoId, new AbortController().signal);
    expect(result.proxy).toBe(proxy);
    expect(result.args).not.toContain(proxy);
    expect(result.args).not.toContain('--proxy');
    expect(result.args).toContain('--skip-download');
    expect(result.args.at(-1)).toBe(`https://www.youtube.com/watch?v=${videoId}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('caches only the preview and resolves a fresh constrained MP4 on playback', async () => {
  let now = 0;
  const extract = vi.fn(async () => ({ ...metadata, formats: [
    { ...format, format_id: '22', url: 'https://googlevideo.com.example/videoplayback', tbr: 1900 },
    { ...format, format_id: '137', acodec: 'none', tbr: 2200 },
    { ...format, format_id: '140', has_drm: 'maybe', tbr: 2200 },
    format,
  ] }));
  const fetchResource = vi.fn(async () => new Response(null, { status: 404 }));
  const provider = createYouTubeProvider({ extract, fetch: fetchResource, now: () => now });
  const signal = new AbortController().signal;
  const preview = { title: 'A fixture', channel: 'Example', description: metadata.description, durationMs: 10_000, playable: true };
  expect(await provider.preview(videoId, signal)).toEqual(preview);
  expect(await provider.preview(videoId, signal)).toEqual(preview);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(fetchResource).toHaveBeenCalledWith(new URL(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`), expect.anything());
  expect(await provider.playback(videoId, signal)).toMatchObject({
    url: new URL(format.url), formatId: '18', headers: { 'User-Agent': 'fixture-client' },
  });
  expect(extract).toHaveBeenCalledTimes(2);
  now = 120_000;
  await provider.preview(videoId, signal);
  expect(extract).toHaveBeenCalledTimes(3);
  extract.mockResolvedValueOnce({ ...metadata, availability: 'unlisted' });
  await expect(provider.playback(videoId, signal)).rejects.toThrow('VIDEO_UNAVAILABLE');
  extract.mockResolvedValueOnce({ ...metadata, formats: [{ ...format, filesize: 20 }] });
  await expect(provider.playback(videoId, signal, { formatId: '18', size: 10 })).rejects.toThrow('VIDEO_UNAVAILABLE');
});

it('authenticates tickets, refreshes stale URLs, and streams partial bytes until the client disconnects', async () => {
  let expired = true;
  const extract = vi.fn(async () => ({ ...metadata, formats: [{
    ...format, url: format.url + (expired ? '&expired=1' : ''),
  }] }));
  const fetchResource = vi.fn(async (url, { signal, headers, redirect }) => {
    expect(url.hostname).toBe('r1---sn-test.googlevideo.com');
    expect(redirect).toBe('error');
    expect(headers).toEqual({ 'User-Agent': 'fixture-client', Accept: 'video/mp4', 'Accept-Encoding': 'identity', Range: 'bytes=2-9' });
    if (url.searchParams.has('expired')) {
      expired = false;
      return new Response(null, { status: 403 });
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('23'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }), { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-9/10', 'Content-Length': '8',
    } });
  });
  const server = createAixServer({ gatewayToken: token, publicOrigin, youtubeExtract: extract, fetch: fetchResource });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const local = `http://127.0.0.1:${server.address().port}`;
  const lookup = (body, auth = token) => fetch(local + '/v1/youtube/videos/lookup', {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const body = { action: 'playback', videoId };
    expect((await lookup(body, 'invalid')).status).toBe(401);
    expect((await lookup({ ...body, url: format.url })).status).toBe(400);
    expect(extract).not.toHaveBeenCalled();
    const { url } = await (await lookup(body)).json();
    expect(url).toMatch(/^https:\/\/aix\.shui\.click\/v1\/youtube\/media\/[A-Za-z0-9_-]{43}$/);
    const ticket = new URL(url).pathname;
    expect((await fetch(local + ticket.replace('/youtube/', '/x/'))).status).toBe(410);
    const client = new AbortController();
    const media = await fetch(local + ticket, { signal: client.signal, headers: { Range: 'bytes=2-9' } });
    expect(media.status).toBe(206);
    expect(media.headers.get('content-range')).toBe('bytes 2-9/10');
    expect(media.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from((await media.body.getReader().read()).value).toString()).toBe('23');
    expect(extract).toHaveBeenCalledTimes(2);
    const aborted = once(fetchResource.mock.calls.at(-1)[1].signal, 'abort');
    client.abort();
    await aborted;
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
