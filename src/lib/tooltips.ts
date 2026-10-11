import '../tooltips.css';

/** Delegated presentation only. Touch keeps the control's accessible name. */
export function bindTooltips(root: HTMLElement): () => void {
  const id = `${root.id || 'quiet-room'}-tooltip`;
  let origin: HTMLElement | null = null, tip: HTMLElement | null = null, timer: number | undefined;
  let touchUntil = 0;
  const hide = () => {
    window.clearTimeout(timer); timer = undefined;
    if (origin) {
      const ids = (origin.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(value => value && value !== id);
      if (ids.length) origin.setAttribute('aria-describedby', ids.join(' ')); else origin.removeAttribute('aria-describedby');
    }
    tip?.remove(); tip = null; origin = null;
  };
  const schedule = (target: EventTarget | null) => {
    const control = target instanceof Element ? target.closest<HTMLElement>('[data-tooltip], [title], .icon-button[aria-label]') : null;
    if (!control || !root.contains(control) || control.closest('[inert], [hidden], [aria-hidden="true"]')) return;
    if (control === origin) return;
    hide(); origin = control;
    // Convert on entry so a native tooltip cannot compete with the themed one.
    if (control.title) { control.dataset.tooltip = control.title; control.removeAttribute('title'); }
    timer = window.setTimeout(() => {
      if (!control.isConnected || document.hidden || root.hasAttribute('aria-hidden')) { hide(); return; }
      const label = control.dataset.tooltip || control.getAttribute('aria-label');
      if (!label) { hide(); return; }
      tip = document.createElement('div'); tip.id = id; tip.className = 'control-tooltip'; tip.setAttribute('role', 'tooltip'); tip.textContent = label;
      root.append(tip);
      control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
      const box = control.getBoundingClientRect(), bounds = tip.getBoundingClientRect();
      const viewport = window.visualViewport, left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      tip.style.left = `${Math.max(left + 8, Math.min(box.left + (box.width - bounds.width) / 2, left + width - bounds.width - 8))}px`;
      const above = box.top - bounds.height - 8;
      tip.style.top = `${Math.max(top + 8, Math.min(above >= top + 8 ? above : box.bottom + 8, top + height - bounds.height - 8))}px`;
    }, 400);
  };
  root.addEventListener('pointerover', event => { if (event.pointerType === 'mouse' && matchMedia('(any-hover: hover)').matches) schedule(event.target); });
  root.addEventListener('pointerout', event => { if (origin && !(event.relatedTarget instanceof Node && origin.contains(event.relatedTarget))) hide(); });
  root.addEventListener('focusin', event => { if (performance.now() >= touchUntil) schedule(event.target); });
  root.addEventListener('focusout', hide);
  root.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') touchUntil = performance.now() + 1000; hide(); });
  root.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  root.addEventListener('click', hide);
  root.addEventListener('tooltipdismiss', hide);
  root.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  document.addEventListener('visibilitychange', hide);
  return hide;
}
