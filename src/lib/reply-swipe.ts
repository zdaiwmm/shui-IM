export const REPLY_SWIPE_THRESHOLD_PX = 96;
export const REPLY_SWIPE_MAX_VIEWPORT_RATIO = 1 / 3;

export function replySwipeMaxOffset(viewportWidth: number): number {
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  return width * REPLY_SWIPE_MAX_VIEWPORT_RATIO;
}

/** Follow the finger through the activation range, then resist toward one third of the viewport. */
export function replySwipeOffset(distance: number, maximum = replySwipeMaxOffset(globalThis.innerWidth ?? 0)): number {
  const raw = Math.max(0, Number.isFinite(distance) ? distance : 0);
  const boundedMaximum = Math.max(0, Number.isFinite(maximum) ? maximum : 0);
  const resistanceStart = Math.min(REPLY_SWIPE_THRESHOLD_PX, boundedMaximum * 0.75);
  if (raw <= resistanceStart) return raw;
  if (boundedMaximum <= resistanceStart) return boundedMaximum;
  const resistantDistance = raw - resistanceStart;
  const resistantRange = boundedMaximum - resistanceStart;
  return resistanceStart
    + resistantRange * (1 - Math.exp(-resistantDistance / resistantRange));
}

export function bindReplySwipe(options: {
  element: HTMLElement;
  enabled: () => boolean;
  exclude: (target: EventTarget | null) => boolean;
  maxOffset: () => number;
  move: (offset: number, armed: boolean) => void;
  settle: (activated: boolean) => void;
  gestureStart?: () => void;
}) {
  const events = new AbortController();
  let gestureEvents: AbortController | null = null;
  let gesture: {
    pointerId: number;
    x: number;
    y: number;
    startedAt: number;
    axis: 'horizontal' | 'vertical' | null;
    armed: boolean;
  } | null = null;

  const reset = (activated = false) => {
    const active = gesture;
    if (!active) return;
    gesture = null;
    gestureEvents?.abort();
    gestureEvents = null;
    options.settle(activated);
  };

  const move = (event: PointerEvent) => {
    const active = gesture;
    if (!active || active.pointerId !== event.pointerId) return;
    const horizontal = active.x - event.clientX;
    const vertical = event.clientY - active.y;
    if (!active.axis && Math.hypot(horizontal, vertical) > 8) {
      active.axis = horizontal > 0 && Math.abs(horizontal) > Math.abs(vertical) * 1.15 ? 'horizontal' : 'vertical';
      if (active.axis === 'horizontal') options.gestureStart?.();
    }
    if (active.axis !== 'horizontal') return;
    if (event.cancelable) event.preventDefault();
    const distance = Math.max(0, horizontal);
    active.armed = distance >= REPLY_SWIPE_THRESHOLD_PX;
    options.move(replySwipeOffset(distance, options.maxOffset()), active.armed);
  };

  const end = (event: PointerEvent, cancelled: boolean) => {
    const active = gesture;
    if (!active || active.pointerId !== event.pointerId) return;
    const distance = active.x - event.clientX;
    const elapsed = Math.max(1, performance.now() - active.startedAt);
    const fastCommit = active.axis === 'horizontal' && distance > 44 && distance / elapsed > 0.72;
    const activated = !cancelled && active.axis === 'horizontal' && (active.armed || fastCommit);
    reset(activated);
  };

  options.element.addEventListener('pointerdown', (event) => {
    if (!options.enabled() || !event.isPrimary || event.button !== 0 || event.pointerType === 'mouse' || options.exclude(event.target)) return;
    reset(false);
    gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      axis: null,
      armed: false,
    };
    // Track the active pointer outside the message row. On iOS Safari a
    // transformed descendant can cross its original hit-test boundary, and
    // pointer capture may be lost before the finger is released. Treating
    // pointerleave/lostpointercapture as completion made the bubble snap back
    // early and discarded the later pointerup that should activate Reply.
    gestureEvents = new AbortController();
    window.addEventListener('pointermove', move, { passive: false, signal: gestureEvents.signal });
    window.addEventListener('pointerup', event => end(event, false), { signal: gestureEvents.signal });
    window.addEventListener('pointercancel', event => end(event, true), { signal: gestureEvents.signal });
  }, { signal: events.signal });

  return {
    reset: () => reset(false),
    destroy: () => { reset(false); gestureEvents?.abort(); events.abort(); },
  };
}
