import { MAX_IMAGE_ALBUM_ITEMS } from './message-payload';

export const GALLERY_CURATION_VERSION = 1 as const;
export const MAX_GALLERY_CURATION_RECORDS = 20_000;
export const MAX_GALLERY_CURATION_ASSETS = 20_000;
export const MAX_GALLERY_CURATION_ASSET_INDEX = MAX_IMAGE_ALBUM_ITEMS - 1;

export type GalleryCategory = 'images' | 'files';

export type GalleryCurationTarget = {
  category: GalleryCategory;
  clientMsgId: string;
  /** Zero for a single image, video, or file; the manifest index for an album. */
  assetIndex: number;
};

/**
 * Plaintext schema for one encrypted local curation record. A record is a
 * projection only: it never changes the underlying message or attachment.
 */
export type GalleryCurationRecord = GalleryCurationTarget & {
  v: typeof GALLERY_CURATION_VERSION;
  /** A durable local tombstone that excludes only this safe asset. */
  hidden: boolean;
  /** Milliseconds used only to rank pins inside the record's own category. */
  pinnedAt: number | null;
};

export type GalleryCurationAsset = GalleryCurationTarget & {
  /** Server sequence, or the caller's deterministic optimistic sequence. */
  seq: number;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_KEYS = ['v', 'category', 'clientMsgId', 'assetIndex', 'hidden', 'pinnedAt'] as const;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function isGalleryCategory(value: unknown): value is GalleryCategory {
  return value === 'images' || value === 'files';
}

function validClientMsgId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function validAssetIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_GALLERY_CURATION_ASSET_INDEX;
}

function validPinnedAt(value: unknown): value is number | null {
  return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertTarget(value: GalleryCurationTarget): void {
  if (!isGalleryCategory(value?.category) || !validClientMsgId(value?.clientMsgId) || !validAssetIndex(value?.assetIndex)) {
    throw new TypeError('保险箱策展目标不正确');
  }
}

/** A delimiter-safe, deterministic key suitable for a Map or encrypted row ID. */
export function galleryCurationKey(target: GalleryCurationTarget): string {
  assertTarget(target);
  return JSON.stringify([target.category, target.clientMsgId.toLowerCase(), Object.is(target.assetIndex, -0) ? 0 : target.assetIndex]);
}

export function normalizeGalleryCurationRecord(value: unknown): GalleryCurationRecord {
  if (!isRecordObject(value) || !hasExactKeys(value, RECORD_KEYS) ||
      value.v !== GALLERY_CURATION_VERSION || !isGalleryCategory(value.category) ||
      !validClientMsgId(value.clientMsgId) || !validAssetIndex(value.assetIndex) ||
      typeof value.hidden !== 'boolean' || !validPinnedAt(value.pinnedAt) ||
      value.hidden && value.pinnedAt !== null) {
    throw new TypeError('保险箱策展记录不正确');
  }
  return {
    v: GALLERY_CURATION_VERSION,
    category: value.category,
    clientMsgId: value.clientMsgId.toLowerCase(),
    assetIndex: Object.is(value.assetIndex, -0) ? 0 : value.assetIndex,
    hidden: value.hidden,
    pinnedAt: value.pinnedAt === null ? null : Object.is(value.pinnedAt, -0) ? 0 : value.pinnedAt,
  };
}

/**
 * Validate decrypted local state before it reaches gallery rendering. The
 * returned order is canonical so serialization does not depend on IDB order.
 */
export function normalizeGalleryCurationRecords(value: unknown): GalleryCurationRecord[] {
  if (!Array.isArray(value)) throw new TypeError('保险箱策展记录集合不正确');
  // Check the container before touching any entry, including sparse/getter
  // arrays supplied by damaged or hostile decrypted state.
  if (value.length > MAX_GALLERY_CURATION_RECORDS) throw new RangeError('保险箱策展记录数量超过上限');
  const normalized: GalleryCurationRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) throw new TypeError('保险箱策展记录集合不正确');
    const record = normalizeGalleryCurationRecord(value[index]);
    const key = galleryCurationKey(record);
    if (seen.has(key)) throw new TypeError('保险箱策展记录重复');
    seen.add(key);
    normalized.push(record);
  }
  return normalized.sort((left, right) => compareText(galleryCurationKey(left), galleryCurationKey(right)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBaseOrder(left: GalleryCurationAsset, right: GalleryCurationAsset): number {
  // Gallery history is newest-message first, while an album preserves the
  // sender's manifest order inside that message.
  if (left.seq !== right.seq) return left.seq > right.seq ? -1 : 1;
  if (left.clientMsgId.toLowerCase() === right.clientMsgId.toLowerCase() && left.assetIndex !== right.assetIndex) {
    return left.assetIndex < right.assetIndex ? -1 : 1;
  }
  return compareText(galleryCurationKey(left), galleryCurationKey(right));
}

function assertAsset(value: GalleryCurationAsset, category: GalleryCategory): void {
  assertTarget(value);
  if (value.category !== category || !Number.isSafeInteger(value.seq) || value.seq < 0) {
    throw new TypeError('保险箱资源不正确');
  }
}

/**
 * Apply a category-local curation projection without mutating assets, records,
 * messages, or server order. Hidden records remove only the matching safe
 * asset. Pinned records precede the ordinary newest-first projection.
 */
export function curateGalleryAssets<T extends GalleryCurationAsset>(
  category: GalleryCategory,
  assets: readonly T[],
  records: readonly GalleryCurationRecord[],
): T[] {
  if (!isGalleryCategory(category)) throw new TypeError('保险箱分类不正确');
  if (!Array.isArray(assets) || !Array.isArray(records)) throw new TypeError('保险箱策展输入不正确');
  if (assets.length > MAX_GALLERY_CURATION_ASSETS) throw new RangeError('保险箱资源数量超过上限');
  if (records.length > MAX_GALLERY_CURATION_RECORDS) throw new RangeError('保险箱策展记录数量超过上限');

  const normalizedRecords = normalizeGalleryCurationRecords(records);
  const curation = new Map<string, GalleryCurationRecord>();
  for (const record of normalizedRecords) {
    if (record.category === category) curation.set(galleryCurationKey(record), record);
  }

  const seen = new Set<string>();
  const visible: Array<{ asset: T; record?: GalleryCurationRecord }> = [];
  for (let index = 0; index < assets.length; index += 1) {
    if (!(index in assets)) throw new TypeError('保险箱资源集合不正确');
    const asset = assets[index]!;
    assertAsset(asset, category);
    const key = galleryCurationKey(asset);
    if (seen.has(key)) throw new TypeError('保险箱资源重复');
    seen.add(key);
    const record = curation.get(key);
    if (!record?.hidden) visible.push({ asset, ...(record ? { record } : {}) });
  }

  visible.sort((left, right) => {
    const leftPinned = left.record?.pinnedAt;
    const rightPinned = right.record?.pinnedAt;
    const leftIsPinned = leftPinned !== null && leftPinned !== undefined;
    const rightIsPinned = rightPinned !== null && rightPinned !== undefined;
    if (leftIsPinned !== rightIsPinned) return leftIsPinned ? -1 : 1;
    if (leftIsPinned && rightIsPinned && leftPinned !== rightPinned) return leftPinned! > rightPinned! ? -1 : 1;
    return compareBaseOrder(left.asset, right.asset);
  });
  return visible.map(({ asset }) => asset);
}
