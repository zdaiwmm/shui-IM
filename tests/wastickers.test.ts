import { describe, expect, it } from 'vitest';
import { parseWastickers } from '../server/wastickers.mjs';
import { wastickers } from './fixtures/wastickers.mjs';

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const flat = { 'title.txt': Buffer.from('Fixture pack'), 'author.txt': Buffer.from('Fixture'), 'tray.png': gif, 'one.gif': gif };

describe('wastickers archive validation', () => {
  it.each([0, 6])('imports text metadata and excludes the tray, ZIP level %i', async level => {
    const result = await parseWastickers(await wastickers(flat, { level }));
    expect(result.title).toBe('Fixture pack');
    expect(result.files.map(file => file.bytes)).toEqual([gif]);
  });
  it('supports JSON manifests with nested images and explicit ordering', async () => {
    const result = await parseWastickers(await wastickers({
      'metadata.json': Buffer.from(JSON.stringify({ title: 'JSON pack', stickers: [{ file: 'images/one.gif' }] })),
      'images/one.gif': gif, 'tray.png': gif,
    }));
    expect(result.title).toBe('JSON pack');
    expect(result.files.map(file => file.bytes)).toEqual([gif]);
  });
  it('rejects malformed ZIPs, missing manifests, unsafe paths, and invalid images', async () => {
    for (const files of [
      { 'one.gif': gif }, { 'title.txt': Buffer.from('Empty') },
      { ...flat, '../bad.gif': gif }, { ...flat, 'one.gif': Buffer.from('<svg/>') },
      { ...flat, 'contents.json': Buffer.from('{') },
      { 'contents.json': Buffer.from(JSON.stringify({ stickers: [{ file: 'missing.gif' }] })) },
    ]) await expect(parseWastickers(await wastickers(files))).rejects.toThrow(/MEME_INVALID_(QUERY|IMAGE)/);
    const bytes = await wastickers(flat);
    await expect(parseWastickers(bytes.subarray(0, 40))).rejects.toThrow('MEME_INVALID_QUERY');
  });
  it('validates CRC before accepting originals and refuses encrypted packages', async () => {
    const bytes = await wastickers(flat, { level: 0 });
    const position = bytes.indexOf(gif);
    expect(position).toBeGreaterThan(0);
    bytes[position + 6] ^= 1;
    await expect(parseWastickers(bytes)).rejects.toThrow('MEME_INVALID_QUERY');
    await expect(parseWastickers(await wastickers(flat, { password: 'synthetic-package-password' }))).rejects.toThrow('MEME_INVALID_QUERY');
  });
  it('bounds uploaded bytes, metadata, per-image output, item count and aggregate output', async () => {
    await expect(parseWastickers(Buffer.alloc(8 * 1024 * 1024 + 1))).rejects.toThrow('MEME_TOO_LARGE');
    await expect(parseWastickers(await wastickers({ ...flat, 'title.txt': Buffer.alloc(256 * 1024 + 1) }))).rejects.toThrow('MEME_TOO_LARGE');
    await expect(parseWastickers(await wastickers({ ...flat, 'one.gif': Buffer.alloc(8 * 1024 * 1024 + 1) }))).rejects.toThrow('MEME_TOO_LARGE');
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`${i}.gif`, gif]));
    await expect(parseWastickers(await wastickers({ 'title.txt': Buffer.from('Many'), ...many }))).rejects.toThrow('MEME_INVALID_QUERY');
    const large = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${i}.gif`, Buffer.alloc(8 * 1024 * 1024)]));
    await expect(parseWastickers(await wastickers({ 'title.txt': Buffer.from('Large'), ...large }))).rejects.toThrow('MEME_TOO_LARGE');
  }, 15000);
});
