import { mountDialog } from './dialog';
import { isPlatformVaultCancellation, isPlatformVaultUnavailable, platformVaultSetupState } from './platform-vault';

/** New wrappers only. Existing protection must authenticate its original verifier. */
export async function prepareNewProtection<T>(root: HTMLElement, options: {
  platform: () => Promise<T>;
  password: () => Promise<T>;
  isActive: () => boolean;
  signal?: AbortSignal;
}): Promise<T> {
  const owner = root.firstElementChild;
  const active = () => options.isActive() && !options.signal?.aborted && !document.hidden && !!owner?.isConnected && root.contains(owner);
  const cancelled = () => new DOMException('已取消设置', 'AbortError');
  if (!active()) throw cancelled();
  if (platformVaultSetupState() === 'unsupported') return options.password();
  try { return await options.platform(); }
  catch (cause) {
    if (!active()) throw cancelled();
    if (isPlatformVaultUnavailable(cause)) return options.password();
    // NotAllowedError conflates cancellation, timeout and a restricted shell.
    // Let the user choose a NEW wrapper, without silently treating it as proof.
    if (!isPlatformVaultCancellation(cause)) throw cause;
  }
  return new Promise<T>((resolve, reject) => {
    const events = new AbortController();
    const sheet = document.createElement('section');
    sheet.className = 'confirm-overlay new-protection-choice';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'new-protection-title');
    sheet.innerHTML = '<div class="confirm-dialog simple-confirm"><h2 id="new-protection-title">未能使用通行密钥</h2><p>可以重试通行密钥，或为此浏览器设置六位数字密码。</p><button class="primary-button" type="button" data-protection-password>使用数字密码</button><button class="text-button" type="button" data-protection-retry>重试通行密钥</button><button class="text-button" type="button" data-protection-cancel>取消</button></div>';
    root.append(sheet);
    let settled = false;
    let observer: MutationObserver | undefined;
    let dialog: ReturnType<typeof mountDialog> | undefined;
    const finish = (operation?: () => Promise<T>) => {
      if (settled) return; settled = true;
      observer?.disconnect(); events.abort();
      options.signal?.removeEventListener('abort', cancel);
      dialog?.close({ animate: false, restoreFocus: false });
      if (!operation || !active()) { reject(cancelled()); return; }
      try { resolve(operation()); } catch (cause) { reject(cause); }
    };
    const cancel = () => finish();
    dialog = mountDialog(sheet, { isActive: active, signal: options.signal, onClose: cancel });
    if (settled) return;
    observer = new MutationObserver(() => { if (!active() || !sheet.isConnected) cancel(); });
    observer.observe(root, { childList: true });
    options.signal?.addEventListener('abort', cancel, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); }, { signal: events.signal });
    window.addEventListener('pagehide', cancel, { signal: events.signal });
    document.addEventListener('freeze', cancel, { signal: events.signal });
    sheet.querySelector('[data-protection-password]')!.addEventListener('click', () => finish(options.password));
    // Start the retry synchronously in its own trusted click, before any await.
    sheet.querySelector('[data-protection-retry]')!.addEventListener('click', () => finish(() => prepareNewProtection(root, options)));
    sheet.querySelector('[data-protection-cancel]')!.addEventListener('click', cancel);
  });
}
