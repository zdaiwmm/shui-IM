import { mountDialog } from './dialog';
import { createElement, Eye, EyeOff } from 'lucide';

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
  if (target.disabled || target.readOnly || target.closest('.form-input-overlay, [data-native-input], [data-form-input-commit], .message-text-selection')
    || target.id === 'message-input' || target.closest('[inert], [hidden], .is-closing')) return null;
  if (target instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(target.type)) return null;
  return target;
}

function titleFor(field: Field): string {
  const labelled = (field.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return field.getAttribute('aria-label') || labelled || field.labels?.[0]?.textContent?.trim() || field.placeholder || '输入内容';
}

/** One ephemeral draft. Only an explicitly marked verification code opts into Done submission. */
export function mountFormInputs(root: HTMLElement): () => void {
  const lifetime = new AbortController();
  const open = (initial: Field) => {
    let original = initial;
    if (!mobileFormInput() || !root.contains(original) || document.hidden || document.documentElement.classList.contains('privacy-obscured')) return;
    const previousGeometry = held;
    const rootHeight = root.getBoundingClientRect().height;
    cancelFormInput();
    const events = new AbortController();
    const view = window.visualViewport;
    if (view) held = previousGeometry ?? { height: view.height, width: view.width, offsetTop: view.offsetTop, offsetLeft: view.offsetLeft,
      pageTop: view.pageTop, pageLeft: view.pageLeft, scale: view.scale };
    const closedHeight = held?.height ?? innerHeight;
    const pageScroll = window.scrollY;
    root.classList.add('form-input-editing');
    root.style.setProperty('--form-input-layout-height', `${rootHeight}px`);
    const previousHeight = root.style.getPropertyValue('height'), priority = root.style.getPropertyPriority('height');
    root.style.setProperty('height', `${rootHeight}px`, 'important');
    const overlay = document.createElement('div'); overlay.className = 'form-input-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'form-input-title');
    overlay.innerHTML = '<form class="form-input-panel" novalidate><h2 id="form-input-title"></h2><div class="form-input-field"><button type="button" data-form-input-done>完成</button></div></form>';
    const title = overlay.querySelector('h2')!;
    title.textContent = titleFor(original);
    const editor = document.createElement(original instanceof HTMLTextAreaElement ? 'textarea' : 'input') as Field;
    for (const attribute of ['type', 'inputmode', 'autocomplete', 'autocapitalize', 'autocorrect', 'spellcheck', 'maxlength', 'minlength', 'min', 'max', 'step', 'pattern', 'placeholder', 'dir']) {
      const value = original.getAttribute(attribute); if (value !== null) editor.setAttribute(attribute, value);
    }
    editor.id = 'form-input-draft'; editor.setAttribute('aria-labelledby', 'form-input-title');
    let initialValue = original.value;
    const codeGroup = original.closest<HTMLElement>('[data-form-input-code]');
    const codeFields = codeGroup ? [...codeGroup.querySelectorAll<HTMLInputElement>('[data-code-digit]')] : [];
    const codeValues = codeFields.map(field => field.value);
    if (codeGroup) {
      title.textContent = '输入验证码';
      overlay.classList.add('form-input-code-overlay');
      editor.setAttribute('type', 'text'); editor.inputMode = 'numeric'; editor.maxLength = 4; editor.autocomplete = 'one-time-code';
      initialValue = codeValues.join('');
      const cells = document.createElement('div'); cells.className = 'form-input-code-cells'; cells.setAttribute('aria-hidden', 'true');
      for (let index = 0; index < 4; index++) { const cell = document.createElement('span'); cells.append(cell);
        cell.addEventListener('pointerdown', event => { event.preventDefault(); editor.focus({preventScroll:true}); editor.setSelectionRange(Math.min(index, editor.value.length), Math.min(index + 1, editor.value.length)); }); }
      overlay.querySelector('.form-input-field')!.prepend(cells);
    }
    const nextField = () => {
      const sequence = original.dataset.formInputSequence;
      if (!sequence || !original.form) return null;
      const fields = [...original.form.querySelectorAll<HTMLInputElement>('input[data-form-input-sequence]')].filter(field => field.dataset.formInputSequence === sequence);
      return fields[fields.indexOf(original as HTMLInputElement) + 1] ?? null;
    };
    const updateHint = () => { editor.enterKeyHint = original instanceof HTMLTextAreaElement ? 'enter' : nextField() ? 'next' : 'done'; };
    updateHint();
    original.dataset.formInputActive = 'true';
    editor.value = initialValue;
    let selection: [number | null, number | null] = [null, null];
    try { selection = codeGroup ? [Math.min(codeFields.indexOf(original as HTMLInputElement), initialValue.length), Math.min(codeFields.indexOf(original as HTMLInputElement)+1, initialValue.length)] : [original.selectionStart, original.selectionEnd]; } catch { /* Numeric fields have no selection API. */ }
    overlay.querySelector('.form-input-field')!.prepend(editor);
    overlay.style.height=`${view?.height??innerHeight}px`;overlay.classList.add('is-visible');
    root.append(overlay);
    let finished = false, composing = false, pointerAction = false, commitRequested = false;
    const release = () => {
      releasePending = null; held = null;
      root.style.setProperty('height', previousHeight, priority);
      root.classList.remove('form-input-editing'); root.style.removeProperty('--form-input-layout-height');
      if (original.isConnected && root.contains(original)) window.scrollTo(0, pageScroll);
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
    const commitDraft = (value: string) => {
      if (codeGroup) {
        codeGroup.dataset.formInputCommit = '';
        try { codeFields.forEach((field, index) => { field.value = value[index] ?? ''; field.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertReplacementText'})); field.dispatchEvent(new Event('change',{bubbles:true})); }); }
        finally { delete codeGroup.dataset.formInputCommit; }
      } else { original.value = value; original.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertReplacementText'})); original.dispatchEvent(new Event('change',{bubbles:true})); }
    };
    const unchanged = () => codeGroup ? codeFields.every((field,index)=>field.value===codeValues[index]) : original.value===initialValue;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const apply = commit && active() && unchanged();
      let value = apply ? editor.value : '';
      initialValue = '';
      cancelCurrent = null;
      delete original.dataset.formInputActive;
      editor.blur(); editor.value = ''; editor.removeAttribute('value');
      observer.disconnect(); events.abort(); dialog.close({ animate: false, restoreFocus: false });
      releaseWhenClosed();
      if (apply) {
        commitDraft(value); value = '';
        if(codeGroup?.hasAttribute('data-submit-on-code-done')&&active())original.form?.requestSubmit();
      }
    };
    const complete = () => {
      if (finished || !active() || !unchanged()) { finish(false); return; }
      const next = nextField();
      if (!next || editor.value.trim().split(/\s+/u).length === 12) { finish(true); return; }
      if (!editor.value.trim()) return;
      commitDraft(editor.value);
      if (!active() || !next.isConnected) { finish(false); return; }
      delete original.dataset.formInputActive; original = next; initialValue = next.value;
      original.dataset.formInputActive = 'true'; editor.value = initialValue;
      title.textContent = titleFor(original); updateHint(); commitRequested = false;
      editor.focus({preventScroll:true}); editor.select();
    };
    const dialog = mountDialog(overlay, { isActive: active, initialFocus: editor, onClose: () => finish(false) });
    cancelCurrent = () => finish(false);
    const observer = new MutationObserver(() => { if (!active()) finish(false); });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'readonly', 'aria-hidden', 'class'] });
    let frame:number|null=null;
    const fit=()=>{
      const values={top:`${view?.offsetTop??0}px`,height:`${view?.height??innerHeight}px`,left:`${view?.offsetLeft??0}px`,width:`${view?.width??innerWidth}px`};
      for(const [name,value]of Object.entries(values))if(overlay.style.getPropertyValue(name)!==value)overlay.style.setProperty(name,value);
      overlay.style.setProperty('--form-input-underlay-height',`${Math.max(0,Math.max(rootHeight,innerHeight,document.documentElement.clientHeight)-(view?.offsetTop??0)-(view?.height??innerHeight))}px`);
    };
    const schedule=()=>{if(frame===null)frame=requestAnimationFrame(()=>{frame=null;if(!events.signal.aborted)fit();});};
    events.signal.addEventListener('abort',()=>{if(frame!==null)cancelAnimationFrame(frame);},{once:true});
    fit();view?.addEventListener('resize',schedule,{signal:events.signal});view?.addEventListener('scroll',schedule,{signal:events.signal});window.addEventListener('resize',schedule,{signal:events.signal});
    if(original instanceof HTMLInputElement&&(original.type==='password'||original.closest('.archive-password-control'))){
      overlay.classList.add('form-input-password');
      const visible=(editor as HTMLInputElement).type==='text';
      const eye=document.createElement('button');eye.type='button';eye.className='form-input-password-toggle';eye.setAttribute('aria-label',visible?'隐藏密码':'显示密码');eye.setAttribute('aria-pressed',String(visible));eye.innerHTML=createElement(visible?EyeOff:Eye).outerHTML;
      overlay.querySelector('.form-input-field')!.append(eye);
      eye.addEventListener('pointerdown',event=>event.preventDefault(),{signal:events.signal});
      eye.addEventListener('click',()=>{const input=editor as HTMLInputElement,start=input.selectionStart,end=input.selectionEnd,show=input.type==='password';input.type=show?'text':'password';eye.setAttribute('aria-label',show?'隐藏密码':'显示密码');eye.setAttribute('aria-pressed',String(show));eye.innerHTML=createElement(show?EyeOff:Eye).outerHTML;input.focus({preventScroll:true});if(start!==null)input.setSelectionRange(start,end);},{signal:events.signal});
    }
    // IME confirmation can emit an implicit form submit with isComposing=false.
    // Only the explicit Done action or a non-composing editor key completes.
    overlay.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); }, { signal: events.signal });
    overlay.querySelector('[data-form-input-done]')!.addEventListener('click', () => {
      // The trusted Done action must finalize the IME before reading its value.
      // Safari can deliver compositionend/input after the button's activation.
      commitRequested = true;
      // Keep the same focused editor across mnemonic words. BIP39 uses ASCII,
      // but an active IME must finish its composition before advancing.
      if (!composing) complete();
      else editor.blur();
    }, { signal: events.signal });
    overlay.addEventListener('pointerdown', event => {
      if (event.target === editor) return;
      if (event.target instanceof Element && event.target.closest('[data-form-input-done]') && nextField() && !composing) event.preventDefault();
      // Keep ownership through delayed touch focus/blur and the eventual click.
      pointerAction = true;
    }, { capture: true, signal: events.signal });
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); pointerAction = false; }, { signal: events.signal });
    overlay.addEventListener('pointercancel', () => { pointerAction = false; }, { signal: events.signal });
    const paintCode = () => {
      if (!codeGroup) return;
      const value = editor.value.replace(/\D/g,'').slice(0,4);
      if (value !== editor.value) editor.value = value;
      overlay.querySelectorAll<HTMLElement>('.form-input-code-cells > span').forEach((cell,index) => { cell.textContent = editor.value[index] ?? ''; cell.classList.toggle('is-current', index === Math.min(editor.selectionStart ?? editor.value.length,3)); });
    };
    editor.addEventListener('input', paintCode, {signal:events.signal}); editor.addEventListener('select', paintCode, {signal:events.signal}); paintCode();
    editor.addEventListener('focus', () => { pointerAction = false; }, { signal: events.signal });
    editor.addEventListener('compositionstart', () => { composing = true; }, { signal: events.signal });
    editor.addEventListener('compositionend', () => {
      composing = false;
      if (commitRequested) queueMicrotask(complete);
    }, { signal: events.signal });
    editor.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      if (key.key === 'Enter' && original instanceof HTMLInputElement && !key.isComposing && key.keyCode !== 229 && !composing) { event.preventDefault(); complete(); }
    }, { signal: events.signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelFormInput(); }, { capture: true, signal: events.signal });
    window.addEventListener('pagehide', cancelFormInput, { capture: true, signal: events.signal });
    // Losing focus to the keyboard's native Done commits without refocusing the source.
    editor.addEventListener('blur', event => queueMicrotask(() => {
      if (finished || commitRequested || pointerAction || overlay.contains(document.activeElement)) return;
      const commit = !(event as FocusEvent).relatedTarget && document.hasFocus() && active();
      if (commit && composing) commitRequested = true;
      else finish(commit);
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
