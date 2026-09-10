import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto';
import protobuf from 'protobufjs';
import { createExpressionCatalog } from '../server/expression-catalog.mjs';
import { wastickers } from './fixtures/wastickers.mjs';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const id = 'a'.repeat(32), key = 'ab'.repeat(32);
const schema = protobuf.parse('syntax="proto2"; message Pack { message Sticker { optional uint32 id=1; } repeated Sticker stickers=4; }').root.lookupType('Pack');
function seal(bytes: Buffer) {
  const keys = Buffer.from(hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.alloc(32), 'Sticker Pack', 64));
  const iv = Buffer.alloc(16); const cipher = createCipheriv('aes-256-cbc', keys.subarray(0, 32), iv);
  const encrypted = Buffer.concat([iv, cipher.update(bytes), cipher.final()]);
  return Buffer.concat([encrypted, createHmac('sha256', keys.subarray(32)).update(encrypted).digest()]);
}
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'expression-catalog-'));
  const manifest = seal(Buffer.from(schema.encode(schema.create({ stickers: [{ id: 0 }, { id: 1 }] })).finish()));
  const fetchResource = vi.fn(async (url: string) => url.endsWith('/packs/') ? Buffer.from(JSON.stringify([
    { meta: { id, key, animated: true, tags: ['cat'] }, manifest: { title: 'Cat collection', author: 'Fixture' } },
  ])) : url.endsWith('manifest.proto') ? manifest : seal(gif));
  let service = createExpressionCatalog({ dataDir, fetchResource });
  cleanup.push(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { get service() { return service; }, fetchResource, restart: async () => { await service.close(); service = createExpressionCatalog({ dataDir, fetchResource }); } };
}
const search = (kind = 'gifs') => ({ kind, keyword: '', page: 1 });
const upload = (kind = 'gifs', title = 'Test') => ({ kind, title, tags: 'cat', files: [{ data: gif.toString('base64') }] });
async function finished(service: ReturnType<typeof createExpressionCatalog>) {
  await vi.waitFor(() => expect(service.jobs()[0].status).not.toBe('running'));
  return service.jobs()[0];
}
describe('managed expression catalog', () => {
  it('updates selected statuses atomically without overwriting metadata and revokes public access', async () => {
    const f = await fixture();
    const a = await f.service.create(upload('gifs', 'First'));
    const b = await f.service.create(upload('stickers', 'Second'));
    const ids = [a.id, b.id];
    expect(f.service.updateStatus({ ids, status: 'published' })).toEqual({ updated: 2 });
    const pack = await f.service.pack('owner', b.id);
    expect(() => f.service.updateStatus({ ids: [a.id, 'missing'], status: 'pending' })).toThrow('MEME_NOT_FOUND');
    expect(f.service.detail(a.id).status).toBe('published');
    f.service.update(a.id, { title: 'Edited elsewhere', tags: 'new', status: 'published' });
    expect(f.service.updateStatus({ ids, status: 'pending' })).toEqual({ updated: 2 });
    expect(f.service.detail(a.id)).toMatchObject({ title: 'Edited elsewhere', tags: 'new', status: 'pending' });
    await expect(f.service.media('owner', pack.items[0].id)).rejects.toThrow('MEME_NOT_FOUND');
    await f.restart();
    expect(f.service.detail(b.id).status).toBe('pending');
    for (const body of [null, { ids: [], status: 'pending' }, { ids: [a.id, a.id], status: 'pending' },
      { ids: Array.from({ length: 25 }, (_, i) => `id-${i}`), status: 'pending' },
      { ids: [a.id], status: 'deleted' }, { ids: [123], status: 'pending' }]) {
      expect(() => f.service.updateStatus(body)).toThrow('MEME_INVALID_QUERY');
    }
  });
  it('starts and restarts with an empty server catalog without acquiring upstream resources', async () => {
    const f = await fixture();
    for (const restart of [false, true]) {
      if (restart) await f.restart();
      for (const kind of ['gifs', 'stickers']) {
        expect(f.service.list({ ...search(kind), status: 'all' }).total).toBe(0);
        const result = await f.service.search('owner', search(kind));
        expect(kind === 'gifs' ? result.items : result.packs).toEqual([]);
      }
      expect(f.service.jobs()).toEqual([]);
    }
    expect(f.fetchResource).not.toHaveBeenCalled();
  });
  it('rolls back the entire initialization on invalid bytes and preserves existing moderation on retry', async () => {
    const f = await fixture();
    const existing = await f.service.create(upload('stickers', 'Existing pending'));
    const entry = { ...existing, id: 'fixture-shipped' };
    const original = { entry, files: [{ title: 'Original', bytes: gif }] };
    expect(() => f.service.initializeShipped(function* () {
      yield original;
      yield { entry: { ...entry, id: 'invalid' }, files: [{ title: 'Invalid', bytes: Buffer.from('<html/>') }] };
    })).toThrow('MEME_INVALID_IMAGE');
    expect(f.service.list({ ...search('stickers'), status: 'all' }).total).toBe(1);
    expect(() => f.service.detail(entry.id)).toThrow('MEME_NOT_FOUND');
    expect(f.service.initializeShipped(() => [original, { ...original, entry: existing }]))
      .toEqual({ initialized: true, added: 1, skipped: 1 });
    expect(f.service.detail(existing.id)).toMatchObject({ title: 'Existing pending', status: 'pending' });
  });
  it('persists originals and metadata atomically, exposes only published entries, and revokes existing grants', async () => {
    const f = await fixture(); const entry = await f.service.create(upload('stickers'));
    expect(entry.status).toBe('pending');
    expect((await f.service.search('owner', search('stickers'))).packs).toEqual([]);
    await expect(f.service.pack('owner', entry.id)).rejects.toThrow('MEME_NOT_FOUND');
    f.service.update(entry.id, { title: 'Renamed', tags: 'cat', status: 'published' });
    const result = await f.service.search('owner', { ...search('stickers'), keyword: '猫' });
    expect(result.packs[0].title).toBe('Renamed');
    const pack = await f.service.pack('owner', entry.id);
    expect((await f.service.media('owner', pack.items[0].id)).bytes).toEqual(gif);
    await expect(f.service.media('other', pack.items[0].id)).rejects.toThrow('MEME_NOT_FOUND');
    f.service.update(entry.id, { title: 'Renamed', tags: 'cat', status: 'pending' });
    await expect(f.service.media('owner', pack.items[0].id)).rejects.toThrow('MEME_NOT_FOUND');
    await f.restart(); expect(f.service.detail(entry.id).title).toBe('Renamed');
    expect(f.service.preview(entry.id, 0).bytes).toEqual(gif);
    f.service.remove(entry.id); expect(() => f.service.detail(entry.id)).toThrow('MEME_NOT_FOUND');
    expect(f.fetchResource).not.toHaveBeenCalled();
  });
  it('imports a .wastickers package through the existing moderated catalog', async () => {
    const f = await fixture();
    const packageBytes = await wastickers({
      'contents.json': Buffer.from(JSON.stringify({ name: 'Imported pack', stickers: [{ image_file: 'one.gif', emojis: ['🙂'] }] })),
      'one.gif': gif,
    });
    const entry = await f.service.create({ kind: 'gifs', title: 'Fallback title', tags: '', status: 'published', files: [{ name: 'pack.wastickers', data: packageBytes.toString('base64') }] });
    expect(entry).toMatchObject({ kind: 'stickers', title: 'Imported pack', status: 'published' });
    expect(f.service.preview(entry.id, 0).bytes).toEqual(gif);
    expect((await f.service.search('owner', search('stickers'))).packs[0].title).toBe('Imported pack');
  });
  it('accepts sticker packages whose originals exceed the single-image upload limit', async () => {
    const f = await fixture();
    const large = Buffer.alloc(5 * 1024 * 1024, 0);
    large.write('GIF89a', 0, 'ascii');
    const packageBytes = await wastickers({
      'contents.json': Buffer.from(JSON.stringify({ name: 'Large pack', stickers: [{ image_file: 'one.gif' }, { image_file: 'two.gif' }] })),
      'one.gif': large,
      'two.gif': large,
    });
    const entry = await f.service.create({ kind: 'stickers', title: 'Fallback title', tags: '', status: 'published', files: [{ name: 'large.wastickers', data: packageBytes.toString('base64') }] });
    expect(entry).toMatchObject({ kind: 'stickers', title: 'Large pack', status: 'published' });
  });
  it('counts newly collected GIFs, deduplicates repeated imports, and never fetches upstream during public reads', async () => {
    const f = await fixture(); f.service.start({ kind: 'gifs', keyword: '', target: 1 });
    expect(() => f.service.start({ kind: 'gifs', keyword: '', target: 1 })).toThrow('MEME_BUSY');
    expect(await finished(f.service)).toMatchObject({ added: 1, target: 1, status: 'completed' });
    f.service.start({ kind: 'gifs', keyword: '', target: 2 });
    expect(await finished(f.service)).toMatchObject({ added: 1, status: 'partial' });
    const entries = f.service.list({ ...search(), status: 'pending' }).entries;
    expect(entries).toHaveLength(2);
    for (const entry of entries) f.service.update(entry.id, { title: entry.title, tags: entry.tags, status: 'published' });
    const calls = f.fetchResource.mock.calls.length;
    const result = await f.service.search('owner', search());
    for (const item of result.items) expect((await f.service.media('owner', item.id)).bytes).toEqual(gif);
    expect(f.fetchResource).toHaveBeenCalledTimes(calls);
  });
  it('collects a selected Signal pack by stable source id without depending on its display title', async () => {
    const f = await fixture();
    f.service.start({ kind: 'stickers', keyword: 'title that is not in the directory', sourceId: id, target: 1 });
    expect(await finished(f.service)).toMatchObject({ added: 1, target: 1, status: 'completed' });
    expect(f.service.detail(id)).toMatchObject({ kind: 'stickers', status: 'pending' });
  });
  it('does not expose or retain half a collection when downloading fails', async () => {
    const f = await fixture(); const original = f.fetchResource.getMockImplementation()!;
    f.fetchResource.mockImplementation(async url => url.endsWith('/full/1') ? seal(Buffer.from('<html>bad</html>')) : original(url));
    f.service.start({ kind: 'stickers', keyword: '', target: 1 });
    expect(await finished(f.service)).toMatchObject({ added: 0, failed: 1, status: 'partial' });
    expect(f.service.list({ ...search('stickers'), status: 'all' }).total).toBe(0);
  });
  it('validates upload, publication, pagination and acquisition limits before mutation', async () => {
    const { service } = await fixture();
    for (const target of [0, 101, 1.5]) expect(() => service.start({ kind: 'gifs', keyword: '', target })).toThrow('MEME_INVALID_QUERY');
    expect(() => service.start({ kind: 'gifs', keyword: '', target: 1, sourceId: 'http://localhost/' })).toThrow('MEME_INVALID_QUERY');
    await expect(service.create({ ...upload(), files: [{ data: Buffer.from('<svg/>').toString('base64') }] })).rejects.toThrow();
    await expect(service.create({ ...upload(), files: [{ data: 'abc' }] })).rejects.toThrow();
    await expect(service.create({ ...upload(), title: '' })).rejects.toThrow();
    for (let i = 0; i < 25; i++) { const entry = await service.create(upload('gifs', `GIF ${i}`)); service.update(entry.id, { title: entry.title, tags: '', status: 'published' }); }
    expect((await service.search('owner', search())).items).toHaveLength(24);
    expect((await service.search('owner', { ...search(), page: 2 })).items).toHaveLength(1);
    await expect(service.search('owner', { ...search(), page: 0 })).rejects.toThrow('MEME_INVALID_QUERY');
    await expect(service.search('owner', search(), AbortSignal.abort())).rejects.toThrow();
  });
});
