export const MEDIA_CACHE_BYTES = 1024 ** 3;
export const MEDIA_CACHE_FILE_BYTES = 128 * 1024 ** 2;
export const MEDIA_CACHE_RESERVE_BYTES = 64 * 1024 ** 2;
export type MediaCacheEntry = { id: string; roomId: string; bytes: number; usedAt: number };
export function mediaCacheBudget(estimate: StorageEstimate | undefined, cacheBytes: number): number {
  if (!estimate || !Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return MEDIA_CACHE_BYTES;
  const other = Math.max(0, estimate.usage! - cacheBytes);
  return Math.max(0, Math.min(MEDIA_CACHE_BYTES, estimate.quota! - other - MEDIA_CACHE_RESERVE_BYTES));
}
export function mediaCacheEvictions(entries: MediaCacheEntry[], incoming: MediaCacheEntry, budget: number): string[] {
  let bytes = entries.reduce((sum, item) => sum + item.bytes, 0) + incoming.bytes;
  const removed: string[] = [];
  for (const item of [...entries].sort((a, b) => a.usedAt - b.usedAt)) {
    if (bytes <= budget) break;
    if (item.id === incoming.id) continue;
    removed.push(item.id); bytes -= item.bytes;
  }
  return removed;
}
