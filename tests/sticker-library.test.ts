import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { detectImageAnimation } from '../src/lib/image-animation';

describe('shipped sticker library', () => {
  it('ships complete distinct packs and 100 verified playable animations with source attribution', async () => {
    const library = JSON.parse(await readFile(new URL('../src/lib/starter-library.json', import.meta.url), 'utf8'));
    const sources = JSON.parse(await readFile(new URL('../public/stickers/sources.json', import.meta.url), 'utf8'));
    expect(library.packs).toHaveLength(30); expect(library.gifs).toHaveLength(100);
    expect(new Set(library.packs.map((pack: any) => pack.id)).size).toBe(30);
    expect(new Set(library.gifs.map((item: any) => item.digest)).size).toBe(100);
    const entries = new Map<string, any>([...library.packs.flatMap((pack: any) => pack.items), ...library.gifs].map((item: any) => [item.asset, item]));
    for (const [asset, item] of entries) {
      expect(asset).toMatch(/^\/stickers\/[a-f0-9]{64}\.(png|jpeg|gif|webp)$/);
      const bytes = await readFile(new URL(`../public${asset}`, import.meta.url));
      expect(bytes.length).toBe(item.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.digest);
      expect(sources.records.some((source: any) => source.sha256 === item.digest && typeof source.author === 'string' && source.directory.startsWith('https://signalstickers.org/pack/'))).toBe(true);
    }
    for (const item of library.gifs) {
      const bytes = await readFile(new URL(`../public${item.asset}`, import.meta.url));
      expect(await detectImageAnimation(new Blob([bytes])), item.title).toBe(true);
    }
    const files = await readdir(new URL('../public/stickers', import.meta.url));
    expect(files.filter(file => file !== 'sources.json').length).toBe(entries.size);
  });
});
