import { describe, expect, it, vi } from 'vitest';
import { allowedMemeUrl, createMemeService, memeContentType, publicMemeAddress } from '../server/memes.mjs';
import { startServer } from '../server/index.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateIdentity } from '../src/lib/crypto';
import { randomBase64Url } from '../src/lib/base64';

const jpeg = Buffer.from([255, 216, 255, 0, 1]);
function fixture(count = 30) {
  let time = 1000;
  const rows = Array.from({ length: count }, (_, index) => ({ name: index ? `Cat ${index}` : 'Two Buttons',
    url: `https://i.imgflip.com/test${index}.jpg`, width: 200, height: 200 }));
  const fetchResource = vi.fn(async (url: string) => url.includes('get_memes')
    ? Buffer.from(JSON.stringify({ success: true, data: { memes: rows } })) : jpeg);
  return { service: createMemeService({ fetchResource, now: () => time }), fetchResource, advance: () => { time += 16 * 60_000; } };
}
describe('network meme service', () => {
  it('authenticates HTTP requests before parsing and rejects arbitrary media URLs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'quiet-memes-'));
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: directory, quiet: true });
    try {
      const identity = await generateIdentity();
      delete identity.publicBundle.mlsKeyPackage;
      const token = randomBase64Url(32);
      const room = server.store.createRoom(identity.publicBundle, token, randomBase64Url(32));
      const request = (route: string, body: unknown, auth = token) => fetch(`http://127.0.0.1:${server.port}/api/rooms/${room.roomId}/memes/${route}`, {
        method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect((await request('search', {}, 'invalid')).status).toBe(401);
      expect((await request('search', {keyword:'x',page:0})).status).toBe(400);
      expect((await request('search', {keyword:'x'.repeat(3000),page:1})).status).toBe(400);
      const response = await request('media', {id:'https://127.0.0.1/internal'});
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    } finally { await server.close(); await rm(directory, {recursive:true,force:true}); }
  });
  it('loads popular images without credentials, pages and searches Chinese aliases', async () => {
    const { service, fetchResource } = fixture();
    const first = await service.search('room:device', { keyword: '热门', page: 1 });
    expect(first.items).toHaveLength(24); expect(first.nextPage).toBe(2);
    expect((await service.search('room:device', { keyword: '热门', page: 2 })).items).toHaveLength(6);
    expect((await service.search('room:device', { keyword: '纠结', page: 1 })).items[0].title).toBe('Two Buttons');
    expect((await service.search('room:device', { keyword: '可爱', page: 1 })).items).toHaveLength(24);
    expect((await service.search('room:device', { keyword: 'not found anywhere', page: 1 })).items).toHaveLength(0);
    expect(fetchResource).toHaveBeenCalledTimes(1);
    expect(fetchResource.mock.calls[0][0]).toBe('https://api.imgflip.com/get_memes');
    expect(JSON.stringify(first)).not.toContain('https:');
  });
  it('binds media grants to the requesting device and expires them', async () => {
    const { service, fetchResource, advance } = fixture();
    const { items } = await service.search('owner', { keyword: '', page: 1 });
    await expect(service.media('other', items[0].id)).rejects.toThrow('MEME_NOT_FOUND');
    const image = await service.media('owner', items[0].id);
    expect(image.bytes).toEqual(jpeg); expect(image.type).toBe('image/jpeg');
    advance(); await expect(service.media('owner', items[0].id)).rejects.toThrow('MEME_NOT_FOUND');
    expect(fetchResource).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid input before network access and cancelled searches before grants', async () => {
    const { service, fetchResource } = fixture();
    for (const body of [null, {}, {keyword:'x',page:0}, {keyword:'x'.repeat(81),page:1}]) {
      await expect(service.search('owner', body)).rejects.toThrow('MEME_INVALID_QUERY');
    }
    expect(fetchResource).not.toHaveBeenCalled();
    await expect(service.search('owner', {keyword:'',page:1}, AbortSignal.abort())).rejects.toThrow();
  });
  it('rejects HTML, redirects encoded as URLs, credentials and private addresses', () => {
    for (const url of ['http://i.imgflip.com/a.jpg','https://localhost/a.jpg','https://i.imgflip.com.evil.test/a.jpg',
      'https://i.imgflip.com/a.svg','https://user@i.imgflip.com/a.jpg','https://i.imgflip.com/a.jpg?url=http://127.0.0.1']) expect(allowedMemeUrl(url)).toBe(false);
    expect(allowedMemeUrl('https://i.imgflip.com/abc.png')).toBe(true);
    for (const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','192.168.1.1','172.16.1.1','::1','100.64.1.1','224.0.0.1']) expect(publicMemeAddress(ip)).toBe(false);
    expect(publicMemeAddress('8.8.8.8')).toBe(true);
    expect(() => memeContentType(Buffer.from('<svg/>'))).toThrow('MEME_INVALID_IMAGE');
  });
  it('fails closed for malformed catalog and unsafe media', async () => {
    const service = createMemeService({ fetchResource: async () => Buffer.from('{"success":true,"data":{"memes":[{"url":"http://127.0.0.1"}]}}') });
    await expect(service.search('owner', {keyword:'',page:1})).rejects.toThrow('MEME_INVALID_CATALOG');
    const { service: valid, fetchResource } = fixture();
    const {items} = await valid.search('owner', {keyword:'',page:1});
    fetchResource.mockResolvedValueOnce(Buffer.from('<html>not an image</html>'));
    await expect(valid.media('owner',items[0].id)).rejects.toThrow('MEME_INVALID_IMAGE');
  });
});
