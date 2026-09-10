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

export function closeDialog(sheet: HTMLElement, options?: CloseOptions): boolean {
  const close = dialogClosers.get(sheet);
  if (!close) return false;
  close(options);
  return true;
}

export function mountDialog(sheet: HTMLElement, options: DialogOptions) {
  const focusAtMount = document.activeElement;
  let closed = false;
  let finished = false;
  let timer: number | undefined;
  let detachObserver: MutationObserver | null = null;
  const parent = sheet.parentElement;
  const origin = options.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
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
    detachObserver?.disconnect();
    detachObserver = null;
    dialogClosers.delete(sheet);
    if (timer !== undefined) window.clearTimeout(timer);
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
    sheet.classList.remove('is-visible');
    sheet.classList.add('is-closing');
    options.onClose?.();
    if (!animate || !options.isActive() || !sheet.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish(restoreFocus);
    } else {
      timer = window.setTimeout(() => finish(restoreFocus), 320);
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
      } else if ((event.shiftKey && index <= 0) || (!event.shiftKey && (index === controls.length - 1 || index === -1))) {
        event.preventDefault();
        controls[event.shiftKey ? controls.length - 1 : 0]?.focus({ preventScroll: true });
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
    // An early click/fill can focus an input before this deferred frame runs.
    // Preserve that interaction: stealing focus can turn Enter into Back/Close.
    if (document.activeElement !== focusAtMount && sheet.contains(document.activeElement)) return;
    (options.initialFocus ?? focusables()[0] ?? sheet).focus({ preventScroll: true });
  });
  return { close, dispose: () => close({ animate: false, restoreFocus: false }) };
}
