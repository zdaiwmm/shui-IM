type ViewportSample = {
  height: number;
  width: number;
  top: number;
  layoutHeight: number;
  scrollY: number;
  keyboardOpen: boolean;
  keyboardGeometry: 'closed' | 'intermediate' | 'open';
};

type KeyboardTarget = 'open' | 'closed';

type MotionOptions = {
  conceal: (immediate: boolean) => void;
  reveal: () => void;
  settled: () => void;
  now?: () => number;
};

export const CHAT_VIEWPORT_SETTLE_MS = 160;
// A hardware/floating keyboard may focus the textarea without changing the
// visual viewport enough to cross the soft-keyboard threshold. Do not leave
// the composer concealed forever when the requested target cannot be observed.
export const CHAT_KEYBOARD_TARGET_FALLBACK_MS = 640;
// Once native geometry has actually started moving, a short fallback would
// expose a quiet intermediate keyboard frame. Retain a hard upper bound for
// unusual split/floating keyboards and targetless sub-threshold viewport
// shifts without treating that frame as settled.
export const CHAT_KEYBOARD_MOVED_FALLBACK_MS = 1_600;

// Driven by the chat's existing viewport sampler. No timeout or independent
// animation survives privacy teardown, and idle samples never measure content.
export function createChatViewportMotion(options: MotionOptions) {
  const now = options.now ?? (() => performance.now());
  let previous: ViewportSample | null = null;
  let hidden = false;
  let moving = false;
  let touching = false;
  let manual = false;
  let lastMovement = 0;
  let motionStarted = 0;
  let keyboardTarget: KeyboardTarget | null = null;
  let keyboardTargetStarted = 0;
  let keyboardTargetSawGeometry = false;
  let stableKeyboardState: KeyboardTarget | null = null;
  let transitionOrigin: ViewportSample | null = null;
  const keyboardSpace = (sample: ViewportSample) => Math.max(0, sample.layoutHeight - sample.height);
  const samplesDiffer = (first: ViewportSample | null, second: ViewportSample | null) => Boolean(first && second
    && (first.height !== second.height || first.width !== second.width || first.top !== second.top
      || first.layoutHeight !== second.layoutHeight || first.keyboardOpen !== second.keyboardOpen
      || first.keyboardGeometry !== second.keyboardGeometry));
  const setKeyboardTarget = (next: KeyboardTarget, sawGeometry: boolean, started = now()) => {
    keyboardTarget = next;
    keyboardTargetStarted = started;
    keyboardTargetSawGeometry = sawGeometry;
  };
  const conceal = (immediate: boolean) => {
    const timestamp = now();
    if (!moving) motionStarted = timestamp;
    hidden = true;
    moving = true;
    lastMovement = timestamp;
    options.conceal(immediate);
  };
  return {
    sample(sample: ViewportSample) {
      let settledThisSample = false;
      const prior = previous;
      const geometryChanged = prior !== null && (prior.height !== sample.height || prior.width !== sample.width
        || prior.top !== sample.top || prior.layoutHeight !== sample.layoutHeight
        || prior.keyboardOpen !== sample.keyboardOpen || prior.keyboardGeometry !== sample.keyboardGeometry);
      const scrolled = prior !== null && Math.abs(prior.scrollY - sample.scrollY) > 0.5;
      if (geometryChanged && !moving) transitionOrigin = prior;
      if (geometryChanged && keyboardTarget !== null) keyboardTargetSawGeometry = true;
      previous = sample;
      // Suspension stops sampling while the chat is away or covered. Time
      // spent there is not evidence that the first geometry observed on
      // return was stable, and its fixed controls have not yet been moved by
      // the owner's current frame. Rebuild the baseline now and require a
      // fresh settle window before committing document geometry or revealing.
      if (hidden && prior === null) {
        motionStarted = now();
        lastMovement = motionStarted;
        if (keyboardTarget !== null) {
          keyboardTargetStarted = motionStarted;
          keyboardTargetSawGeometry = sample.keyboardGeometry === 'intermediate';
        }
        return false;
      }
      // A chat can mount while Safari is between its closed and open
      // geometries (or while a split keyboard owns that band). There is no
      // prior sample to diff, but showing a new composer at this height would
      // expose exactly the transient mid-screen frame this gate prevents.
      if (prior === null && sample.keyboardGeometry === 'intermediate') {
        conceal(true);
        return false;
      }
      // Never expose an intermediate position, even if the browser reports
      // its first keyboard/toolbar frame before a preceding focus event.
      if (geometryChanged) conceal(true);
      else if (manual && scrolled) conceal(true);
      // WebKit can publish resize before textarea focus/blur. Infer a likely
      // keyboard direction only after geometry has moved materially away from
      // the last stable endpoint; ordinary toolbar shifts remain targetless.
      if (moving && keyboardTarget === null && transitionOrigin && stableKeyboardState) {
        const delta = keyboardSpace(sample) - keyboardSpace(transitionOrigin);
        const directionalThreshold = Math.max(72, transitionOrigin.layoutHeight * 0.1);
        if (stableKeyboardState === 'closed' && delta >= directionalThreshold) {
          setKeyboardTarget('open', true, lastMovement);
        } else if (stableKeyboardState === 'open' && delta <= -directionalThreshold) {
          setKeyboardTarget('closed', true, lastMovement);
        }
      }
      const targetReached = keyboardTarget === null
        ? sample.keyboardGeometry !== 'intermediate'
        : sample.keyboardGeometry === keyboardTarget;
      const targetFallback = keyboardTarget !== null && (
        !keyboardTargetSawGeometry && now() - keyboardTargetStarted >= CHAT_KEYBOARD_TARGET_FALLBACK_MS
        || keyboardTargetSawGeometry && now() - keyboardTargetStarted >= CHAT_KEYBOARD_MOVED_FALLBACK_MS
      );
      // A tall viewport can move into the intermediate band by slightly less
      // than the proportional direction threshold. Such a resize remains
      // targetless, so give its quiet intermediate frame the same long hard
      // bound as other geometry-backed transitions instead of hiding forever.
      const targetlessIntermediateFallback = keyboardTarget === null
        && sample.keyboardGeometry === 'intermediate'
        && now() - motionStarted >= CHAT_KEYBOARD_MOVED_FALLBACK_MS;
      if (!hidden && keyboardTarget !== null && !keyboardTargetSawGeometry
        && now() - keyboardTargetStarted >= CHAT_KEYBOARD_TARGET_FALLBACK_MS) {
        keyboardTarget = null;
        transitionOrigin = null;
      }
      // Safari can leave a quiet gap between browser-toolbar and keyboard
      // phases. A quiet intermediate height is not the requested endpoint:
      // commit document geometry only after that endpoint itself is stable.
      const quiet = now() - lastMovement >= CHAT_VIEWPORT_SETTLE_MS;
      const hardFallback = targetFallback || targetlessIntermediateFallback;
      if (hidden && !touching && (targetReached && quiet || hardFallback && (!manual || quiet))) {
        moving = false;
        manual = false;
        motionStarted = 0;
        if (sample.keyboardGeometry !== 'intermediate') stableKeyboardState = sample.keyboardGeometry;
        keyboardTarget = null;
        keyboardTargetSawGeometry = false;
        transitionOrigin = null;
        options.settled();
        hidden = false;
        options.reveal();
        settledThisSample = true;
      }
      if (!moving && sample.keyboardGeometry !== 'intermediate') stableKeyboardState = sample.keyboardGeometry;
      return settledThisSample;
    },
    keyboard(target: KeyboardTarget) {
      if (hidden && keyboardTarget === target) return;
      const beganDuringMotion = moving;
      if (!transitionOrigin) transitionOrigin = previous;
      setKeyboardTarget(target, samplesDiffer(transitionOrigin, previous), beganDuringMotion ? lastMovement : now());
      conceal(true);
    },
    anticipateKeyboard(target: KeyboardTarget) {
      if (keyboardTarget === target) return;
      if (!transitionOrigin) transitionOrigin = previous;
      setKeyboardTarget(target, false);
    },
    touchStart() { touching = true; },
    move() { manual = true; conceal(true); },
    automaticScroll() { manual = false; touching = false; },
    touchEnd() { touching = false; if (hidden) lastMovement = now(); },
    suspend() {
      previous = null; touching = false; manual = false; keyboardTarget = null;
      keyboardTargetSawGeometry = false; stableKeyboardState = null; transitionOrigin = null;
      conceal(true);
    },
    get concealed() { return hidden; },
    get moving() { return moving; },
    get keyboardMoving() { return keyboardTarget !== null; },
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
