import { describe, expect, it } from 'vitest';
import { detectImageAnimation } from '../src/lib/image-animation';
import { encodeAnimatedGif } from '../src/lib/display-copy';
import { dampedDrag } from '../src/lib/voice-recorder';

function frame(width: number, height: number, color: [number, number, number]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = 255;
  }
  return pixels;
}

describe('local display copies and voice drag', () => {
  it('keeps two frames when encoding a GIF display copy', async () => {
    const bytes = encodeAnimatedGif(4, 2, [
      { rgba: frame(4, 2, [220, 40, 40]), delayCs: 10 },
      { rgba: frame(4, 2, [40, 80, 220]), delayCs: 10 },
    ]);
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
    expect(await detectImageAnimation(new Blob([bytes], { type: 'image/gif' }))).toBe(true);
  });

  it('lets a voice drag travel well past the old hard stop while resisting', () => {
    expect(dampedDrag(0, 280)).toBe(0);
    expect(dampedDrag(96, 280)).toBeGreaterThan(80);
    expect(dampedDrag(96, 280)).toBeLessThan(110);
    expect(dampedDrag(280, 280)).toBeGreaterThan(180);
    expect(dampedDrag(280, 280)).toBeLessThan(280);
    expect(dampedDrag(72, 220)).toBeGreaterThan(60);
    expect(dampedDrag(400, 220)).toBeLessThan(220);
  });
});
