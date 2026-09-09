import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

async function worker(fetchResponse: () => Promise<Response>, cached?: Response, cacheKeys: string[] = []) {
  const handlers = new Map<string, (event: any) => void>();
  const stored = new Map<string, Response>();
  if (cached) stored.set('/', cached);
  const waiting: Promise<unknown>[] = [];
  const posted: unknown[] = [];
  const deleted: string[] = [];
  vm.runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    self: { location: { origin: 'https://ai.shui.click' }, addEventListener: (type: string, handler: any) => handlers.set(type, handler), skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (message: unknown) => posted.push(message) }] } },
    URL, Response, fetch: fetchResponse,
    caches: {
      match: async (key: string) => stored.get(key)?.clone(),
      open: async () => ({ put: async (key: string, response: Response) => { stored.set(key, response); } }),
      keys: async () => cacheKeys,
      delete: async (key: string) => { deleted.push(key); return true; },
    },
  });
  const navigate = async () => {
    let response!: Promise<Response>;
    handlers.get('fetch')!({ request: { url: 'https://ai.shui.click/', method: 'GET', mode: 'navigate' }, respondWith: (value: Promise<Response>) => { response = value; }, waitUntil: (value: Promise<unknown>) => waiting.push(value) });
    const result = await response;
    await Promise.all(waiting.splice(0));
    return result;
  };
  const activate = async () => {
    handlers.get('activate')!({ waitUntil: (value: Promise<unknown>) => waiting.push(value) });
    await Promise.all(waiting.splice(0));
  };
  return { navigate, activate, stored, posted, deleted };
}

const shell = () => new Response('<html>working offline shell</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('offline shell response validation', () => {
  it('removes legacy bundled expression caches on upgrade', async () => {
    const app = await worker(async () => shell(), undefined, ['quiet-room-starter-media-v1']);
    await app.activate();
    expect(app.deleted).toEqual(['quiet-room-starter-media-v1']);
  });
  it('announces the activated release to every open window', async () => {
    const app = await worker(async () => shell());
    await app.activate();
    expect(app.posted).toEqual([{ type: 'quiet-room-release-ready', releaseId: '__QUIET_ROOM_RELEASE_ID__' }]);
  });

  it('retains the last good shell through a temporary 503 and later network failure', async () => {
    let offline = false;
    const app = await worker(async () => {
      if (offline) throw new Error('offline');
      return new Response('upstream unavailable', { status: 503, headers: { 'Content-Type': 'text/html' } });
    }, shell());
    expect(await (await app.navigate()).text()).toContain('working offline shell');
    offline = true;
    expect(await (await app.navigate()).text()).toContain('working offline shell');
    expect(await app.stored.get('/')!.text()).toContain('working offline shell');
  });

  it('does not cache a successful non-HTML proxy response', async () => {
    const app = await worker(async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }), shell());
    expect(await (await app.navigate()).text()).toContain('working offline shell');
  });

  it('updates a successful HTML shell within the worker event lifetime', async () => {
    const app = await worker(async () => new Response('<html>new version</html>', { headers: { 'Content-Type': 'text/html' } }), shell());
    expect(await (await app.navigate()).text()).toContain('new version');
    expect(await app.stored.get('/')!.text()).toContain('new version');
  });

  it('returns the actual error when no shell exists and a network error offline', async () => {
    const online = await worker(async () => new Response('unavailable', { status: 503 }));
    expect((await online.navigate()).status).toBe(503);
    expect(online.stored.size).toBe(0);
    const offline = await worker(async () => { throw new Error('offline'); });
    expect((await offline.navigate()).type).toBe('error');
  });
});
