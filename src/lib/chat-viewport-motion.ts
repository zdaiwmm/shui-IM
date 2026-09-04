type ViewportSample = { height: number; width: number; top: number; layoutHeight: number; scrollY: number };

type MotionOptions = {
  conceal: (immediate: boolean) => void;
  reveal: () => void;
  settled: () => void;
  now?: () => number;
};

// Driven by the chat's existing viewport sampler. No timeout or independent
// animation survives privacy teardown, and idle samples never measure content.
export function createChatViewportMotion(options: MotionOptions) {
  const now = options.now ?? (() => performance.now());
  let previous: ViewportSample | null = null;
  let hidden = false;
  let touching = false;
  let manual = false;
  let lastMovement = 0;
  const conceal = (immediate: boolean) => {
    hidden = true;
    lastMovement = now();
    options.conceal(immediate);
  };
  return {
    sample(sample: ViewportSample) {
      const geometryChanged = previous !== null && (previous.height !== sample.height || previous.width !== sample.width
        || previous.top !== sample.top || previous.layoutHeight !== sample.layoutHeight);
      const scrolled = previous !== null && Math.abs(previous.scrollY - sample.scrollY) > 0.5;
      previous = sample;
      // Never expose an intermediate position, even if the browser reports
      // its first keyboard/toolbar frame before a preceding focus event.
      if (geometryChanged) conceal(true);
      else if (manual && scrolled) conceal(false);
      if (hidden && !touching && now() - lastMovement >= 80) {
        hidden = false;
        manual = false;
        options.settled();
        options.reveal();
      }
    },
    keyboard() { conceal(false); },
    touchStart() { touching = true; },
    move() { manual = true; conceal(false); },
    automaticScroll() { manual = false; touching = false; },
    touchEnd() { touching = false; if (hidden) lastMovement = now(); },
    suspend() {
      previous = null; touching = false; manual = false;
      conceal(true);
    },
  };
}

type KeyboardGestureOptions = {
  list: HTMLElement;
  input: HTMLTextAreaElement;
  active: () => boolean;
  begin: () => void;
  release: () => void;
};

// A keyboard-open history touch belongs to keyboard dismissal until release.
// Preventing the pointer focus default and touch scrolling keeps both the
// focused draft and the visible reading position intact throughout the drag.
export function bindChatKeyboardGesture(options: KeyboardGestureOptions) {
  const events = new AbortController();
  let held = false;
  let touchCount = 0;
  const start = (event: Event) => {
    if (event.target instanceof Element && event.target.closest('.is-selecting-text')) return false;
    if (!options.active() || document.documentElement.dataset.keyboardOpen !== 'true') return false;
    if (event.type === 'touchstart') touchCount = (event as TouchEvent).touches.length;
    if (!held) {
      held = true;
      options.list.dataset.keyboardGesture = 'true';
      options.begin();
    }
    if (event.type === 'pointerdown' && event.cancelable) event.preventDefault();
    return true;
  };
  const release = () => {
    if (!held) return;
    held = false;
    delete options.list.dataset.keyboardGesture;
    if (!options.active()) return;
    options.release();
    // Opacity-only concealment does not remove focus or the encrypted draft.
    // Blur happens exclusively on release, never while the finger is moving.
    if (document.activeElement === options.input) options.input.blur();
  };
  options.list.addEventListener('touchstart', start, { passive: true, signal: events.signal });
  options.list.addEventListener('touchmove', event => {
    if (held && event.cancelable) event.preventDefault();
  }, { passive: false, signal: events.signal });
  // Pointer release may precede touchend; the shared held flag makes this once.
  const pointerRelease = () => { if (!touchCount) release(); };
  document.addEventListener('pointerup', pointerRelease, { capture: true, signal: events.signal });
  document.addEventListener('pointercancel', pointerRelease, { capture: true, signal: events.signal });
  const touchRelease = (event: TouchEvent) => { touchCount = event.touches.length; if (!touchCount) release(); };
  document.addEventListener('touchend', touchRelease, { capture: true, signal: events.signal });
  document.addEventListener('touchcancel', touchRelease, { capture: true, signal: events.signal });
  const reset = () => { held = false; touchCount = 0; delete options.list.dataset.keyboardGesture; };
  return {
    start,
    get held() { return held; },
    reset,
    destroy() { reset(); events.abort(); },
  };
}
