type Point = { x: number; y: number };

/** Image-only gestures; video gestures remain owned by the native player. */
export function bindImageViewerGestures(options: {
  stage: HTMLElement;
  viewer: HTMLElement;
  itemCount: number;
  dismiss: (downward: boolean) => void;
  page: (direction: number) => void;
}): { reset: () => void; destroy: () => void } {
  const { stage, viewer } = options;
  const events = new AbortController();
  const pointers = new Map<number, Point>();
  let scale = 1;
  let pan: Point = { x: 0, y: 0 };
  let drag: { id: number; origin: Point; pan: Point; startedAt: number; axis: 'x' | 'y' | null } | null = null;
  let pinch: { distance: number; center: Point; scale: number; pan: Point } | null = null;
  let pinched = false;
  const image = () => stage.querySelector('img');
  const apply = () => {
    const target = image();
    if (!target) return;
    const fit = Math.min(target.clientWidth / (target.naturalWidth || 1), target.clientHeight / (target.naturalHeight || 1));
    const maxX = Math.max(0, (target.naturalWidth * fit * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (target.naturalHeight * fit * scale - stage.clientHeight) / 2);
    pan.x = Math.max(-maxX, Math.min(maxX, pan.x));
    pan.y = Math.max(-maxY, Math.min(maxY, pan.y));
    target.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`;
    stage.dataset.zoomed = String(scale > 1.01);
  };
  const stopDrag = () => {
    drag = null;
    viewer.classList.remove('is-dragging');
    viewer.style.removeProperty('--viewer-backdrop-opacity');
  };
  const reset = () => {
    stopDrag();
    pointers.clear();
    pinch = null;
    pinched = false;
    scale = 1;
    pan = { x: 0, y: 0 };
    apply();
  };
  const pair = () => {
    const [first, second] = [...pointers.values()];
    if (!first || !second) return null;
    return {
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    };
  };
  const zoom = (next: number, center: Point, startScale = scale, startPan = pan, startCenter = center) => {
    const bounds = stage.getBoundingClientRect();
    const origin = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    scale = Math.max(1, Math.min(5, next));
    const ratio = scale / startScale;
    pan = {
      x: center.x - origin.x - (startCenter.x - origin.x - startPan.x) * ratio,
      y: center.y - origin.y - (startCenter.y - origin.y - startPan.y) * ratio,
    };
    apply();
  };
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !image() || viewer.classList.contains('is-closing')) return;
    if (event.target instanceof Element && event.target.closest('button, video')) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = pair();
    if (current) {
      stopDrag();
      pinch = { ...current, scale, pan: { ...pan } };
      pinched = true;
    } else if (!pinched) {
      drag = { id: event.pointerId, origin: { x: event.clientX, y: event.clientY }, pan: { ...pan }, startedAt: performance.now(), axis: null };
    }
    try { stage.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers have no capture target. */ }
  }, { signal: events.signal });
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch) {
      const current = pair();
      if (!current) return;
      event.preventDefault();
      zoom(pinch.scale * current.distance / pinch.distance, current.center, pinch.scale, pinch.pan, pinch.center);
      return;
    }
    if (!drag || drag.id !== event.pointerId) return;
    const x = event.clientX - drag.origin.x;
    const y = event.clientY - drag.origin.y;
    if (scale > 1.01 || pinched) {
      event.preventDefault();
      pan = { x: drag.pan.x + x, y: drag.pan.y + y };
      apply();
      return;
    }
    if (!drag.axis && Math.hypot(x, y) > 8) drag.axis = Math.abs(y) > Math.abs(x) ? 'y' : 'x';
    if (!drag.axis) return;
    event.preventDefault();
    const target = image();
    if (!target) return;
    viewer.classList.add('is-dragging');
    if (drag.axis === 'y') {
      target.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      viewer.style.setProperty('--viewer-backdrop-opacity', String(1 - Math.min(Math.abs(y) / Math.max(stage.clientHeight, 1), 0.8)));
    } else if (options.itemCount > 1) target.style.transform = `translate3d(${x}px, 0, 0)`;
  }, { signal: events.signal });
  const end = (event: PointerEvent, cancelled: boolean) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (pinched) {
      pinch = null;
      stopDrag();
      apply();
      const remaining = [...pointers.entries()][0];
      if (remaining) {
        drag = { id: remaining[0], origin: { ...remaining[1] }, pan: { ...pan }, startedAt: performance.now(), axis: null };
      } else pinched = false;
      return;
    }
    const ended = drag;
    stopDrag();
    if (!ended || ended.id !== event.pointerId || cancelled || scale > 1.01) { apply(); return; }
    const x = event.clientX - ended.origin.x;
    const y = event.clientY - ended.origin.y;
    const elapsed = Math.max(performance.now() - ended.startedAt, 1);
    const axis = ended.axis ?? (Math.hypot(x, y) > 8 ? (Math.abs(y) > Math.abs(x) ? 'y' : 'x') : null);
    if (axis === 'y' && (Math.abs(y) >= 60 || (Math.abs(y) > 24 && Math.abs(y) / elapsed > 0.45))) options.dismiss(y > 0);
    else if (axis === 'x' && Math.abs(x) >= 44 && options.itemCount > 1) options.page(x < 0 ? 1 : -1);
    else apply();
  };
  stage.addEventListener('pointerup', event => end(event, false), { signal: events.signal });
  stage.addEventListener('pointercancel', event => end(event, true), { signal: events.signal });
  stage.addEventListener('lostpointercapture', event => end(event, true), { signal: events.signal });
  stage.addEventListener('wheel', event => {
    if ((!event.ctrlKey && !event.metaKey) || !image()) return;
    event.preventDefault();
    zoom(scale * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY });
  }, { passive: false, signal: events.signal });
  stage.addEventListener('dblclick', event => {
    if (!image()) return;
    event.preventDefault();
    zoom(scale > 1.01 ? 1 : 2.5, { x: event.clientX, y: event.clientY });
  }, { signal: events.signal });
  return { reset, destroy: () => { events.abort(); pointers.clear(); } };
}
