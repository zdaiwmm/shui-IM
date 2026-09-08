import { describe, expect, it } from 'vitest';
import { parse } from 'exifr';
import { detectImageAnimation } from '../src/lib/image-animation';
import { boundedPhotoTags, PHOTO_TAGS, photoDetailGroups } from '../src/lib/photo-detail-model';
import { encryptImageFile, decryptImageFile } from '../src/lib/file-crypto';
import { animatedGif, animatedWebp, animatedPng, staticPng, exifPrefix } from './fixtures/photo-fixtures.mjs';
import type { ImageManifest } from '../src/lib/types';

const fixtureManifest = { originalName: 'test.jpg', originalSize: 4096, mimeType: 'image/jpeg', lastModified: 1_700_000_000_000 } as ImageManifest;
const rows = (tags = {}) => Object.fromEntries(photoDetailGroups(fixtureManifest, '2026-09-08T01:30:00Z', tags).flatMap(group => group.rows.map(row => [row.label, row.value])));

describe('verified original image animation containers', () => {
  for (const [name, bytes, type] of [['GIF', animatedGif, 'image/gif'], ['WebP', animatedWebp, 'image/webp'], ['APNG', animatedPng, 'image/png']] as const) {
    it(`${name} stays animated and byte-identical through encrypted transport`, async () => {
      const original = new File([bytes], `${name}.original`, { type });
      const chunks = new Map<string, ArrayBuffer>();
      const manifest = await encryptImageFile(original, {
        reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }),
        upload: async (blobId, index, data) => { chunks.set(`${blobId}:${index}`, data); },
        complete: async () => {}, savePlan: async () => {},
      });
      const decrypted = await decryptImageFile(manifest, async (blobId, index) => chunks.get(`${blobId}:${index}`)!);
      expect(new Uint8Array(await decrypted.arrayBuffer())).toEqual(new Uint8Array(bytes));
      expect(await detectImageAnimation(decrypted)).toBe(true);
    });
  }
  it('does not mistake static PNG, single-frame GIF or marker text for animation', async () => {
    const singleGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    for (const bytes of [staticPng, singleGif, Buffer.from('GIF89a fake ANIM acTL'), exifPrefix]) {
      const outcome = await detectImageAnimation(new Blob([bytes])).catch(() => false);
      expect(outcome).toBe(false);
    }
  });
  it('rejects truncated or forged container lengths', async () => {
    await expect(detectImageAnimation(new Blob([animatedWebp.subarray(0, 30)]))).rejects.toThrow();
    const bad = Buffer.from(animatedPng); bad.writeUInt32BE(0x7fffffff, 8);
    await expect(detectImageAnimation(new Blob([bad]))).rejects.toThrow();
  });
  it('honors cancellation before reading decrypted bytes', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(detectImageAnimation(new Blob([animatedGif]), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('photo properties without invented capture data', () => {
  it('returns only small, known scalar metadata from the parser worker', () => {
    expect(boundedPhotoTags({ Make: 'x'.repeat(10000), Model: { html: 'not text' }, ISO: Infinity, GPSLatitude: [1, 2, 3], unknown: 'discard', BitsPerSample: new Array(1000).fill(8) }))
      .toEqual({ Make: 'x'.repeat(512), GPSLatitude: [1, 2, 3] });
  });
  it('reads real synthetic EXIF and preserves raw wall-clock capture time', async () => {
    const tags = await parse(Buffer.concat([exifPrefix, Buffer.from([0xff, 0xd9])]), { pick: PHOTO_TAGS, reviveValues: false, translateValues: false });
    const values = rows(tags);
    expect(values['拍摄时间']).toBe('2026年09月06日 16:28:35');
    expect(values['相机']).toBe('Fixture Camera Test Model');
    expect(values['光圈']).toBe('ƒ/1.78');
    expect(values['感光度']).toBe('ISO 80');
    expect(values['快门']).toBe('1/1,250 秒');
    expect(values['版权']).toBe('<b>Fixture only</b>');
  });
  it('does not substitute upload or modification time for missing capture time', () => {
    expect(rows()['拍摄时间']).toBe('未记录');
    expect(rows()['拍摄地点']).toBe('未记录');
    expect(rows()['图像创建时间']).toBe('未记录');
    expect(rows()['文件修改时间']).not.toBe('未记录');
    expect(rows()['上传 / 发送时间']).not.toBe('未记录');
  });
  it('shows only complete, bounded GPS pairs including zero and southern coordinates', () => {
    const tags = { GPSLatitude: [0, 0, 0], GPSLatitudeRef: 'S', GPSLongitude: [120, 30, 0], GPSLongitudeRef: 'E' };
    expect(rows(tags)['拍摄地点']).toBe('0.00000° S, 120.50000° E');
    expect(rows({ ...tags, GPSLongitude: [181, 0, 0] })['拍摄地点']).toBe('未记录');
    expect(rows({ ...tags, GPSLatitude: [5, 61, 0] })['拍摄地点']).toBe('未记录');
    expect(rows({ GPSLatitude: [1, 2, 3] })['拍摄地点']).toBe('未记录');
  });
  it('bounds untrusted text and ignores invalid numeric values', () => {
    const values = rows({ Copyright: 'a'.repeat(1000), Make: '\u202efake\u0000', FNumber: Infinity, ISO: -1 });
    expect(values['版权']).toHaveLength(512);
    expect(values['相机']).toBe('fake');
    expect(values['光圈']).toBeUndefined();
    expect(values['感光度']).toBeUndefined();
  });
});
