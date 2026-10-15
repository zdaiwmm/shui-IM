type Viewport = { height: number; layoutHeight: number; width: number };
type Direction = 'open' | 'closed';
export const CHAT_KEYBOARD_LAYOUT_MS = 360;

export function chatKeyboardLayoutProgress(elapsed: number): number {
  const time = Math.min(1, Math.max(0, elapsed) / CHAT_KEYBOARD_LAYOUT_MS);
  return time * time * (3 - 2 * time);
}

// Safari reports opening geometry early and dismissal geometry after its
// animation. Keep one bounded layout owner across that reporting delay.
export function createChatKeyboardLayout() {
  let closed: Viewport | null = null;
  let opened: { height: number; width: number; closedHeight: number } | null = null;
  let motion: { direction: Direction; from: number; to: number | null;
    width: number; started: number; confirmed: boolean; nativeProgress: boolean } | null = null;

  const observe = (viewport: Viewport, closing = false) => {
    if (viewport.layoutHeight - viewport.height <= 120) closed = viewport;
    else if (!closing && closed?.width === viewport.width) {
      opened = { height: viewport.height, width: viewport.width, closedHeight: closed.height };
    }
  };
  return {
    begin(direction: Direction, from: number, viewport: Viewport, now: number) {
      observe(viewport);
      const cachedOpen = opened?.width === viewport.width && opened.closedHeight === closed?.height
        ? opened.height : null;
      motion = { direction, from, width: viewport.width, started: now, confirmed: false,
        nativeProgress: false,
        to: direction === 'open' ? cachedOpen : closed?.width === viewport.width ? closed.height : null };
    },
    sample(viewport: Viewport, now: number, reducedMotion = false): number {
      observe(viewport, motion?.direction === 'closed');
      const current = motion;
      if (!current) return viewport.height;
      const elapsed = Math.max(0, now - current.started);
      if (current.width !== viewport.width || elapsed >= 900) {
        motion = null;
        return viewport.height;
      }
      const actual = viewport.layoutHeight - viewport.height > 120 ? 'open' : 'closed';
      // A cached endpoint must not move the row before the keyboard actually
      // starts. When WebKit supplies intermediate geometry, follow it directly
      // instead of superimposing a second animation on the native movement.
      if (current.direction === 'open' && !current.confirmed && actual !== 'open') return current.from;
      if (actual === current.direction) {
        if (current.direction === 'open' && current.to !== null
          && (current.confirmed && Math.abs(viewport.height - current.to) > 2 || viewport.height > current.to + 2)
          && viewport.height < current.from - 2) current.nativeProgress = true;
        current.to = viewport.height;
        current.confirmed = true;
      }
      if (current.nativeProgress) {
        if (elapsed >= CHAT_KEYBOARD_LAYOUT_MS) motion = null;
        return viewport.height;
      }
      if (current.to === null) return viewport.height;
      // Smooth fallback for an endpoint-only viewport report. This remains a
      // page approximation, not access to UIKit's private animation clock.
      const progress = reducedMotion ? 1 : chatKeyboardLayoutProgress(elapsed);
      const height = current.from + (current.to - current.from) * progress;
      if (progress === 1 && current.confirmed) motion = null;
      return Math.max(1, height);
    },
    get moving() { return motion !== null; },
    get transition() { return motion?.nativeProgress || motion?.direction === 'open' && !motion.confirmed ? null : motion; },
    get occupiedHeight() { return closed && opened?.width === closed.width && opened.closedHeight === closed.height ? Math.max(0, closed.height - opened.height) : 0; },
    get closedHeight() { return closed?.height; },
    reset() { motion = null; closed = null; opened = null; },
  };
}
