import { readdir } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

describe('remote expression library', () => {
  it('does not distribute expression originals in public assets', async () => {
    const assets = await readdir(new URL('../public/', import.meta.url), { recursive: true });
    expect(assets.filter(file => /^(stickers|gifs)(\/|$)/.test(file))).toEqual([]);
  });
});
