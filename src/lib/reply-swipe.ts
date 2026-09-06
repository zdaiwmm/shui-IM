export const REPLY_SWIPE_THRESHOLD_PX = 96;
export const REPLY_SWIPE_MAX_OFFSET_PX = 480;
const REPLY_SWIPE_RESISTANCE_START_PX = 360;

/** Follow the finger across a phone width, then add resistance before the hard bound. */
export function replySwipeOffset(distance: number): number {
  const raw = Math.max(0, Number.isFinite(distance) ? distance : 0);
  if (raw <= REPLY_SWIPE_RESISTANCE_START_PX) return raw;
  const resistantDistance = raw - REPLY_SWIPE_RESISTANCE_START_PX;
  const resistantRange = REPLY_SWIPE_MAX_OFFSET_PX - REPLY_SWIPE_RESISTANCE_START_PX;
  return REPLY_SWIPE_RESISTANCE_START_PX
    + resistantRange * (1 - Math.exp(-resistantDistance / resistantRange));
}

export function bindReplySwipe(options: {
  element: HTMLElement;
  enabled: () => boolean;
  exclude: (target: EventTarget | null) => boolean;
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
    options.move(replySwipeOffset(distance), active.armed);
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
