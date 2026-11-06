import { describe, expect, it } from 'vitest';
import { ChatRenderWindow } from '../src/lib/chat-render-window';

describe('bounded chat geometry', () => {
  it('maps variable heights and scrolling across ten thousand rows without losing the target', () => {
    const window = new ChatRenderWindow();
    const ids = Array.from({ length: 10000 }, (_, index) => `row-${index}`);
    window.sync(ids, 390);
    for (let index = 0; index < ids.length; index += 17) window.measure(ids[index]!, 140 + index % 300);
    for (let index = 0; index < ids.length; index += 41) {
      expect(window.at(window.offset(index) + .5)).toBe(index);
      window.choose(index);
      const mounted = window.mounted(['row-3']);
      expect(mounted).toContain(index); expect(mounted).toContain(3);
      expect(mounted.length).toBeLessThanOrEqual(97);
    }
  });
  it('preserves the selected range across arrivals, adapts to prepends and invalidates old width measurements', () => {
    const window = new ChatRenderWindow();
    const ids = Array.from({ length: 500 }, (_, index) => `row-${index}`);
    window.sync(ids, 390); window.choose(250);
    const before = window.mounted();
    window.sync([...ids, 'new'], 390); window.choose(500, true);
    expect(window.mounted()).toEqual(before);
    window.measure('row-1', 200);
    expect(window.offset(2)).toBe(276);
    window.sync(['older', ...ids, 'new'], 390);
    expect(window.index('row-250')).toBe(251);
    expect(window.start).toBe(before[0]! + 1);
    window.sync(['older', ...ids, 'new'], 1280);
    expect(window.offset(3)).toBe(228);
    window.sync([], 390); window.choose(0);
    expect(window.mounted()).toEqual([]); expect(window.offset(10000)).toBe(0);
  });
});
