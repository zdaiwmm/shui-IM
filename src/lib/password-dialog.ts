import { mountDialog } from './dialog';
import { passwordValidation } from './password-protection';

/** One fresh operation-bound proof. Cancelling, hiding or timing out rejects late results. */
export function requestPassword<T>(root: HTMLElement, options: {
  create?: boolean; title: string; context: string; signal?: AbortSignal; isActive: () => boolean;
  verify: (password: string) => Promise<T>; forgot?: () => void;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
    const sheet = document.createElement('section'); sheet.className = 'confirm-overlay password-sheet';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'password-title');
    sheet.innerHTML = `<form class="confirm-dialog password-form"><h2 id="password-title"></h2><p data-password-context></p>
      <label>${options.create ? '本机密码' : '输入本机密码'}<input name="password" type="password" autocomplete="${options.create ? 'new-password' : 'current-password'}" required></label>
      ${options.create ? '<label>再次输入密码<input name="confirmation" type="password" autocomplete="new-password" required></label><p class="field-hint">使用 12–128 个字符，可由密码管理器生成和保存。密码仅保护本机空间；找回空间仍需双方各自的恢复码。</p>' : ''}
      <label class="password-show"><input type="checkbox" name="show">显示密码</label>
      <p class="form-error" role="alert"></p><button class="primary-button" type="submit">${options.create ? '继续' : '验证并继续'}</button>
      ${options.forgot ? '<button class="text-button" type="button" data-password-forgot>忘记密码？一起找回空间</button>' : ''}
      <button class="text-button" type="button" data-password-cancel>取消</button></form>`;
    sheet.querySelector('h2')!.textContent = options.title; sheet.querySelector('[data-password-context]')!.textContent = options.context;
    root.append(sheet);
    const form = sheet.querySelector<HTMLFormElement>('form')!, password = form.elements.namedItem('password') as HTMLInputElement;
    const confirmation = form.elements.namedItem('confirmation') as HTMLInputElement | null;
    const error = form.querySelector<HTMLElement>('.form-error')!, button = form.querySelector<HTMLButtonElement>('[type=submit]')!;
    let settled = false, busy = false;
    const active = () => !signal.aborted && sheet.isConnected && options.isActive() && !document.hidden;
    const cancel = () => { if (!settled) { settled = true; reject(new DOMException('验证已取消或超时，请重试', 'AbortError')); } controller.abort(); };
    const dialog = mountDialog(sheet, { signal, initialFocus: password, isActive: active, onClose: cancel });
    signal.addEventListener('abort', () => { password.value = ''; if (confirmation) confirmation.value = ''; cancel(); }, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); }, { signal });
    form.querySelector('[data-password-cancel]')!.addEventListener('click', () => dialog.close());
    form.querySelector('[data-password-forgot]')?.addEventListener('click', () => { dialog.close(); options.forgot?.(); });
    form.querySelector('[name=show]')!.addEventListener('change', event => {
      const type = (event.target as HTMLInputElement).checked ? 'text' : 'password'; password.type = type; if (confirmation) confirmation.type = type;
    });
    password.addEventListener('keydown', event => { if (event.key === 'Enter' && confirmation) { event.preventDefault(); confirmation.focus(); } });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !active()) return;
      let secret = password.value;
      error.textContent = options.create ? passwordValidation(secret, confirmation?.value) : '';
      if (error.textContent) { (secret === confirmation?.value ? password : confirmation ?? password).focus(); return; }
      busy = true; button.disabled = true; button.textContent = '正在验证…';
      password.value = ''; if (confirmation) confirmation.value = '';
      try {
        const proof = await options.verify(secret); secret = '';
        if (!active()) { cancel(); return; }
        settled = true; resolve(proof); dialog.close(); controller.abort();
      } catch (cause) {
        if (active()) { error.textContent = cause instanceof Error ? cause.message : '验证失败，请重试'; password.focus(); }
        else cancel();
      } finally { secret = ''; busy = false; if (active()) { button.disabled = false; button.textContent = options.create ? '继续' : '验证并继续'; } }
    });
  });
}
