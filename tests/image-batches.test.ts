import { describe, expect, it } from 'vitest';
import { batchImageFiles } from '../src/lib/image-batches';
import { MAX_IMAGE_ALBUM_BYTES, MAX_IMAGE_ALBUM_ITEMS } from '../src/lib/message-payload';

function images(count: number, size = 1) {
  return Array.from({ length: count }, (_, index) => ({ name: `photo-${index}.png`, size }));
}

describe('selected image batches', () => {
  it('keeps every selected image in order across more than nine chat images', () => {
    const files = images(MAX_IMAGE_ALBUM_ITEMS * 3 + 2);
    const original = [...files];
    const batches = batchImageFiles(files, 'chat');

    expect(batches.map((batch) => batch.length)).toEqual([
      MAX_IMAGE_ALBUM_ITEMS, MAX_IMAGE_ALBUM_ITEMS, MAX_IMAGE_ALBUM_ITEMS, 2,
    ]);
    expect(batches.flat()).toEqual(original);
    batches.flat().forEach((file, index) => expect(file).toBe(original[index]));
    expect(files).toEqual(original);
  });

  it('splits chat images by aggregate bytes without reordering them', () => {
    const files = [
      { name: 'first.png', size: MAX_IMAGE_ALBUM_BYTES - 2 },
      { name: 'second.png', size: 2 },
      { name: 'third.png', size: 1 },
      { name: 'fourth.png', size: MAX_IMAGE_ALBUM_BYTES },
      { name: 'fifth.png', size: 1 },
    ];

    expect(batchImageFiles(files, 'chat')).toEqual([
      [files[0], files[1]],
      [files[2]],
      [files[3]],
      [files[4]],
    ]);
  });

  it('uploads all gallery selections as individual images', () => {
    const files = images(MAX_IMAGE_ALBUM_ITEMS + 3, MAX_IMAGE_ALBUM_BYTES);
    expect(batchImageFiles(files, 'gallery')).toEqual(files.map((file) => [file]));
  });

  it.each(['chat', 'gallery'] as const)('returns no batches for an empty %s selection', (destination) => {
    expect(batchImageFiles([], destination)).toEqual([]);
  });

  it.each(['chat', 'gallery'] as const)('rejects an oversized image anywhere in a %s selection', (destination) => {
    const files = [...images(12), { name: 'oversized.png', size: MAX_IMAGE_ALBUM_BYTES + 1 }];
    expect(() => batchImageFiles(files, destination)).toThrow('单张原图不能超过 256 MiB');
  });
});
