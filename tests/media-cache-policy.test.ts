import { expect, it } from 'vitest';
import { MEDIA_CACHE_BYTES, mediaCacheBudget, mediaCacheEvictions } from '../src/lib/media-cache-policy';
it('limits disposable cache by both the product cap and the remaining origin quota', () => {
  expect(mediaCacheBudget(undefined, 0)).toBe(MEDIA_CACHE_BYTES);
  expect(mediaCacheBudget({ quota: 2 ** 40, usage: 0 }, 0)).toBe(MEDIA_CACHE_BYTES);
  expect(mediaCacheBudget({ quota: 100 * 1024 ** 2, usage: 90 * 1024 ** 2 }, 50 * 1024 ** 2)).toBe(0);
});
it('evicts complete assets across rooms by recency and accounts only for replacement delta', () => {
  const entries = [{ id: 'a', roomId: 'a', bytes: 50, usedAt: 1 }, { id: 'b', roomId: 'b', bytes: 40, usedAt: 2 }];
  expect(mediaCacheEvictions(entries, { id: 'c', roomId: 'c', bytes: 20, usedAt: 3 }, 100)).toEqual(['a']);
  expect(mediaCacheEvictions(entries, { id: 'a', roomId: 'a', bytes: 0, usedAt: 3 }, 100)).toEqual([]);
  expect(mediaCacheEvictions(entries, { id: 'a', roomId: 'a', bytes: 20, usedAt: 3 }, 100)).toEqual(['b']);
});
