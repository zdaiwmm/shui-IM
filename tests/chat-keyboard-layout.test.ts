import { describe, expect, it } from 'vitest';
import { createChatKeyboardLayout } from '../src/lib/chat-keyboard-layout';

const closed = { height: 695, layoutHeight: 695, width: 393 };
const opened = { ...closed, height: 319 };

function openedLayout() {
  const layout = createChatKeyboardLayout();
  layout.sample(closed, 0);
  layout.begin('open', 695, closed, 100);
  layout.sample(opened, 230);
  layout.sample(opened, 500);
  return layout;
}

describe('list keyboard layout', () => {
  it('waits for a measured first opening and joins its existing timeline', () => {
    const layout = createChatKeyboardLayout();
    layout.begin('open', 695, closed, 0);
    expect(layout.sample(closed, 100)).toBe(695);
    const joining = layout.sample(opened, 130);
    expect(joining).toBeGreaterThan(319);
    expect(joining).toBeLessThan(695);
    expect(layout.sample(opened, 360)).toBe(319);
    expect(layout.moving).toBe(false);
  });

  it('starts closing at blur and holds its endpoint through a late viewport event', () => {
    const layout = openedLayout();
    layout.begin('closed', 319, opened, 600);
    expect(layout.sample(opened, 700)).toBeGreaterThan(319);
    expect(layout.sample(opened, 960)).toBe(695);
    expect(layout.moving).toBe(true);
    expect(layout.sample(closed, 1050)).toBe(695);
    expect(layout.moving).toBe(false);
  });

  it('uses the measured keyboard only for the same viewport and can reverse at the painted height', () => {
    const layout = openedLayout();
    layout.begin('closed', 319, opened, 600);
    const painted = layout.sample(opened, 680);
    layout.begin('open', painted, opened, 680);
    expect(layout.sample(opened, 680)).toBe(painted);
    expect(layout.sample(opened, 720)).toBeLessThan(painted);
    expect(layout.sample(opened, 1040)).toBe(319);
    layout.begin('closed', 319, opened, 1100);
    layout.sample(closed, 1460);
    layout.begin('open', 695, closed, 1500);
    expect(layout.sample(closed, 1550)).toBeLessThan(695);
    const rotated = { height: 390, layoutHeight: 390, width: 844 };
    expect(layout.sample(rotated, 1560)).toBe(390);
    expect(layout.moving).toBe(false);
  });

  it('returns to browser geometry when a predicted keyboard never arrives', () => {
    const layout = openedLayout();
    layout.begin('closed', 319, opened, 600);
    layout.sample(closed, 1000);
    layout.begin('open', 695, closed, 1100);
    expect(layout.sample(closed, 1200)).toBeLessThan(695);
    expect(layout.sample(closed, 2000)).toBe(695);
    expect(layout.moving).toBe(false);
  });

  it('honors reduced motion and forgets geometry on teardown', () => {
    const layout = openedLayout();
    layout.begin('closed', 319, opened, 600);
    expect(layout.sample(opened, 600, true)).toBe(695);
    layout.reset();
    expect(layout.moving).toBe(false);
    layout.begin('open', 695, closed, 700);
    expect(layout.sample(closed, 800)).toBe(695);
  });
});
