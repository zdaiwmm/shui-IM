import { mountDialog } from './dialog';
import { passwordValidation } from './password-protection';
import { createElement, LockKeyhole, ChevronLeft } from 'lucide';

/** One fresh operation-bound proof. Cancelling, hiding or timing out rejects late results. */
export function requestPassword<T>(root: HTMLElement, options: {
  create?: boolean; title: string; context: string; signal?: AbortSignal; isActive: () => boolean;
  verify: (password: string) => Promise<T>; forgot?: () => void; cancel?: () => void;
  presentation?: 'page' | 'sheet'; spaceName?: string; operation?: string; submitLabel?: string;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
    const fullPage = options.create || options.presentation === 'page';
    const submitLabel = options.submitLabel ?? (options.create ? '设置密码并继续' : options.operation === '查看我的恢复码' ? '验证并查看恢复码' : options.operation === '导出聊天备份' ? '验证并下载备份' : options.operation === '导入聊天备份' ? '验证并恢复记录' : '验证并继续');
    const sheet = document.createElement('section'); sheet.className = `confirm-overlay password-sheet ${fullPage ? `password-page ${options.create ? 'password-create' : 'password-return'}` : 'password-operation-sheet'}`;
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'password-title');
    sheet.innerHTML = `<form class="confirm-dialog password-form" novalidate>
      ${fullPage && !options.create ? '<button class="icon-button password-page-back" type="button" data-password-cancel aria-label="返回"></button>' : ''}
      ${fullPage ? '<div class="password-page-content"><div class="password-mark" aria-hidden="true"></div>' : '<div class="sheet-handle" aria-hidden="true"></div><div class="password-page-content">'}
      <h2 id="password-title"></h2>${!options.create && fullPage ? '<strong class="password-space-name" data-password-space></strong>' : ''}
      <p data-password-context class="${options.create ? 'password-reason' : 'password-description'}"></p>
      ${options.create ? '<p class="password-description">以后打开此空间时输入这个密码。它不是手机锁屏密码。</p>' : ''}
      ${!fullPage && options.spaceName ? '<div class="password-operation"><small>本次操作的空间</small><strong data-password-space></strong><span data-password-operation></span></div>' : ''}
      <div class="password-fields">
        <label>空间密码<input name="password" type="password" autocomplete="${options.create ? 'new-password' : 'current-password'}" autocapitalize="none" spellcheck="false" aria-describedby="password-error password-help" required></label>
        ${options.create ? '<label>再次输入<input name="confirmation" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false" aria-describedby="password-error" required></label>' : ''}
        <label class="password-show"><input type="checkbox" name="show">显示密码</label>
        ${options.create ? '<p class="field-hint" id="password-help">使用 12–128 个字符。可使用密码管理器生成、填写或保存。</p><p class="field-hint">忘记密码时，需要双方参与找回。</p>' : '<span id="password-help" class="sr-only">输入此空间已有的密码</span>'}
        <p class="form-error" id="password-error" role="alert"></p>
      </div></div>
      <div class="password-actions"><button class="primary-button" type="submit"></button>
        ${options.forgot ? '<button class="text-button" type="button" data-password-forgot>忘记密码？使用恢复码找回</button><p class="field-hint">需要双方参与，旧记录另行恢复。</p>' : ''}
        ${fullPage && !options.create ? '' : `<button class="text-button" type="button" data-password-cancel>${fullPage ? '返回' : '取消操作'}</button>`}
      </div></form>`;
    sheet.querySelector('h2')!.textContent = options.title;
    sheet.querySelector('[data-password-context]')!.textContent = options.context;
    sheet.querySelector('[type=submit]')!.textContent = submitLabel;
    sheet.querySelector('[data-password-space]')?.append(document.createTextNode(options.spaceName ?? '私密空间'));
    sheet.querySelector('[data-password-operation]')?.append(document.createTextNode(options.operation ?? '继续此操作'));
    const mark = sheet.querySelector('.password-mark'); if (mark) mark.append(createElement(LockKeyhole));
    sheet.querySelector('.password-page-back')?.append(createElement(ChevronLeft));
    root.append(sheet);
    const viewport = window.visualViewport;
    const fitViewport = () => { if (!viewport) return; sheet.style.top = `${viewport.offsetTop}px`; sheet.style.bottom = 'auto'; sheet.style.height = `${viewport.height}px`; };
    fitViewport(); viewport?.addEventListener('resize', fitViewport, { signal }); viewport?.addEventListener('scroll', fitViewport, { signal });
    const form = sheet.querySelector<HTMLFormElement>('form')!, password = form.elements.namedItem('password') as HTMLInputElement;
    const confirmation = form.elements.namedItem('confirmation') as HTMLInputElement | null;
    const error = form.querySelector<HTMLElement>('.form-error')!, button = form.querySelector<HTMLButtonElement>('[type=submit]')!;
    let settled = false, busy = false;
    const active = () => !signal.aborted && sheet.isConnected && options.isActive() && !document.hidden;
    const cancel = () => { if (!settled) { settled = true; reject(new DOMException('验证已取消或超时，请重试', 'AbortError')); } controller.abort(); };
    const dialog = mountDialog(sheet, { signal, initialFocus: password, isActive: active, onClose: cancel });
    signal.addEventListener('abort', () => { password.value = ''; if (confirmation) confirmation.value = ''; cancel(); }, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); }, { signal });
    form.querySelector('[data-password-cancel]')!.addEventListener('click', () => { dialog.close(); options.cancel?.(); });
    form.querySelector('[data-password-forgot]')?.addEventListener('click', () => { dialog.close(); options.forgot?.(); });
    form.querySelector('[name=show]')!.addEventListener('change', event => {
      const type = (event.target as HTMLInputElement).checked ? 'text' : 'password'; password.type = type; if (confirmation) confirmation.type = type;
    });
    password.addEventListener('keydown', event => { if (event.key === 'Enter' && confirmation) { event.preventDefault(); confirmation.focus(); } });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !active()) return;
      let secret = password.value;
      error.textContent = options.create ? passwordValidation(secret, confirmation?.value) : secret ? '' : '请输入此空间已有的密码';
      if (error.textContent) { const invalid = options.create && Array.from(secret).length >= 12 && Array.from(secret).length <= 128 ? confirmation ?? password : password; invalid.setAttribute('aria-invalid', 'true'); invalid.focus(); return; }
      password.removeAttribute('aria-invalid'); confirmation?.removeAttribute('aria-invalid');
      busy = true; button.disabled = true; button.textContent = options.create ? '正在设置本机保护…' : '正在验证…'; form.setAttribute('aria-busy', 'true');
      password.value = ''; if (confirmation) confirmation.value = '';
      try {
        const proof = await options.verify(secret); secret = '';
        if (!active()) { cancel(); return; }
        settled = true; resolve(proof); dialog.close(); controller.abort();
      } catch (cause) {
        if (active()) { error.textContent = cause instanceof Error ? cause.message : '验证失败，请重试'; password.setAttribute('aria-invalid', 'true'); password.focus(); }
        else cancel();
      } finally { secret = ''; busy = false; if (active()) { button.disabled = false; button.textContent = submitLabel; form.removeAttribute('aria-busy'); } }
    });
  });
}
