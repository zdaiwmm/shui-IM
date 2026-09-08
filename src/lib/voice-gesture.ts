import type { VoiceRecorder } from './voice-recorder';

/** Empty-input hold owns its pointer; a short release keeps native typing. */
export function bindVoiceInputGesture(
  input: HTMLTextAreaElement,
  begin: (mode: 'hold' | 'locked') => VoiceRecorder | null,
): { cancel: () => void; destroy: () => void } {
  const binding = new AbortController();
  let pending: AbortController | null = null;
  let timer: number | null = null;
  let recorder: VoiceRecorder | null = null;
  let pointer: number | null = null;
  let held = false;
  let suppressClick = false;
  const owner = input.closest<HTMLElement>('.chat-shell') ?? input.parentElement!;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending?.abort(); pending = null;
    delete input.dataset.voicePress;
    const id = pointer; pointer = null;
    if (id !== null && owner.hasPointerCapture(id)) owner.releasePointerCapture(id);
    recorder = null;
  };
  owner.addEventListener('pointerdown', () => { suppressClick = false; }, { capture: true, signal: binding.signal });
  input.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || input.disabled || input.value || pending) return;
    event.preventDefault();
    held = false; suppressClick = false;
    input.dataset.voicePress = 'true';
    const startX = event.clientX; const startY = event.clientY;
    pending = new AbortController(); const signal = pending.signal;
    let awaitingTouchEnd = false;
    pointer = event.pointerId;
    try { owner.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer has no capture owner. */ }
    timer = window.setTimeout(() => {
      timer = null;
      if (!input.isConnected || input.disabled || input.value) { cancel(); return; }
      held = true; suppressClick = true;
      recorder = begin('hold');
    }, 350);
    window.addEventListener('pointermove', move => {
      if (move.pointerId !== pointer) return;
      if (!held && Math.hypot(move.clientX - startX, move.clientY - startY) > 12) { cancel(); return; }
      move.preventDefault();
      recorder?.moveHoldAt(move.clientX, move.clientY);
    }, { signal, passive: false });
    const finish = (release: Event, x: number, y: number) => {
      release.preventDefault();
      const active = recorder; const wasHeld = held;
      active?.moveHoldAt(x, y);
      cancel();
      if (wasHeld) active?.releaseHold();
      else if (input.isConnected && !input.disabled) input.focus({ preventScroll: true });
    };
    window.addEventListener('pointerup', up => {
      if (up.pointerId !== pointer) return;
      if (event.pointerType === 'touch') {
        awaitingTouchEnd = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return;
      }
      finish(up, up.clientX, up.clientY);
    }, { signal });
    // iOS keyboard activation needs the touch release. Focusing on pointerup
    // can leave an active textarea without a software keyboard.
    input.addEventListener('touchend', end => {
      if (event.pointerType !== 'touch' || end.touches.length) return;
      const touch = end.changedTouches[0];
      if (touch) finish(end, touch.clientX, touch.clientY);
    }, { signal, passive: false });
    const interrupt = () => { const active = recorder; suppressClick = held; cancel(); active?.releaseHold(true); };
    window.addEventListener('pointercancel', e => { if (e.pointerId === pointer) interrupt(); }, { signal });
    owner.addEventListener('lostpointercapture', e => { if (e.pointerId === pointer && !awaitingTouchEnd) interrupt(); }, { signal });
    input.addEventListener('touchcancel', interrupt, { signal });
    // App lifecycle owns visible blur, including its bounded microphone/Bluetooth handoff.
    document.addEventListener('visibilitychange', () => { if (document.hidden) interrupt(); }, { signal });
  }, { signal: binding.signal });
  input.addEventListener('touchstart', event => {
    if (pending && !input.value) event.preventDefault();
  }, { signal: binding.signal, passive: false });
  owner.addEventListener('click', event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, { capture: true, signal: binding.signal });
  input.addEventListener('contextmenu', event => { if (!input.value) event.preventDefault(); }, { signal: binding.signal });
  input.addEventListener('keydown', event => {
    if (!input.value && event.altKey && event.key === 'r' && !event.repeat) {
      event.preventDefault(); begin('locked');
    }
  }, { signal: binding.signal });
  return { cancel, destroy: () => { cancel(); binding.abort(); } };
}

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
  composer.addEventListener('pointerdown', () => {
    suppressPointerClick = false;
    // Restoring focus after a touch recording must not inherit a keyboard ring
    // from Safari's programmatic-focus heuristic. Keyboard input restores it.
    composer.dataset.voiceInput = 'pointer';
  }, { capture: true, signal: binding.signal });
  window.addEventListener('keydown', () => { delete composer.dataset.voiceInput; }, { capture: true, signal: binding.signal });
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
      const inflatedOrigin = button.getBoundingClientRect();
      activeRecorder = begin('hold');
      activeRecorder?.animateHoldFrom(inflatedOrigin);
      button.classList.remove('is-pressing');
    }, 180);

    window.addEventListener('pointermove', move => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (!held && Math.hypot(dx, dy) > 12) { cancel(); return; }
      activeRecorder?.moveHold(dx);
    }, { signal, passive: false });

    window.addEventListener('pointerup', up => {
      if (up.pointerId !== pointerId) return;
      up.preventDefault();
      const recorder = activeRecorder;
      // Use release coordinates too; a browser may coalesce the final move.
      recorder?.moveHold(up.clientX - startX);
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
    // The application-level lifecycle owns window blur. In particular, its
    // bounded microphone-permission handoff must survive the focus transfer
    // caused by iOS switching to a Bluetooth hands-free route. Cancelling here
    // used to stop the new audio track during that transfer, which made car
    // systems repeatedly connect and drop their call profile. Unowned blur,
    // hidden, pagehide and freeze still close the recorder through app teardown.
  }, { signal: binding.signal });
  button.addEventListener('click', event => {
    event.preventDefault();
    // Keyboard and assistive activation have no preceding pointer gesture.
    if (event.detail === 0 && !gesture && !button.disabled) {
      delete composer.dataset.voiceInput;
      begin('locked');
    }
  }, { signal: binding.signal });
  button.addEventListener('contextmenu', event => event.preventDefault(), { signal: binding.signal });

  return { cancel, destroy: () => { cancel(); binding.abort(); delete composer.dataset.voiceInput; } };
}
