import { motion, retargetMotion } from './motion';

/** Presentation only: never captures pointers, delays clicks or consumes editing keys. */
export function bindControlFeedback(root: HTMLElement): () => void {
  const events = new AbortController();
  const signal = events.signal;
  const activeEffects = new Set<Animation>();
  const track = (effect: Animation) => { activeEffects.add(effect); void effect.finished.then(() => activeEffects.delete(effect), () => activeEffects.delete(effect)); };
  const selector = '.icon-button,.send-button,.viewer-control,.voice-control,.voice-toggle,.call-control';
  const effects = new WeakMap<HTMLElement, Animation>();
  let pressed: { button: HTMLButtonElement; target: HTMLElement; pointer?: number; small: boolean } | null = null;
  const release = (cancelled = false) => {
    const state = pressed; pressed = null;
    if (!state) return;
    delete state.button.dataset.motionPressed;
    const previous = effects.get(state.target);
    const property = state.small ? 'scale' : 'opacity';
    const value = Number.parseFloat(getComputedStyle(state.target)[property]) || 1;
    previous?.cancel();
    // Even a very short tap receives a bounded acknowledgement after release.
    // Sliding off only restores the current position and never looks activated.
    const effect = retargetMotion(state.target, null,
      { [property]: cancelled ? value : Math.min(.97, value) }, { [property]: 1 }, motion.feedback);
    if (effect) { effects.set(state.target, effect); track(effect); }
  };
  const press = (event: Event, pointer?: number) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    if (!button || !root.contains(button) || button.disabled || button.closest('[inert]')) return;
    release(true);
    const target = button.querySelector<HTMLElement>('.call-control-disc') ?? button;
    const small = button.matches(selector);
    pressed = { button, target, pointer, small };
    button.dataset.motionPressed = 'true';
    const effect = retargetMotion(target, effects.get(target), small ? { scale: 1 } : { opacity: 1 }, small ? { scale: .94 } : { opacity: .78 }, 70);
    if (effect) { effects.set(target, effect); track(effect); }
  };
  root.addEventListener('pointerdown', event => { if (event.isPrimary && event.button === 0) press(event, event.pointerId); }, { signal });
  root.addEventListener('pointerout', event => {
    if (pressed?.pointer === event.pointerId && !(event.relatedTarget instanceof Node && pressed.button.contains(event.relatedTarget))) release(true);
  }, { signal });
  document.addEventListener('pointerup', event => { if (pressed?.pointer === event.pointerId) release(); }, { capture: true, signal });
  document.addEventListener('pointercancel', event => { if (pressed?.pointer === event.pointerId) release(true); }, { capture: true, signal });
  root.addEventListener('keydown', event => { if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) press(event); }, { signal });
  root.addEventListener('keyup', event => { if (pressed?.pointer === undefined && (event.key === ' ' || event.key === 'Enter')) release(); }, { signal });
  root.addEventListener('focusout', () => release(true), { signal });
  window.addEventListener('blur', () => release(true), { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(true); }, { signal });
  return () => {
    events.abort();
    if (pressed) delete pressed.button.dataset.motionPressed;
    pressed = null;
    activeEffects.forEach(effect => effect.cancel()); activeEffects.clear();
  };
}
