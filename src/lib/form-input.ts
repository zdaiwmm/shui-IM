import { mountDialog } from './dialog';

type Field = HTMLInputElement | HTMLTextAreaElement;
type Geometry = Pick<VisualViewport, 'height' | 'width' | 'offsetTop' | 'offsetLeft' | 'pageTop' | 'pageLeft' | 'scale'>;
let held: Geometry | null = null;
let proxy: VisualViewport | null = null;
let source: VisualViewport | null = null;
let cancelCurrent: (() => void) | null = null;
let releasePending: (() => void) | null = null;

/** Background layout owners see a stable viewport while a form draft is edited. */
export function layoutViewport(): VisualViewport | null {
  const view = window.visualViewport;
  if (!view) return null;
  if (source !== view) {
    source = view;
    proxy = new Proxy(view, { get(target, key) {
      if (held && Object.hasOwn(held, key)) return held[key as keyof Geometry];
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  return proxy;
}

export function cancelFormInput(): void { cancelCurrent?.(); releasePending?.(); }

export function mobileFormInput(): boolean {
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches && innerWidth < 1024;
}

function fieldAt(target: EventTarget | null): Field | null {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return null;
  if (target.disabled || target.readOnly || target.closest('.form-input-overlay, [data-native-input], .message-text-selection')
    || target.id === 'message-input' || target.closest('[inert], [hidden], .is-closing')) return null;
  if (target instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(target.type)) return null;
  return target;
}

function titleFor(field: Field): string {
  const labelled = (field.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return field.getAttribute('aria-label') || labelled || field.labels?.[0]?.textContent?.trim() || field.placeholder || '输入内容';
}

/** One ephemeral draft; never submit the owning form or persist editor contents. */
export function mountFormInputs(root: HTMLElement): () => void {
  const lifetime = new AbortController();
  const open = (original: Field) => {
    if (!mobileFormInput() || !root.contains(original) || document.hidden || document.documentElement.classList.contains('privacy-obscured')) return;
    const previousGeometry = held;
    const rootHeight = root.getBoundingClientRect().height;
    cancelFormInput();
    const events = new AbortController();
    const view = window.visualViewport;
    if (view) held = previousGeometry ?? { height: view.height, width: view.width, offsetTop: view.offsetTop, offsetLeft: view.offsetLeft,
      pageTop: view.pageTop, pageLeft: view.pageLeft, scale: view.scale };
    const closedHeight = held?.height ?? innerHeight;
    const previousHeight = root.style.getPropertyValue('height'), priority = root.style.getPropertyPriority('height');
    root.style.setProperty('height', `${rootHeight}px`, 'important');
    const overlay = document.createElement('div'); overlay.className = 'form-input-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'form-input-title');
    overlay.innerHTML = '<form class="form-input-panel" novalidate><h2 id="form-input-title"></h2><div class="form-input-field"></div><footer><button type="button" data-form-input-cancel>取消</button><button type="button" data-form-input-done>完成</button></footer></form>';
    overlay.querySelector('h2')!.textContent = titleFor(original);
    const editor = document.createElement(original instanceof HTMLTextAreaElement ? 'textarea' : 'input') as Field;
    for (const attribute of ['type', 'inputmode', 'autocomplete', 'autocapitalize', 'autocorrect', 'spellcheck', 'maxlength', 'minlength', 'min', 'max', 'step', 'pattern', 'placeholder', 'dir']) {
      const value = original.getAttribute(attribute); if (value !== null) editor.setAttribute(attribute, value);
    }
    editor.id = 'form-input-draft'; editor.setAttribute('aria-labelledby', 'form-input-title');
    editor.enterKeyHint = original instanceof HTMLTextAreaElement ? 'enter' : 'done';
    let initialValue = original.value;
    original.dataset.formInputActive = 'true';
    editor.value = initialValue;
    let selection: [number | null, number | null] = [null, null];
    try { selection = [original.selectionStart, original.selectionEnd]; } catch { /* Numeric fields have no selection API. */ }
    overlay.querySelector('.form-input-field')!.append(editor);
    root.append(overlay);
    let finished = false, composing = false, pointerAction = false;
    const release = () => {
      releasePending = null; held = null;
      root.style.setProperty('height', previousHeight, priority);
      view?.dispatchEvent(new Event('resize'));
    };
    const releaseWhenClosed = () => {
      const cleanup = new AbortController();
      const done = () => { clearTimeout(timer); cleanup.abort(); release(); };
      const timer = setTimeout(done, 650);
      releasePending = done;
      const check = () => { if (!view || view.height >= closedHeight - 64) done(); };
      view?.addEventListener('resize', check, { signal: cleanup.signal });
      check();
    };
    const active = () => original.isConnected && root.contains(original) && !original.disabled && !original.readOnly
      && !document.hidden && root.getAttribute('aria-hidden') !== 'true'
      && !document.documentElement.classList.contains('privacy-obscured') && !original.closest('[hidden], .is-closing');
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const apply = commit && active() && original.value === initialValue;
      let value = apply ? editor.value : '';
      initialValue = '';
      cancelCurrent = null;
      delete original.dataset.formInputActive;
      editor.blur(); editor.value = ''; editor.removeAttribute('value');
      observer.disconnect(); events.abort(); dialog.close({ animate: false, restoreFocus: false });
      releaseWhenClosed();
      if (apply) {
        original.value = value; value = '';
        original.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
        original.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    const dialog = mountDialog(overlay, { isActive: active, initialFocus: editor, onClose: () => finish(false) });
    cancelCurrent = () => finish(false);
    const observer = new MutationObserver(() => { if (!active()) finish(false); });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'readonly', 'aria-hidden', 'class'] });
    const fit = () => {
      overlay.style.top = `${view?.offsetTop ?? 0}px`;
      overlay.style.height = `${view?.height ?? innerHeight}px`;
      overlay.style.left = `${view?.offsetLeft ?? 0}px`;
      overlay.style.width = `${view?.width ?? innerWidth}px`;
    };
    fit(); view?.addEventListener('resize', fit, { signal: events.signal }); view?.addEventListener('scroll', fit, { signal: events.signal });
    window.addEventListener('resize', fit, { signal: events.signal });
    // IME confirmation can emit an implicit form submit with isComposing=false.
    // Only the explicit Done action or a non-composing editor key completes.
    overlay.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); }, { signal: events.signal });
    overlay.querySelector('[data-form-input-done]')!.addEventListener('click', () => { if (!composing) finish(true); }, { signal: events.signal });
    overlay.querySelector('[data-form-input-cancel]')!.addEventListener('click', () => finish(false), { signal: events.signal });
    overlay.addEventListener('pointerdown', event => {
      if (event.target === editor) return;
      pointerAction = true; setTimeout(() => { pointerAction = false; }, 0);
    }, { capture: true, signal: events.signal });
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); }, { signal: events.signal });
    editor.addEventListener('compositionstart', () => { composing = true; }, { signal: events.signal });
    editor.addEventListener('compositionend', () => { composing = false; }, { signal: events.signal });
    editor.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      if (key.key === 'Enter' && original instanceof HTMLInputElement && !key.isComposing && key.keyCode !== 229 && !composing) { event.preventDefault(); finish(true); }
    }, { signal: events.signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelFormInput(); }, { capture: true, signal: events.signal });
    window.addEventListener('pagehide', cancelFormInput, { capture: true, signal: events.signal });
    // Losing focus to the keyboard's native Done commits without refocusing the source.
    editor.addEventListener('blur', event => queueMicrotask(() => {
      if (!finished && !pointerAction && !overlay.contains(document.activeElement)) finish(!(event as FocusEvent).relatedTarget && document.hasFocus() && active());
    }), { signal: events.signal });
    editor.focus({ preventScroll: true });
    try { if (selection[0] !== null) editor.setSelectionRange(selection[0], selection[1]); } catch { /* Native numeric editor. */ }
  };
  root.addEventListener('pointerdown', event => {
    const field = fieldAt(event.target);
    if (!field || !mobileFormInput()) return;
    event.preventDefault(); open(field);
  }, { capture: true, passive: false, signal: lifetime.signal });
  root.addEventListener('focusin', event => {
    const field = fieldAt(event.target); if (field) open(field);
  }, { capture: true, signal: lifetime.signal });
  return () => { cancelFormInput(); lifetime.abort(); };
}
