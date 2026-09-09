import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

describe('remote expression library', () => {
  it('keeps the catalog metadata while binaries are fetched from the server', async () => {
    const library = JSON.parse(await readFile(new URL('../src/lib/starter-library.json', import.meta.url), 'utf8'));
    expect(library.packs).toHaveLength(30);
    expect(library.gifs).toHaveLength(100);
  });
});
