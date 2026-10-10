import { describe, expect, it } from 'vitest';
import { messageActionLayout } from '../src/lib/chat-visuals';

describe('selected message and action surfaces in the visible viewport', () => {
  it('keeps the reaction / complete message / menu order at the bottom edge', () => {
    const placement = messageActionLayout({ left: 0, top: 0, width: 390, height: 695 },
      { left: 10, top: 600, width: 260, height: 56 }, 50, 234);
    expect(placement.previewHeight).toBe(56);
    expect(placement.pickerTop).toBeGreaterThanOrEqual(8);
    expect(placement.pickerTop + 50).toBeLessThan(placement.previewTop);
    expect(placement.listTop).toBeGreaterThan(placement.previewTop + placement.previewHeight);
    expect(placement.listTop + placement.listHeight).toBeLessThanOrEqual(687);
  });
  it('retains a readable preview and scrollable actions above a tall keyboard', () => {
    const placement = messageActionLayout({ left: 0, top: 36, width: 320, height: 270 },
      { left: 14, top: 160, width: 270, height: 700 }, 50, 234);
    expect(placement.previewHeight).toBeGreaterThanOrEqual(44);
    expect(placement.previewHeight).toBeLessThan(700);
    expect(placement.pickerTop).toBeGreaterThanOrEqual(44);
    expect(placement.listHeight).toBeGreaterThanOrEqual(44);
    expect(placement.listTop + placement.listHeight).toBeLessThanOrEqual(298);
  });
  it('fits the deletion submenu after reactions are removed without moving the source', () => {
    const bubble = { left: 14, top: 90, width: 270, height: 56 };
    const placement = messageActionLayout({ left: 0, top: 0, width: 390, height: 695 }, bubble, 0, 100);
    expect(placement.previewTop).toBe(bubble.top);
    expect(placement.listHeight).toBe(100);
    expect(bubble).toEqual({ left: 14, top: 90, width: 270, height: 56 });
  });
});
