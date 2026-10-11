export type AvatarCrop = { zoom: number; x: number; y: number };
export const neutralCrop = (): AvatarCrop => ({ zoom: 1, x: 0, y: 0 });
const clamp = (value: number, bound: number) => Math.max(-bound, Math.min(bound, value)) || 0;
export function boundAvatarCrop(crop: AvatarCrop, ratio: number): AvatarCrop {
  const zoom = Math.max(1, Math.min(3, crop.zoom));
  return { zoom, x: clamp(crop.x, (Math.max(1, ratio) * zoom - 1) / 2), y: clamp(crop.y, (Math.max(1, 1 / ratio) * zoom - 1) / 2) };
}
export function zoomAvatarCrop(crop: AvatarCrop, zoom: number, ratio: number, from = { x: 0, y: 0 }, to = from): AvatarCrop {
  const next = Math.max(1, Math.min(3, zoom));
  return boundAvatarCrop({ zoom: next, x: to.x - (from.x - crop.x) * next / crop.zoom, y: to.y - (from.y - crop.y) * next / crop.zoom }, ratio);
}
/** Pointer ownership stays on the crop stage, never on page scrolling. */
export function bindAvatarCrop(stage: HTMLElement, ratio: number, signal: AbortSignal, changed: (crop: AvatarCrop) => void) {
  let crop = neutralCrop();
  const contacts = new Map<number, { x: number; y: number }>();
  let origin: { crop: AvatarCrop; center: { x: number; y: number }; distance: number } | null = null;
  const point = (event: PointerEvent) => {
    const rect = stage.getBoundingClientRect();
    return { x: (event.clientX - rect.left - rect.width / 2) / rect.width, y: (event.clientY - rect.top - rect.height / 2) / rect.height };
  };
  const geometry = () => {
    const [a, b] = [...contacts.values()];
    return a ? { center: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a, distance: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 } : null;
  };
  const baseline = () => { const current = geometry(); origin = current ? { ...current, crop: { ...crop } } : null; };
  const update = (value: AvatarCrop) => { if (signal.aborted) return; crop = boundAvatarCrop(value, ratio); changed(crop); };
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || contacts.size >= 2) return;
    event.preventDefault(); contacts.set(event.pointerId, point(event));
    stage.setPointerCapture(event.pointerId); baseline();
  }, { signal });
  stage.addEventListener('pointermove', event => {
    if (!origin || !contacts.has(event.pointerId)) return;
    event.preventDefault(); contacts.set(event.pointerId, point(event));
    const now = geometry()!;
    if (contacts.size === 2 && origin.distance > .005) update(zoomAvatarCrop(origin.crop, origin.crop.zoom * now.distance / origin.distance, ratio, origin.center, now.center));
    else update({ ...origin.crop, x: origin.crop.x + now.center.x - origin.center.x, y: origin.crop.y + now.center.y - origin.center.y });
  }, { signal });
  const end = (event: PointerEvent) => { contacts.delete(event.pointerId); baseline(); };
  stage.addEventListener('pointerup', end, { signal });
  stage.addEventListener('pointercancel', end, { signal });
  stage.addEventListener('lostpointercapture', end, { signal });
  stage.addEventListener('wheel', event => { event.preventDefault(); update(zoomAvatarCrop(crop, crop.zoom * Math.exp(-event.deltaY * .005), ratio)); }, { signal, passive: false });
  stage.addEventListener('keydown', event => {
    const actions: Record<string, () => AvatarCrop> = {
      ArrowLeft: () => ({ ...crop, x: crop.x - .025 }), ArrowRight: () => ({ ...crop, x: crop.x + .025 }),
      ArrowUp: () => ({ ...crop, y: crop.y - .025 }), ArrowDown: () => ({ ...crop, y: crop.y + .025 }),
      '+': () => zoomAvatarCrop(crop, crop.zoom + .1, ratio), '=': () => zoomAvatarCrop(crop, crop.zoom + .1, ratio),
      '-': () => zoomAvatarCrop(crop, crop.zoom - .1, ratio), '0': neutralCrop,
    };
    if (actions[event.key]) { event.preventDefault(); update(actions[event.key]!()); }
  }, { signal });
  stage.addEventListener('dblclick', event => { event.preventDefault(); update(crop.zoom > 1 ? neutralCrop() : zoomAvatarCrop(crop, 2, ratio)); }, { signal });
  signal.addEventListener('abort', () => { contacts.clear(); origin = null; }, { once: true });
  return { value: () => ({ ...crop }), reset: () => update(neutralCrop()), zoom: (delta: number) => update(zoomAvatarCrop(crop, crop.zoom + delta, ratio)) };
}
