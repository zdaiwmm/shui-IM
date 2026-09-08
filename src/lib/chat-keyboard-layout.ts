type Viewport = { height: number; layoutHeight: number; width: number };
type Direction = 'open' | 'closed';
export const CHAT_KEYBOARD_LAYOUT_MS = 360;

export function chatKeyboardLayoutProgress(elapsed: number): number {
  const time = Math.max(0, elapsed) / 1000;
  return elapsed >= CHAT_KEYBOARD_LAYOUT_MS ? 1 : 1 - (1 + 25 * time) * Math.exp(-25 * time);
}

// Safari reports opening geometry early and dismissal geometry after its
// animation. Keep one bounded layout owner across that reporting delay.
export function createChatKeyboardLayout() {
  let closed: Viewport | null = null;
  let opened: { height: number; width: number; closedHeight: number } | null = null;
  let motion: { direction: Direction; from: number; to: number | null;
    width: number; started: number; confirmed: boolean } | null = null;

  const observe = (viewport: Viewport) => {
    if (viewport.layoutHeight - viewport.height <= 120) closed = viewport;
    else if (closed?.width === viewport.width) {
      opened = { height: viewport.height, width: viewport.width, closedHeight: closed.height };
    }
  };
  return {
    begin(direction: Direction, from: number, viewport: Viewport, now: number) {
      observe(viewport);
      const cachedOpen = opened?.width === viewport.width && opened.closedHeight === closed?.height
        ? opened.height : null;
      motion = { direction, from, width: viewport.width, started: now, confirmed: false,
        to: direction === 'open' ? cachedOpen : closed?.width === viewport.width ? closed.height : null };
    },
    sample(viewport: Viewport, now: number, reducedMotion = false): number {
      observe(viewport);
      const current = motion;
      if (!current) return viewport.height;
      const elapsed = Math.max(0, now - current.started);
      if (current.width !== viewport.width || elapsed >= 900) {
        motion = null;
        return viewport.height;
      }
      const actual = viewport.layoutHeight - viewport.height > 120 ? 'open' : 'closed';
      if (actual === current.direction) {
        current.to = viewport.height;
        current.confirmed = true;
      }
      if (current.to === null) return viewport.height;
      // Critically damped motion fitted to the device recording. This is a
      // page approximation, not access to UIKit's private animation clock.
      const progress = reducedMotion ? 1 : chatKeyboardLayoutProgress(elapsed);
      const height = current.from + (current.to - current.from) * progress;
      if (progress === 1 && current.confirmed) motion = null;
      return Math.max(1, height);
    },
    get moving() { return motion !== null; },
    get transition() { return motion; },
    reset() { motion = null; closed = null; opened = null; },
  };
}
