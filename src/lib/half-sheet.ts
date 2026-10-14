import { dismissDraggedPanel, settleValue, travelMotion, motion } from './motion';

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

/** Settings has two stops; scrolling content never takes ownership of its handle. */
export function bindSettingsSheet(handle: HTMLButtonElement, panel: HTMLElement, signal: AbortSignal,
  close: () => void, expanded: boolean, changed: (expanded: boolean) => void) {
  let offset = 0, dragged = false, cancel: (() => void) | undefined;
  let drag: { id: number; y: number; offset: number; last: number; time: number; velocity: number } | null = null;
  const half = () => panel.parentElement!.clientHeight / 2;
  const paint = (value: number) => { offset = value; panel.style.setProperty('--settings-shift', `${value}px`); };
  const mark = () => {
    panel.dataset.detent = expanded ? 'full' : 'half';
    panel.style.setProperty('--settings-detent', `${expanded ? 0 : half()}px`);
    handle.setAttribute('aria-expanded', String(expanded));
    handle.setAttribute('aria-label', expanded ? '收起设置到半屏' : '展开设置到全屏');
    changed(expanded);
  };
  const settle = (full: boolean, velocity = 0) => {
    expanded = full; mark();
    cancel?.(); const from = offset, to = expanded ? 0 : half();
    panel.classList.remove('is-dragging'); paint(to);
    const animation = travelMotion(panel, from, to, velocity, motion.panel, 1, 1, 'y');
    cancel = () => animation?.cancel();
  };
  mark(); paint(expanded ? 0 : half());
  handle.addEventListener('click', () => { if (dragged) { dragged = false; return; } settle(!expanded); }, { signal });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    offset = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
    cancel?.(); paint(offset); dragged = false;
    drag = { id:event.pointerId, y:event.clientY, offset, last:event.clientY, time:performance.now(), velocity:0 };
    panel.classList.add('is-dragging'); handle.setPointerCapture(event.pointerId);
  }, { signal });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const now = performance.now(), elapsed = now - drag.time;
    if (elapsed > 0) drag.velocity = Math.max(-2000, Math.min(2000, (event.clientY - drag.last) * 1000 / elapsed));
    drag.last = event.clientY; drag.time = now;
    const delta = event.clientY - drag.y; dragged ||= Math.abs(delta) > 6;
    paint(Math.max(0, Math.min(panel.clientHeight, drag.offset + delta)));
  }, { signal });
  const release = (event: PointerEvent, canceled = false) => {
    if (!drag || drag.id !== event.pointerId) return;
    const velocity = performance.now() - drag.time < 100 ? drag.velocity : 0;
    drag = null;
    if (canceled) { settle(expanded); return; }
    if (!expanded && (offset > half() + 64 || velocity > 650)) { panel.classList.remove('is-dragging'); close(); }
    else settle(velocity < -450 || velocity <= 450 && offset < half() / 2, velocity);
  };
  handle.addEventListener('pointerup', event => release(event), { signal });
  handle.addEventListener('pointercancel', event => release(event, true), { signal });
  handle.addEventListener('lostpointercapture', event => release(event, true), { signal });
  window.addEventListener('resize', () => { if (!drag) { mark(); paint(expanded ? 0 : half()); } }, { signal });
  signal.addEventListener('abort', () => { cancel?.(); drag = null; }, { once:true });
}
