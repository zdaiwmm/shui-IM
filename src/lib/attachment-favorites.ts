import { galleryCurationKey, normalizeGalleryCurationRecord, type GalleryCurationTarget } from './gallery-curation';

export type AttachmentFavorite = GalleryCurationTarget & { savedAt: number; pinnedAt: number | null };

export function normalizeAttachmentFavorites(value: unknown): AttachmentFavorite[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new TypeError('收藏记录格式不正确');
  const seen = new Set<string>();
  return Array.from(value, item => {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'assetIndex,category,clientMsgId,pinnedAt,savedAt' ||
        !Number.isSafeInteger(item.savedAt) || item.savedAt < 0) throw new TypeError('收藏记录格式不正确');
    const target = normalizeGalleryCurationRecord({ v: 1, category: item.category, clientMsgId: item.clientMsgId,
      assetIndex: item.assetIndex, hidden: false, pinnedAt: item.pinnedAt });
    const key = galleryCurationKey(target);
    if (seen.has(key)) throw new TypeError('收藏记录重复');
    seen.add(key);
    return { category: target.category, clientMsgId: target.clientMsgId, assetIndex: target.assetIndex,
      pinnedAt: target.pinnedAt, savedAt: item.savedAt };
  });
}

export function sortFavoriteAssets<T extends GalleryCurationTarget>(assets: readonly T[], favorites: readonly AttachmentFavorite[]): T[] {
  const records = new Map(favorites.map(record => [galleryCurationKey(record), record]));
  return assets.filter(asset => records.has(galleryCurationKey(asset))).sort((a, b) => {
    const left = records.get(galleryCurationKey(a))!;
    const right = records.get(galleryCurationKey(b))!;
    return Number(right.pinnedAt !== null) - Number(left.pinnedAt !== null) ||
      (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) || right.savedAt - left.savedAt ||
      a.clientMsgId.localeCompare(b.clientMsgId) || a.assetIndex - b.assetIndex;
  });
}
