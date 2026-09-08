import { describe, expect, it } from 'vitest';
import { normalizeAttachmentFavorites, sortFavoriteAssets } from '../src/lib/attachment-favorites';

const id = '00000000-0000-4000-8000-000000000001';
const favorite = { category: 'images' as const, clientMsgId: id, assetIndex: 0, savedAt: 100, pinnedAt: null };
describe('device-local attachment favorites', () => {
  it('starts empty and preserves the exact local target', () => {
    expect(normalizeAttachmentFavorites([])).toEqual([]);
    expect(normalizeAttachmentFavorites([favorite])).toEqual([favorite]);
  });
  it('rejects damaged, duplicate and out-of-range targets', () => {
    for (const records of [Array(1), [favorite, favorite], [{ ...favorite, assetIndex: 9 }], [{ ...favorite, savedAt: NaN }],
      [{ ...favorite, pinnedAt: -1 }], [{ ...favorite, clientMsgId: '../other' }], [{ ...favorite, unexpected: true }]]) {
      expect(() => normalizeAttachmentFavorites(records)).toThrow();
    }
  });
  it('only includes manually saved assets and ranks pins before save time', () => {
    const second = { ...favorite, assetIndex: 1, savedAt: 200 };
    const third = { ...favorite, assetIndex: 2, savedAt: 1, pinnedAt: 50 };
    const unselected = { ...favorite, assetIndex: 3 };
    expect(sortFavoriteAssets([favorite, second, third, unselected], [favorite, second, third]).map(a => a.assetIndex)).toEqual([2, 1, 0]);
  });
});
