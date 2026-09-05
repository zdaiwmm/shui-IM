export const REPLY_SWIPE_THRESHOLD_PX = 96;
export const REPLY_SWIPE_MAX_OFFSET_PX = 92;

/** A bounded, monotonic drag curve: the finger keeps moving while the bubble resists. */
export function replySwipeOffset(distance: number): number {
  const raw = Math.max(0, Number.isFinite(distance) ? distance : 0);
  return REPLY_SWIPE_MAX_OFFSET_PX * (1 - Math.exp(-raw / 110));
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
    try {
      if (options.element.hasPointerCapture(active.pointerId)) options.element.releasePointerCapture(active.pointerId);
    } catch { /* A detached element may no longer expose capture state. */ }
    options.settle(activated);
  };

  options.element.addEventListener('pointerdown', (event) => {
    if (!options.enabled() || !event.isPrimary || event.button !== 0 || event.pointerType === 'mouse' || options.exclude(event.target)) return;
    gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      axis: null,
      armed: false,
    };
  }, { signal: events.signal });

  options.element.addEventListener('pointermove', (event) => {
    const active = gesture;
    if (!active || active.pointerId !== event.pointerId) return;
    const horizontal = active.x - event.clientX;
    const vertical = event.clientY - active.y;
    if (!active.axis && Math.hypot(horizontal, vertical) > 8) {
      active.axis = horizontal > 0 && Math.abs(horizontal) > Math.abs(vertical) * 1.15 ? 'horizontal' : 'vertical';
      if (active.axis === 'horizontal') {
        options.gestureStart?.();
        try { options.element.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers have no capture owner. */ }
      }
    }
    if (active.axis !== 'horizontal') return;
    if (event.cancelable) event.preventDefault();
    const distance = Math.max(0, horizontal);
    active.armed = distance >= REPLY_SWIPE_THRESHOLD_PX;
    options.move(replySwipeOffset(distance), active.armed);
  }, { passive: false, signal: events.signal });

  const end = (event: PointerEvent, cancelled: boolean) => {
    const active = gesture;
    if (!active || active.pointerId !== event.pointerId) return;
    const distance = active.x - event.clientX;
    const elapsed = Math.max(1, performance.now() - active.startedAt);
    const fastCommit = active.axis === 'horizontal' && distance > 44 && distance / elapsed > 0.72;
    const activated = !cancelled && active.axis === 'horizontal' && (active.armed || fastCommit);
    reset(activated);
  };
  options.element.addEventListener('pointerup', event => end(event, false), { signal: events.signal });
  options.element.addEventListener('pointercancel', event => end(event, true), { signal: events.signal });
  options.element.addEventListener('lostpointercapture', event => end(event, true), { signal: events.signal });
  options.element.addEventListener('pointerleave', event => {
    if (gesture?.pointerId !== event.pointerId || options.element.hasPointerCapture(event.pointerId)) return;
    reset(false);
  }, { signal: events.signal });

  return {
    reset: () => reset(false),
    destroy: () => { reset(false); events.abort(); },
  };
}
