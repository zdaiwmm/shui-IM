import { describe, expect, it } from 'vitest';
import { batchAttachmentFiles, batchImageFiles } from '../src/lib/image-batches';
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
    expect(() => batchImageFiles(files, destination)).toThrow('单个文件不能超过 256 MiB');
  });
});

describe('selected attachment batches', () => {
  it('preserves mixed selection order and groups only consecutive images', () => {
    const files = [
      { name: 'first.png', type: 'image/png', size: 1 },
      { name: 'second.jpg', type: 'image/jpeg', size: 1 },
      { name: 'document.pdf', type: 'application/pdf', size: 1 },
      { name: 'third.png', type: 'image/png', size: 1 },
      { name: 'fourth.png', type: 'image/png', size: 1 },
      { name: 'archive.zip', type: 'application/zip', size: 1 },
      { name: 'unknown.bin', type: '', size: 1 },
      { name: 'fifth.png', type: 'image/png', size: 1 },
    ];
    const original = [...files];
    const batches = batchAttachmentFiles(files, 'chat');

    expect(batches).toEqual([
      [files[0], files[1]], [files[2]], [files[3], files[4]], [files[5]], [files[6]], [files[7]],
    ]);
    batches.flat().forEach((file, index) => expect(file).toBe(original[index]));
    expect(files).toEqual(original);
  });

  it('still enforces image album count and byte limits around documents', () => {
    const photos = images(MAX_IMAGE_ALBUM_ITEMS + 1).map((file) => ({ ...file, type: 'image/png' }));
    const document = { name: 'document.pdf', type: 'application/pdf', size: MAX_IMAGE_ALBUM_BYTES };
    const largePhoto = { name: 'large.png', type: 'image/png', size: MAX_IMAGE_ALBUM_BYTES - 1 };
    const smallPhoto = { name: 'small.png', type: 'image/png', size: 2 };
    const files = [...photos, document, largePhoto, smallPhoto];
    const batches = batchAttachmentFiles(files, 'chat');

    expect(batches.map((batch) => batch.length)).toEqual([MAX_IMAGE_ALBUM_ITEMS, 1, 1, 1, 1]);
    expect(batches.flat()).toEqual(files);
  });

  it('keeps every gallery attachment in its own batch', () => {
    const files = [
      { name: 'photo.png', type: 'image/png', size: 1 },
      { name: 'document.pdf', type: 'application/pdf', size: 1 },
      { name: 'archive.zip', type: 'application/zip', size: 1 },
    ];
    expect(batchAttachmentFiles(files, 'gallery')).toEqual(files.map((file) => [file]));
  });

  it.each(['chat', 'gallery'] as const)('rejects an oversized file anywhere in a mixed %s selection', (destination) => {
    const files = [
      { name: 'photo.png', type: 'image/png', size: 1 },
      { name: 'oversized.bin', type: '', size: MAX_IMAGE_ALBUM_BYTES + 1 },
    ];
    expect(() => batchAttachmentFiles(files, destination)).toThrow('单个文件不能超过 256 MiB');
  });
});
