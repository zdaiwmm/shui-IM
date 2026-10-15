import { mountDialog } from './dialog';
import { layoutViewport } from './form-input';
import type { PasswordRequestOptions } from './password-dialog';
import '../numeric-password.css';

/** V1 numeric entry only. Existing wrappers and operation sheets keep their original verifier. */
export function requestNumericPassword<T>(root: HTMLElement, options: PasswordRequestOptions<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    const sheet = document.createElement('section');
    sheet.className = `confirm-overlay password-sheet password-page numeric-password-page ${options.create ? 'password-create' : 'password-return'}`;
    const id = `numeric-password-${crypto.randomUUID()}`;
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', id);
    sheet.innerHTML = `<form class="confirm-dialog password-form numeric-password-form" novalidate>
      <div class="numeric-password-lock" aria-hidden="true"><svg viewBox="0 0 24 30"><rect x="4" y="12" width="16" height="15" rx="3" fill="currentColor"/><path d="M7 12V8a5 5 0 0 1 10 0v4" fill="none" stroke="currentColor" stroke-width="2.4"/></svg></div>
      <header class="numeric-password-prompt"><h2 id="${id}"></h2><p class="numeric-password-description"></p></header>
      <div class="numeric-password-dots" aria-hidden="true">${'<i></i>'.repeat(6)}</div>
      <p class="sr-only" data-numeric-progress role="status" aria-live="polite" aria-atomic="true"></p>
      <p class="sr-only form-error" role="alert" aria-atomic="true"></p>
      <p class="sr-only" data-numeric-context></p>
      <div class="numeric-password-keypad" role="group" aria-label="数字密码键盘">${['', '', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'].slice(1).map((letters, i) => `<button class="numeric-password-key" type="button" data-digit="${i + 1}" aria-label="数字 ${i + 1}"><span>${i + 1}</span><small aria-hidden="true">${letters || '&nbsp;'}</small></button>`).join('')}<button class="numeric-password-key numeric-password-zero" type="button" data-digit="0" aria-label="数字 0"><span>0</span></button></div>
      <footer class="numeric-password-actions"><button type="button" data-numeric-left></button><button type="button" data-numeric-right></button></footer>
    </form>`;
    const form = sheet.querySelector<HTMLFormElement>('form')!;
    const heading = sheet.querySelector('h2')!, description = sheet.querySelector<HTMLElement>('.numeric-password-description')!;
    const progress = sheet.querySelector<HTMLElement>('[data-numeric-progress]')!, error = sheet.querySelector<HTMLElement>('.form-error')!;
    const dots = [...sheet.querySelectorAll('.numeric-password-dots i')];
    const keys = [...sheet.querySelectorAll<HTMLButtonElement>('[data-digit]')];
    const left = sheet.querySelector<HTMLButtonElement>('[data-numeric-left]')!, right = sheet.querySelector<HTMLButtonElement>('[data-numeric-right]')!;
    sheet.querySelector('[data-numeric-context]')!.textContent = `${options.spaceName ?? '私密空间'}。${options.context}${options.create ? '。这是空间密码，不是手机锁屏密码。' : ''}`;
    sheet.setAttribute('aria-describedby', sheet.querySelector('[data-numeric-context]')!.id = `${id}-context`);
    let digits = '', first = '', confirmation = false, busy = false, verifying = false, waitUnavailable = false, settled = false, waitUntil = 0;
    let waitTimer: ReturnType<typeof setInterval> | undefined;
    let shake: Animation | undefined;
    const active = () => !signal.aborted && sheet.isConnected && options.isActive() && !document.hidden;
    const paint = () => {
      heading.textContent = confirmation ? '再次输入密码' : options.create ? '设置密码' : '输入密码';
      const seconds = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
      description.textContent = seconds ? `请 ${seconds} 秒后再试` : busy ? options.create ? '正在设置密码…' : '正在验证…' : error.textContent || (confirmation ? '再次输入以确认你的密码' : options.create ? '用于此空间的日常解锁' : '输入私密空间的 6 位数字密码');
      dots.forEach((dot, index) => dot.classList.toggle('filled', index < (verifying ? 6 : digits.length)));
      progress.textContent = seconds ? `请 ${seconds} 秒后重试` : busy ? '正在验证' : `已输入 ${digits.length} 位，共 6 位`;
      form.setAttribute('aria-busy', String(busy));
      keys.forEach(key => { key.disabled = busy || seconds > 0 || waitUnavailable; });
      left.textContent = options.create || !options.forgot ? '取消' : '忘记密码？';
      left.toggleAttribute('data-password-cancel', Boolean(options.create || !options.forgot));
      right.textContent = digits.length ? '删除' : '取消';
      right.hidden = Boolean(options.create && !digits.length);
      right.disabled = busy && Boolean(digits.length);
      right.toggleAttribute('data-password-cancel', !digits.length && !options.create);
    };
    const clear = () => { digits = ''; first = ''; waitUntil = 0; busy = false; verifying = false; clearInterval(waitTimer); shake?.cancel(); progress.textContent = ''; error.textContent = ''; form.setAttribute('aria-busy', 'false'); };
    const cancel = () => { clear(); if (!settled) { settled = true; reject(new DOMException('验证已取消', 'AbortError')); } controller.abort(); };
    root.append(sheet);
    const viewport = layoutViewport();
    const fit = () => { const height = viewport?.height ?? window.innerHeight; sheet.style.setProperty('--password-viewport-height', `${height}px`); sheet.style.top = `${viewport?.offsetTop ?? 0}px`; sheet.style.bottom = 'auto'; sheet.style.height = `${height}px`; };
    fit(); viewport?.addEventListener('resize', fit, { signal }); viewport?.addEventListener('scroll', fit, { signal });
    const dialog = mountDialog(sheet, { signal, isActive: active, initialFocus: sheet, onClose: cancel });
    signal.addEventListener('abort', cancel, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); }, { signal });
    window.addEventListener('pagehide', cancel, { signal }); document.addEventListener('freeze', cancel, { signal });
    const leave = (forgot = false) => { dialog.close(); if (forgot) options.forgot?.(); else options.cancel?.(); };
    left.addEventListener('click', () => leave(!options.create && Boolean(options.forgot)), { signal });
    right.addEventListener('click', () => { if (!digits.length) leave(); else if (!busy) { digits = digits.slice(0, -1); error.textContent = ''; paint(); } }, { signal });
    const failure = (text: string) => {
      digits = ''; error.textContent = text;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        shake?.cancel(); shake = sheet.querySelector('.numeric-password-dots')!.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-10px)' }, { transform: 'translateX(9px)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(0)' }], { duration: 360, easing: 'ease-out' });
      }
      paint();
    };
    const readWait = async () => {
      if (!options.retryAfterMs) return;
      const milliseconds = await options.retryAfterMs();
      if (!active()) return;
      clearInterval(waitTimer); waitUntil = Date.now() + Math.max(0, milliseconds);
      if (milliseconds > 0) waitTimer = setInterval(() => { if (!active()) { cancel(); return; } if (Date.now() >= waitUntil) { waitUntil = 0; clearInterval(waitTimer); error.textContent = ''; } paint(); }, 200);
    };
    const submit = async () => {
      if (!active() || busy || waitUnavailable || waitUntil > Date.now() || digits.length !== 6) return;
      if (options.create && !confirmation) { first = digits; digits = ''; confirmation = true; error.textContent = ''; paint(); return; }
      if (options.create && digits !== first) { first = ''; confirmation = false; failure('两次输入不一致，请重新设置'); return; }
      let secret = digits; digits = ''; first = ''; busy = true; verifying = true; error.textContent = ''; paint();
      try {
        const proof = await options.verify(secret); secret = '';
        if (!active()) { cancel(); return; }
        settled = true; clear(); resolve(proof); dialog.close(); controller.abort();
      } catch (cause) {
        if (!active()) { cancel(); return; }
        if (options.create) confirmation = false;
        verifying = false; failure(cause instanceof Error ? cause.message : '验证失败，请重试');
        try { await readWait(); } catch { if (active()) { error.textContent = '暂时无法读取重试状态，请重新进入'; waitUnavailable = true; } else cancel(); }
      } finally { secret = ''; busy = false; verifying = false; if (active()) paint(); }
    };
    const enter = (digit: string) => { if (!active() || busy || waitUnavailable || waitUntil > Date.now() || digits.length >= 6) return; digits += digit; error.textContent = ''; paint(); if (digits.length === 6) void submit(); };
    keys.forEach(key => key.addEventListener('click', () => enter(key.dataset.digit!), { signal }));
    sheet.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); if (!event.repeat) enter(event.key); }
      else if (event.key === 'Backspace') { event.preventDefault(); if (!busy && !waitUnavailable && waitUntil <= Date.now()) { digits = digits.slice(0, -1); error.textContent = ''; paint(); } }
    }, { signal });
    form.addEventListener('submit', event => { event.preventDefault(); void submit(); }, { signal });
    paint();
    if (options.retryAfterMs) { busy = true; paint(); void readWait().catch(() => { if (active()) { error.textContent = '暂时无法读取重试状态，请重新进入'; waitUnavailable = true; } }).finally(() => { busy = false; if (active()) paint(); }); }
  });
}
