import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startServer } from '../server/index.mjs';
import { createXPostGateway, xPostRequest } from '../server/x-post-gateway.mjs';
import { generateIdentity } from '../src/lib/crypto';

const origin = 'https://aix.shui.click';
const capability = `${origin}/v1/x/media/${'k'.repeat(43)}`;
const token = 'a'.repeat(43);

it('projects an authorized device request onto the small public X packet', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'x-post-api-'));
  const fetchGateway = vi.fn(async (_url: string, init: RequestInit) => Response.json(
    JSON.parse(String(init.body)).action === 'playback' ? { url: capability, extra: 'ignored' }
      : { title: '@author', description: 'Excerpt', canRead: true, videos: [{ id: '7_222' }], extra: 'ignored' },
  ));
  await writeFile(path.join(dataDir, 'index.html'), '<title>Chamber</title>');
  const server = await startServer({
    dataDir, staticDir: dataDir, quiet: true, port: 0, xPostGatewayToken: token, xPostGatewayFetch: fetchGateway,
  });
  try {
    const identity = await generateIdentity();
    const access = 'a'.repeat(42) + 'b';
    const { roomId } = server.store.createRoom(identity.publicBundle, access, 'i'.repeat(43), 'x-post-test', []);
    const base = `http://127.0.0.1:${server.port}`;
    const post = (packet: object, headers = {}) => fetch(`${base}/api/rooms/${roomId}/x-post`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', Authorization: `Bearer ${access}`, ...headers },
      body: JSON.stringify(packet),
    });
    const packet = { action: 'preview', postId: '111' };
    expect((await post(packet, { Authorization: 'Bearer invalid' })).status).toBe(401);
    expect((await post(packet, { Origin: 'https://example.com' })).status).toBe(403);
    expect((await post({ ...packet, url: 'http://127.0.0.1/private' })).status).toBe(400);
    expect((await post({ ...packet, postId: '../110' })).status).toBe(400);
    expect(fetchGateway).not.toHaveBeenCalled();
    const preview = await post(packet);
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(await preview.json()).toEqual({
      title: '@author', description: 'Excerpt', canRead: true, videos: [{ id: '7_222' }],
    });
    expect(fetchGateway).toHaveBeenCalledWith(origin + '/v1/x/posts/lookup', expect.objectContaining({
      body: JSON.stringify(packet), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      redirect: 'error',
    }));
    expect(await (await post({ action: 'playback', postId: '111', mediaId: '7_222' })).json()).toEqual({ url: capability });
    const csp = (await fetch(base)).headers.get('content-security-policy');
    expect(csp).toContain(`media-src 'self' blob: ${origin};`);
    expect(csp?.match(/connect-src [^;]+/)?.[0]).not.toContain(origin);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it('rejects unexpected media destinations, malformed responses and missing configuration', async () => {
  expect(createXPostGateway({ token: '' })).toBeNull();
  const packet = xPostRequest({ action: 'playback', postId: '111', mediaId: '7_222' });
  const controller = new AbortController();
  for (const url of [
    capability + '?query=1', capability + '#fragment', capability.replace(origin, origin + '.example'),
    capability.replace('https://', 'https://private@'),
  ]) {
    const fetchImpl = vi.fn(async () => Response.json({ url }));
    await expect(createXPostGateway({ token, fetchImpl })!(packet, controller.signal)).rejects.toThrow('X_POST_UNAVAILABLE');
  }
  const fetchImpl = vi.fn(async () => Response.json({ url: capability }, { headers: { 'Content-Length': '1600000' } }));
  await expect(createXPostGateway({ token, fetchImpl })!(packet, controller.signal)).rejects.toThrow('X_POST_UNAVAILABLE');
});

it('accepts bounded article blocks and rejects unsafe rich content before returning it', async () => {
  const packet = xPostRequest({ action: 'article', postId: '111' });
  const controller = new AbortController();
  const article = { title: 'A public article', author: '@author', blocks: [
    { kind: 'heading', level: 2, runs: [{ text: 'Introduction', bold: true }] },
    { kind: 'paragraph', runs: [{ text: 'Continue', href: 'https://example.com/' }] },
    { kind: 'list-item', ordered: true, depth: 0, runs: [{ text: 'First' }] },
  ] };
  const reply = (value: unknown) => createXPostGateway({ token, fetchImpl: vi.fn(async () => Response.json(value)) })!(
    packet, controller.signal,
  );
  await expect(reply(article)).resolves.toEqual(article);
  const body = xPostRequest({ action: 'article-body', postId: '111' });
  expect(body).toEqual({ action: 'article-body', postId: '111' });
  await expect(createXPostGateway({ token, fetchImpl: vi.fn(async () => Response.json(article)) })!(
    body, controller.signal,
  )).resolves.toEqual(article);
  expect(xPostRequest({ action: 'article', postId: '111', href: 'https://example.com' })).toBeUndefined();
  expect(xPostRequest({ action: 'article-body', postId: '111', href: 'https://example.com' })).toBeUndefined();
  const invalidBlocks = [
    { kind: 'paragraph', runs: [{ text: 'Unsafe', href: 'javascript:alert(1)' }] },
    { kind: 'paragraph', runs: [{ text: 'Unsafe', href: 'https://secret@example.com' }] },
    { kind: 'heading', level: 1, runs: [{ text: 'Unexpected heading' }] },
    { kind: 'paragraph', runs: [{ text: 'Too long'.repeat(10_000) }] },
    { kind: 'image', alt: '', image: { mimeType: 'image/svg+xml', data: 'PHN2Zz4', width: 10, height: 10 } },
    { kind: 'image', alt: '', image: { mimeType: 'image/jpeg', data: 'AA', width: 10, height: 10 } },
    { kind: 'image', alt: '', image: { mimeType: 'image/jpeg', data: 'AA', width: 10, height: 10 }, src: 'https://example.com/' },
  ];
  for (const block of invalidBlocks) {
    await expect(reply({ ...article, blocks: [block] })).rejects.toThrow('X_POST_UNAVAILABLE');
  }
});
