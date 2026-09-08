export function attachDocumentPaging(stage: HTMLElement, canPage: () => boolean, go: (direction: number) => void, signal: AbortSignal): void {
  let gesture: { id: number; x: number; y: number; time: number } | undefined;
  const pointers = new Set<number>();
  stage.addEventListener('pointerdown', event => {
    pointers.add(event.pointerId);
    if (pointers.size !== 1 || event.pointerType === 'mouse' || !canPage()
      || (event.target as Element).closest('a, button, input, select') || !window.getSelection()?.isCollapsed) {
      gesture = undefined; return;
    }
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
  }, { signal });
  stage.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = Math.abs(event.clientX - gesture.x), dy = Math.abs(event.clientY - gesture.y);
    if (dy > 12 && dy > dx) gesture = undefined;
    else if (dx > 12 && dx > dy * 1.5) event.preventDefault();
  }, { signal, passive: false });
  const finish = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    const start = gesture; gesture = undefined;
    if (!start || start.id !== event.pointerId || event.type !== 'pointerup' || !canPage()) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (performance.now() - start.time < 800 && Math.abs(dx) >= Math.max(44, Math.min(80, stage.clientWidth * .18))
      && Math.abs(dx) > Math.abs(dy) * 1.5 && window.getSelection()?.isCollapsed) go(dx < 0 ? 1 : -1);
  };
  window.addEventListener('pointerup', finish, { signal });
  window.addEventListener('pointercancel', finish, { signal });
  signal.addEventListener('abort', () => { gesture = undefined; pointers.clear(); }, { once: true });
}
