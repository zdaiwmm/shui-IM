import { describe, expect, it } from 'vitest';
import { isExpressionPayload } from '../src/lib/expression-media';
import starters from '../src/lib/starter-library.json';
import type { ImagePayload } from '../src/lib/types';

describe('expression classification', () => {
  const ordinary = { v: 1, kind: 'image', sentAt: '2026-09-08T00:00:00Z', image: { sha256: 'a'.repeat(64) } } as ImagePayload;
  it('distinguishes explicit expressions from arbitrary photos and filenames', () => {
    expect(isExpressionPayload(ordinary)).toBe(false);
    expect(isExpressionPayload({ ...ordinary, presentation: 'expression' })).toBe(true);
    expect(isExpressionPayload({ ...ordinary, presentation: 'expression-hidden' })).toBe(true);
    expect(isExpressionPayload({ ...ordinary, image: { ...ordinary.image, originalName: 'sticker.gif' } })).toBe(false);
  });
  it('recognizes historical bundled originals by digest without reclassifying direct Safe uploads', () => {
    const image = { ...ordinary.image, sha256: starters.packs[0]!.items[0]!.digest };
    expect(isExpressionPayload({ ...ordinary, image })).toBe(true);
    expect(isExpressionPayload({ v: 1, kind: 'gallery-image', image, sentAt: ordinary.sentAt })).toBe(false);
  });
});
