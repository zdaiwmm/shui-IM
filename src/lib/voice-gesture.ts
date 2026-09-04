import type { VoiceRecorder } from './voice-recorder';

// Capture on the composer: the original microphone is hidden while recording,
// but the pointer must stay owned until release, including outside the button.
export function bindVoiceRecordGesture(
  button: HTMLButtonElement,
  begin: (mode: 'hold' | 'locked') => VoiceRecorder | null,
): { cancel: () => void; destroy: () => void } {
  const binding = new AbortController();
  const composer = button.parentElement!;
  let suppressPointerClick = false;
  let gesture: AbortController | null = null;
  let timer: number | null = null;
  let activeRecorder: VoiceRecorder | null = null;
  let capture: HTMLElement | null = null;
  let pointerId: number | null = null;

  const cancel = () => {
    if (gesture) suppressPointerClick = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    gesture?.abort();
    gesture = null;
    if (pointerId !== null && capture?.hasPointerCapture(pointerId)) capture.releasePointerCapture(pointerId);
    pointerId = null;
    capture = null;
    activeRecorder = null;
    button.classList.remove('is-pressing');
  };

  // Touch browsers can retarget the compatibility click to a control revealed
  // underneath the finger (for example, Send after an interrupted recording).
  // Consume that release click, then allow the next deliberate pointer press.
  composer.addEventListener('pointerdown', () => { suppressPointerClick = false; }, { capture: true, signal: binding.signal });
  composer.addEventListener('click', event => {
    if (!suppressPointerClick || event.detail === 0) return;
    suppressPointerClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, signal: binding.signal });

  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || button.disabled || gesture) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const bounds = button.getBoundingClientRect();
    let held = false;
    gesture = new AbortController();
    const signal = gesture.signal;
    pointerId = event.pointerId;
    capture = button.parentElement;
    try { capture?.setPointerCapture(event.pointerId); } catch { /* Synthetic input has no capture owner. */ }
    button.classList.add('is-pressing');
    timer = window.setTimeout(() => {
      timer = null;
      held = true;
      if (!button.isConnected || button.disabled) { cancel(); return; }
      activeRecorder = begin('hold');
      button.classList.remove('is-pressing');
    }, 180);

    window.addEventListener('pointermove', move => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (!held && Math.hypot(dx, dy) > 12) { cancel(); return; }
      activeRecorder?.moveHold(dx, dy);
    }, { signal, passive: false });

    window.addEventListener('pointerup', up => {
      if (up.pointerId !== pointerId) return;
      up.preventDefault();
      const recorder = activeRecorder;
      // Use release coordinates too; a browser may coalesce the final move.
      recorder?.moveHold(up.clientX - startX, up.clientY - startY);
      cancel();
      if (held) recorder?.releaseHold();
      else if (button.isConnected && !button.disabled && up.clientX >= bounds.left && up.clientX <= bounds.right
        && up.clientY >= bounds.top && up.clientY <= bounds.bottom) begin('locked');
    }, { signal, passive: false });

    const interrupt = () => {
      const recorder = activeRecorder;
      cancel();
      recorder?.releaseHold(true);
    };
    window.addEventListener('pointercancel', event => { if (event.pointerId === pointerId) interrupt(); }, { signal });
    capture?.addEventListener('lostpointercapture', event => { if (event.pointerId === pointerId) interrupt(); }, { signal });
    window.addEventListener('blur', interrupt, { signal });
  }, { signal: binding.signal });
  button.addEventListener('click', event => {
    event.preventDefault();
    // Keyboard and assistive activation have no preceding pointer gesture.
    if (event.detail === 0 && !gesture && !button.disabled) begin('locked');
  }, { signal: binding.signal });
  button.addEventListener('contextmenu', event => event.preventDefault(), { signal: binding.signal });

  return { cancel, destroy: () => { cancel(); binding.abort(); } };
}
