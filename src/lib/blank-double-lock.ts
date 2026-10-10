// Pointer events work for touch and mouse without depending on Safari emitting dblclick.
const controls = 'button,a,input,textarea,select,label,summary,[contenteditable]:not([contenteditable="false"]),'
  + '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="slider"],[role="option"],[role="tab"],'
  + '[tabindex]:not([tabindex="-1"]):not(.message),img,video,audio,canvas,svg,iframe,object,embed,'
  + '.message-bubble,.message-reactions,.viewer-stage,.voice-recorder,.idle-lock-prompt,[inert]';

export function bindBlankDoubleLock(root: HTMLElement, options: {
  active: () => boolean; generation: () => number; lock: () => void;
}): () => void {
  type Tap = { target: Element; x: number; y: number; time: number; generation: number; pointer: number; kind: string };
  let down: Tap | null = null, previous: Tap | null = null, suppressClickUntil = 0;
  const reset = () => { down = null; previous = null; };
  const blank = (target: EventTarget | null): target is Element => {
    if (!(target instanceof Element) || !target.isConnected || target.closest(controls)) return false;
    // Mounted application dialogs can live beside the app root.
    const surface = target.closest('.dialog-surface') ?? root;
    if (!surface.contains(target)) return false;
    for (let node: Element | null = target; node; node = node.parentElement) {
      if ([...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) return false;
      if (node === surface) return true;
    }
    return false;
  };
  document.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0 || !options.active() || !blank(event.target)) { reset(); return; }
    down = { target: event.target, x: event.clientX, y: event.clientY, time: performance.now(),
      generation: options.generation(), pointer: event.pointerId, kind: event.pointerType };
  }, { capture: true });
  document.addEventListener('pointermove', event => {
    if (down && (event.pointerId !== down.pointer || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10)) reset();
  }, { capture: true, passive: true });
  document.addEventListener('pointerup', event => {
    const tap = down; down = null;
    if (!tap || !event.isTrusted || event.pointerId !== tap.pointer || !options.active() || !blank(event.target)
      || event.target !== tap.target || tap.generation !== options.generation() || performance.now() - tap.time > 300
      || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10) { reset(); return; }
    const now = performance.now();
    if (previous && previous.target === tap.target && previous.kind === tap.kind && previous.generation === tap.generation
      && now - previous.time <= 350 && Math.hypot(tap.x - previous.x, tap.y - previous.y) <= 24) {
      reset(); suppressClickUntil = now + 500;
      event.preventDefault(); event.stopImmediatePropagation();
      options.lock();
    } else previous = { ...tap, time: now };
  }, { capture: true });
  for (const type of ['click', 'dblclick']) document.addEventListener(type, event => {
    // The completion click must never reach the newly mounted locked page.
    if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  for (const type of ['pointercancel', 'scroll', 'wheel', 'touchmove', 'keydown', 'visibilitychange', 'freeze']) {
    document.addEventListener(type, reset, { capture: true, passive: true });
  }
  window.addEventListener('blur', reset);
  window.addEventListener('pagehide', reset);
  return reset;
}
