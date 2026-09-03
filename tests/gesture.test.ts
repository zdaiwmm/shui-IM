import { describe, expect, it } from 'vitest';
import { gestureSecret, normalizeGesturePath } from '../src/lib/gesture';

describe('gesture normalization', () => {
  it('adds unvisited midpoint dots for straight skipped paths', () => {
    expect(normalizeGesturePath([0, 2, 8, 6])).toEqual([0, 1, 2, 5, 8, 7, 6]);
  });

  it('never records the same dot twice', () => {
    expect(normalizeGesturePath([0, 1, 1, 4, 0, 8])).toEqual([0, 1, 4, 8]);
  });

  it('requires four points and domain-separates the KDF secret', () => {
    expect(() => gestureSecret([0, 1, 2])).toThrow('至少连接 4 个点');
    expect(gestureSecret([0, 1, 4, 8])).toBe('quiet-room-gesture-v1:0.1.4.8');
  });
});
