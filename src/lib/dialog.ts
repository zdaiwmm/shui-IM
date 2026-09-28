import { afterMotion, motion, retargetMotion } from './motion';

type DialogOptions = {
  isActive: () => boolean;
  signal?: AbortSignal;
  returnFocus?: HTMLElement | null;
  initialFocus?: HTMLElement | null;
  beforeClose?: () => boolean;
  onClose?: () => void;
};

type CloseOptions = { animate?: boolean; restoreFocus?: boolean };

// Multiple transient dialogs can overlap while one is leaving. Only the last
// owner releases a background surface, preserving any pre-existing inert state.
const inertOwners = new WeakMap<HTMLElement, { count: number; wasInert: boolean }>();
const dialogClosers = new WeakMap<HTMLElement, (options?: CloseOptions) => void>();
const dialogOrigins = new WeakMap<HTMLElement, HTMLElement | null>();

export function closeDialog(sheet: HTMLElement, options?: CloseOptions): boolean {
  const close = dialogClosers.get(sheet);
  if (!close) return false;
  close(options);
  return true;
}

export function mountDialog(sheet: HTMLElement, options: DialogOptions) {
  // Reopening a retiring shared surface transfers only presentation values,
  // never old content, callbacks or focus ownership.
  const kind = sheet.classList[0];
  const retiring = kind ? [...(sheet.parentElement?.children ?? [])].find((node): node is HTMLElement =>
    node instanceof HTMLElement && node !== sheet && node.classList.contains(kind) && node.classList.contains('is-closing')) : undefined;
  const retiringChild = retiring?.firstElementChild;
  const retiringOrigin = retiring ? dialogOrigins.get(retiring) : undefined;
  const fromOpacity = retiring ? getComputedStyle(retiring).opacity : undefined;
  const fromTransform = retiringChild instanceof HTMLElement ? getComputedStyle(retiringChild).transform : undefined;
  if (retiring) closeDialog(retiring, { animate: false, restoreFocus: false });
  const arrival: Animation[] = [];
  const focusAtMount = document.activeElement;
  let closed = false;
  let finished = false;
  let cancelFinish: (() => void) | undefined;
  let detachObserver: MutationObserver | null = null;
  const parent = sheet.parentElement;
  const origin = options.returnFocus ?? retiringOrigin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  dialogOrigins.set(sheet, origin);
  const backgrounds = [...(sheet.parentElement?.children ?? [])]
    .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== sheet);
  const releaseBackgrounds = () => {
    for (const node of backgrounds) {
      const owner = inertOwners.get(node);
      if (!owner) continue;
      if (--owner.count === 0) {
        node.inert = owner.wasInert;
        inertOwners.delete(node);
      }
    }
  };
  for (const node of backgrounds) {
    const owner = inertOwners.get(node) ?? { count: 0, wasInert: node.inert };
    owner.count++;
    inertOwners.set(node, owner);
    node.inert = true;
  }
  sheet.classList.add('dialog-surface');
  sheet.setAttribute('tabindex', '-1');
  const focusables = () => [...sheet.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]')]
    .filter((node) => !node.matches(':disabled,[hidden],[tabindex="-1"]') && node.getClientRects().length > 0 && !node.inert);
  const finish = (restoreFocus: boolean) => {
    if (finished) return;
    finished = true;
    arrival.forEach(animation => animation.cancel());
    detachObserver?.disconnect();
    detachObserver = null;
    dialogClosers.delete(sheet);
    dialogOrigins.delete(sheet);
    cancelFinish?.();
    options.signal?.removeEventListener('abort', onAbort);
    sheet.removeEventListener('keydown', onKeyDown);
    sheet.remove();
    releaseBackgrounds();
    if (restoreFocus && options.isActive() && origin?.isConnected && !origin.inert) origin.focus({ preventScroll: true });
  };
  const close = ({ animate = true, restoreFocus = true }: CloseOptions = {}) => {
    if (closed) {
      if (!animate) finish(false);
      return;
    }
    if (animate && options.beforeClose && !options.beforeClose()) return;
    closed = true;
    sheet.inert = true;
    const painted = arrival.flatMap(animation => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (!(target instanceof HTMLElement) || animation.playState === 'finished') return [];
      const property = target === sheet ? 'opacity' : 'transform';
      return [{ target, property, value: getComputedStyle(target).getPropertyValue(property) }];
    });
    for (const item of painted) item.target.style.setProperty(item.property, item.value);
    arrival.forEach(animation => animation.cancel());
    arrival.length = 0;
    if (painted.length) void sheet.offsetHeight;
    sheet.classList.remove('is-visible');
    sheet.classList.add('is-closing');
    for (const item of painted) item.target.style.removeProperty(item.property);
    options.onClose?.();
    if (!animate || !options.isActive() || !sheet.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish(restoreFocus);
    } else {
      cancelFinish = afterMotion(sheet, () => finish(restoreFocus));
    }
  };
  const onAbort = () => close({ animate: false, restoreFocus: false });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const controls = focusables();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (controls.length === 0) {
        event.preventDefault();
        sheet.focus({ preventScroll: true });
      } else {
        // Safari may omit buttons from its native Tab order. Own every step,
        // not only the wrap, so focus cannot leave a modal from an inner button.
        event.preventDefault();
        const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus({ preventScroll: true });
      }
    }
  };
  sheet.addEventListener('keydown', onKeyDown);
  dialogClosers.set(sheet, close);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (parent) {
    // Route renders can remove a dialog without calling its close handle.
    // Only watch direct children: message rendering inside the background
    // must not wake an observer for every mutation in a long conversation.
    detachObserver = new MutationObserver(() => {
      if (sheet.parentElement !== parent || !sheet.isConnected) close({ animate: false, restoreFocus: false });
    });
    detachObserver.observe(parent, { childList: true });
  }
  if (!options.isActive() || options.signal?.aborted) onAbort();
  else requestAnimationFrame(() => {
    if (closed || !sheet.isConnected || !options.isActive()) return;
    sheet.classList.add('is-visible');
    if (fromOpacity !== undefined) {
      const fade = retargetMotion(sheet, null, { opacity: fromOpacity }, { opacity: 1 }, motion.panel);
      if (fade) arrival.push(fade);
      if (fromTransform && sheet.firstElementChild instanceof HTMLElement) {
        const child = sheet.firstElementChild;
        // is-visible may have just started a CSS transition. Its painted
        // transform is not the destination; let this WAAPI effect own the
        // property and read the visible rule after cancelling that transition.
        for (const animation of child.getAnimations()) {
          if (animation instanceof CSSTransition && animation.transitionProperty === 'transform') animation.cancel();
        }
        const slide = retargetMotion(child, null, { transform: fromTransform },
          { transform: getComputedStyle(child).transform }, motion.panel, motion.settle);
        if (slide) arrival.push(slide);
      }
    }
    // An early click/fill can focus an input before this deferred frame runs.
    // Preserve that interaction: stealing focus can turn Enter into Back/Close.
    if (document.activeElement !== focusAtMount && sheet.contains(document.activeElement)) return;
    (options.initialFocus ?? focusables()[0] ?? sheet).focus({ preventScroll: true });
  });
  return { close, dispose: () => close({ animate: false, restoreFocus: false }) };
}
