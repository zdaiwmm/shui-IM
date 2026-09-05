import { describe, expect, it } from 'vitest';
import {
  curateGalleryAssets,
  galleryCurationKey,
  GALLERY_CURATION_VERSION,
  MAX_GALLERY_CURATION_ASSET_INDEX,
  MAX_GALLERY_CURATION_ASSETS,
  MAX_GALLERY_CURATION_RECORDS,
  normalizeGalleryCurationRecord,
  normalizeGalleryCurationRecords,
  type GalleryCategory,
  type GalleryCurationAsset,
  type GalleryCurationRecord,
} from '../src/lib/gallery-curation';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
] as const;

type TestAsset = GalleryCurationAsset & { label: string };

function asset(label: string, seq: number, clientMsgId: string, assetIndex = 0, category: GalleryCategory = 'images'): TestAsset {
  return { label, seq, clientMsgId, assetIndex, category };
}

function record(
  target: Pick<GalleryCurationAsset, 'category' | 'clientMsgId' | 'assetIndex'>,
  patch: Pick<GalleryCurationRecord, 'hidden' | 'pinnedAt'>,
): GalleryCurationRecord {
  return {
    v: GALLERY_CURATION_VERSION,
    category: target.category,
    clientMsgId: target.clientMsgId,
    assetIndex: target.assetIndex,
    hidden: patch.hidden,
    pinnedAt: patch.pinnedAt,
  };
}

describe('gallery curation records', () => {
  it('builds stable, collision-free keys across category, message, and album index', () => {
    const targets = [
      asset('image zero', 1, ids[0], 0, 'images'),
      asset('image one', 1, ids[0], 1, 'images'),
      asset('other message', 1, ids[1], 0, 'images'),
      asset('same target in files', 1, ids[0], 0, 'files'),
    ];
    const keys = targets.map(galleryCurationKey);
    expect(new Set(keys).size).toBe(targets.length);
    expect(galleryCurationKey({ category: 'images', clientMsgId: ids[0].toUpperCase(), assetIndex: -0 }))
      .toBe(keys[0]);
  });

  it('strictly validates records and returns a canonical copy/order', () => {
    const input = [
      record(asset('b', 1, ids[1], 1), { hidden: false, pinnedAt: 20 }),
      record(asset('a', 1, ids[0]), { hidden: true, pinnedAt: null }),
      record(asset('file', 1, ids[2], 0, 'files'), { hidden: false, pinnedAt: null }),
    ];
    const before = structuredClone(input);
    const normalized = normalizeGalleryCurationRecords(input);
    expect(input).toEqual(before);
    expect(normalized).not.toBe(input);
    expect(normalized.map(galleryCurationKey)).toEqual([...normalized.map(galleryCurationKey)].sort());
    expect(normalized.every((item, index) => item !== input[index])).toBe(true);
  });

  it.each([
    null,
    [],
    { v: 2, category: 'images', clientMsgId: ids[0], assetIndex: 0, hidden: false, pinnedAt: null },
    { v: 1, category: 'other', clientMsgId: ids[0], assetIndex: 0, hidden: false, pinnedAt: null },
    { v: 1, category: 'images', clientMsgId: 'not-a-uuid', assetIndex: 0, hidden: false, pinnedAt: null },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: -1, hidden: false, pinnedAt: null },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: MAX_GALLERY_CURATION_ASSET_INDEX + 1, hidden: false, pinnedAt: null },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: 0.5, hidden: false, pinnedAt: null },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: 0, hidden: 'false', pinnedAt: null },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: 0, hidden: false, pinnedAt: -1 },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: 0, hidden: false, pinnedAt: 1.5 },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: 0, hidden: false, pinnedAt: Number.NaN },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: 0, hidden: true, pinnedAt: 1 },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: 0, hidden: false, pinnedAt: null, extra: true },
    { v: 1, category: 'images', clientMsgId: ids[0], assetIndex: 0, hidden: false },
  ])('rejects malformed or ambiguous encrypted state %#', (invalid) => {
    expect(() => normalizeGalleryCurationRecord(invalid)).toThrow(TypeError);
  });

  it('rejects duplicate, sparse, non-array, and oversized record collections before use', () => {
    const valid = record(asset('target', 1, ids[0]), { hidden: false, pinnedAt: 1 });
    expect(() => normalizeGalleryCurationRecords({ 0: valid, length: 1 })).toThrow(TypeError);
    expect(() => normalizeGalleryCurationRecords([valid, structuredClone(valid)])).toThrow('重复');
    const sparse = new Array(1);
    expect(() => normalizeGalleryCurationRecords(sparse)).toThrow(TypeError);

    const oversized = new Array(MAX_GALLERY_CURATION_RECORDS + 1);
    Object.defineProperty(oversized, 0, { get: () => { throw new Error('entry was touched'); } });
    expect(() => normalizeGalleryCurationRecords(oversized)).toThrow(RangeError);
    expect(() => normalizeGalleryCurationRecords(oversized)).not.toThrow('entry was touched');
  });
});

describe('gallery curation projection', () => {
  it('filters hidden tombstones without mutating the safe source or chat-shaped objects', () => {
    const source = [asset('new', 9, ids[0]), asset('hidden', 8, ids[1]), asset('old', 7, ids[2])];
    const hidden = record(source[1]!, { hidden: true, pinnedAt: null });
    const before = structuredClone(source);
    const visible = curateGalleryAssets('images', source, [hidden]);
    expect(visible.map(item => item.label)).toEqual(['new', 'old']);
    expect(source).toEqual(before);
    expect(visible[0]).toBe(source[0]);
  });

  it('keeps unpinned assets newest-message first and album cells in manifest order', () => {
    const source = [
      asset('old album 1', 8, ids[0], 1),
      asset('new album 2', 9, ids[1], 2),
      asset('stable b', 9, ids[3], 0),
      asset('new album 0', 9, ids[1], 0),
      asset('old album 0', 8, ids[0], 0),
      asset('stable a', 9, ids[2], 0),
      asset('new album 1', 9, ids[1], 1),
    ];
    expect(curateGalleryAssets('images', source, []).map(item => item.label)).toEqual([
      'new album 0', 'new album 1', 'new album 2', 'stable a', 'stable b', 'old album 0', 'old album 1',
    ]);
  });

  it('places pins by newest pinnedAt, then the same deterministic base order', () => {
    const source = [
      asset('ordinary newest', 20, ids[0]),
      asset('tie newer message', 18, ids[1]),
      asset('latest pin', 2, ids[2]),
      asset('tie older message', 4, ids[3]),
    ];
    const records = [
      record(source[1]!, { hidden: false, pinnedAt: 100 }),
      record(source[2]!, { hidden: false, pinnedAt: 200 }),
      record(source[3]!, { hidden: false, pinnedAt: 100 }),
    ];
    expect(curateGalleryAssets('images', [...source].reverse(), [...records].reverse()).map(item => item.label))
      .toEqual(['latest pin', 'tie newer message', 'tie older message', 'ordinary newest']);
  });

  it('isolates image and file records even when message ID and asset index match', () => {
    const image = asset('image', 2, ids[0], 0, 'images');
    const file = asset('file', 2, ids[0], 0, 'files');
    const hideFile = record(file, { hidden: true, pinnedAt: null });
    const pinImage = record(image, { hidden: false, pinnedAt: 100 });
    expect(curateGalleryAssets('images', [image], [hideFile])).toEqual([image]);
    expect(curateGalleryAssets('files', [file], [pinImage])).toEqual([file]);
    expect(curateGalleryAssets('files', [file], [hideFile, pinImage])).toEqual([]);
  });

  it('rejects mixed-category, malformed, duplicate, sparse, or oversized asset input', () => {
    const valid = asset('valid', 1, ids[0]);
    expect(() => curateGalleryAssets('images', [valid, { ...valid }], [])).toThrow('重复');
    expect(() => curateGalleryAssets('images', [asset('file', 1, ids[1], 0, 'files')], [])).toThrow(TypeError);
    expect(() => curateGalleryAssets('images', [{ ...valid, seq: -1 }], [])).toThrow(TypeError);
    expect(() => curateGalleryAssets('images', [{ ...valid, seq: 1.5 }], [])).toThrow(TypeError);
    const sparse = new Array<TestAsset>(1);
    expect(() => curateGalleryAssets('images', sparse, [])).toThrow(TypeError);
    expect(() => curateGalleryAssets('images', new Array(MAX_GALLERY_CURATION_ASSETS + 1).fill(valid), [])).toThrow(RangeError);
  });
});
