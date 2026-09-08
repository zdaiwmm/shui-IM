import { describe, expect, it } from 'vitest';
import { blurConcealedPixels } from '../src/lib/concealed-image';

describe('concealed image Gaussian', () => {
  it('preserves a constant color through every row including boundaries', () => {
    const pixels = Uint8ClampedArray.from({ length: 32 * 32 * 4 }, (_, i) => [81, 139, 177, 255][i % 4]!);
    expect(blurConcealedPixels(pixels, 32, 32)).toEqual(pixels);
  });
  it('smooths a hard horizontal edge monotonically without introducing a seam', () => {
    const pixels = Uint8ClampedArray.from({ length: 64 * 64 * 4 }, (_, i) => i % 4 === 3 ? 255 : i < 32 * 64 * 4 ? 20 : 230);
    const blurred = blurConcealedPixels(pixels, 64, 64);
    for (let y = 1; y < 64; y++) {
      const delta = blurred[y * 64 * 4]! - blurred[(y - 1) * 64 * 4]!;
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThanOrEqual(9);
    }
    expect(blurred[31 * 64 * 4]).toBeGreaterThan(100);
    expect(pixels[31 * 64 * 4]).toBe(20);
  });
  it('premultiplies transparency so transparent black cannot add dark fringes', () => {
    const pixels = Uint8ClampedArray.from({ length: 16 * 4 }, (_, i) => i < 8 * 4 ? 0 : [240, 160, 80, 255][i % 4]!);
    const result = blurConcealedPixels(pixels, 16, 1);
    for (let x = 4; x < 12; x++) expect([...result.slice(x * 4, x * 4 + 3)]).toEqual([240, 160, 80]);
  });
  it('rejects buffers outside the bounded preview contract', () => {
    expect(() => blurConcealedPixels(new Uint8ClampedArray(4), 129, 1)).toThrow();
    expect(() => blurConcealedPixels(new Uint8ClampedArray(4), 1, 2)).toThrow();
  });
});
