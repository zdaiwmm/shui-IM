import { dismissDraggedPanel, settleValue } from './motion';

/** A handle is also a named 44px close button for keyboard and assistive input. */
export function bindHalfSheetHandle(handle: HTMLButtonElement, panel: HTMLElement, signal: AbortSignal, close: () => void) {
  let drag: { id: number; y: number; lastY: number; at: number; velocity: number } | null = null;
  let offset = 0, dragged = false;
  let cancel: (() => void) | undefined;
  const paint = (value: number) => { offset = value; panel.style.setProperty('--sheet-drag', `${value}px`); };
  handle.addEventListener('click', () => { if (dragged) { dragged = false; return; } close(); }, { signal });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    cancel?.(); dragged = false;
    offset = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
    drag = { id: event.pointerId, y: event.clientY - offset, lastY: event.clientY, at: performance.now(), velocity: 0 };
    panel.classList.add('is-dragging'); paint(offset); handle.setPointerCapture(event.pointerId);
  }, { signal });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const now = performance.now(), elapsed = now - drag.at;
    if (elapsed > 0) drag.velocity = Math.max(-2000, Math.min(2000, (event.clientY - drag.lastY) * 1000 / elapsed));
    drag.lastY = event.clientY; drag.at = now;
    const distance = Math.max(0, event.clientY - drag.y), limit = Math.max(1, panel.clientHeight);
    if (distance > 6) dragged = true;
    paint(limit * Math.tanh(distance / limit));
  }, { signal });
  const release = (event: PointerEvent, canceled: boolean) => {
    if (!drag || drag.id !== event.pointerId) return;
    const velocity = performance.now() - drag.at < 100 ? drag.velocity : 0;
    drag = null;
    if (!canceled && dismissDraggedPanel(offset, velocity, panel.clientHeight)) { panel.classList.remove('is-dragging'); close(); }
    else cancel = settleValue(offset, canceled ? 0 : velocity, paint, () => panel.classList.remove('is-dragging'), () => panel.isConnected && !signal.aborted);
  };
  handle.addEventListener('pointerup', event => release(event, false), { signal });
  handle.addEventListener('pointercancel', event => release(event, true), { signal });
  handle.addEventListener('lostpointercapture', event => release(event, true), { signal });
  signal.addEventListener('abort', () => { cancel?.(); drag = null; }, { once: true });
}
