import { describe, it, expect } from 'vitest';
import { normalizeMemeIndex, sniffMemeType, MAX_MEME_BYTES } from '../src/lib/meme-media';

const favorite = { id: '12345678-1234-4234-8234-123456789abc', digest: 'a'.repeat(64), name: '无语.png', type: 'image/png', size: 42, savedAt: 1 };
describe('meme files and encrypted index validation', () => {
  it('rejects active or mislabeled image content before decoding', () => {
    for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<html>failure</html>', 'not an image']) {
      expect(sniffMemeType(new TextEncoder().encode(text))).toBeNull();
    }
    expect(sniffMemeType(new Uint8Array([137,80,78,71,13,10,26,10]))).toBe('image/png');
    expect(sniffMemeType(new TextEncoder().encode('GIF89a1234'))).toBe('image/gif');
    expect(sniffMemeType(new TextEncoder().encode('RIFF1234WEBP'))).toBe('image/webp');
    expect(sniffMemeType(new Uint8Array([255,216,255]))).toBe('image/jpeg');
  });
  it('preserves independent file metadata', () => {
    expect(normalizeMemeIndex([favorite])).toEqual([favorite]);
    expect(normalizeMemeIndex([])).toEqual([]);
  });
  it.each([
    [favorite, favorite], [{ ...favorite, size: MAX_MEME_BYTES + 1 }], [{ ...favorite, type: 'image/svg+xml' }],
    [{ ...favorite, digest: 'invalid' }], [{ ...favorite, savedAt: NaN }], [{ ...favorite, id: 'invalid' }],
    [{ ...favorite, name: 'x'.repeat(121) }], new Array(101),
  ])('fails closed for invalid index %#', (...items) => {
    expect(() => normalizeMemeIndex(items)).toThrow();
  });
});
