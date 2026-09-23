import { mountDialog } from './dialog';
import { fitViewport, spaceIcons } from './space-drawer';
import { normalizePasskeyName, passkeyNamingSupported, signalPasskeyName, isPlatformVaultCancellation, type PlatformCredentialResult } from './platform-vault';
import { readPasskeyName, writePasskeyName, type VaultSession } from './vault';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export async function openPasskeyManagement(root: HTMLElement, options: {
  session: VaultSession; credential: PlatformCredentialResult; signal: AbortSignal;
  prepareKeyboard?: (input: HTMLInputElement, event: PointerEvent) => void;
  verify: (signal: AbortSignal) => Promise<string | undefined>;
  onRenamed?: () => void;
}): Promise<void> {
  // Invoked directly in the settings click stack, before storage or rendering.
  const entry = root.querySelector('#passkey-management');
  const requireEntry = () => { options.signal.throwIfAborted(); if (!entry?.isConnected) throw new DOMException('设置已关闭', 'AbortError'); };
  let userId = await options.verify(options.signal);
  requireEntry();
  let name = await readPasskeyName(options.credential.record);
  requireEntry();
  const lifetime = new AbortController(), signal = AbortSignal.any([options.signal, lifetime.signal]);
  const page = document.createElement('section');
  page.className = 'passkey-manager'; page.setAttribute('role', 'dialog'); page.setAttribute('aria-modal', 'true'); page.setAttribute('aria-label', '通行密钥管理');
  const supported = passkeyNamingSupported() && Boolean(userId);
  const blocked = !supported ? (!userId ? '未能取得这把密钥的用户标识，暂时无法改名。' : '当前浏览器不支持修改系统通行密钥名称，请升级浏览器后再试。') : '';
  page.innerHTML = `<div class="passkey-body"><div class="passkey-mark" aria-hidden="true">${spaceIcons.key}</div><p class="field-hint">当前通行密钥名称</p><h2 id="passkey-current-name">${escape(name ?? '尚未设置名称')}</h2><span class="passkey-current">当前使用</span><div class="passkey-purpose"><strong>一把通行密钥，访问多个空间</strong><p>从已解锁空间继续创建时，会复用这把通行密钥。</p><p>修改名称不会更换密钥，也不会影响空间和聊天记录。</p></div><div class="passkey-bottom"><p class="form-error" role="status" id="passkey-feedback">${escape(blocked)}</p><button class="primary-button" id="passkey-rename" ${supported ? '' : 'disabled'}>修改通行密钥名称</button><button class="text-button" id="passkey-back" type="button">返回</button></div></div>`;
  root.append(page);
  const manager = mountDialog(page, { signal, isActive: () => !signal.aborted, onClose: () => lifetime.abort() });
  page.querySelector('#passkey-back')!.addEventListener('click', () => manager.close({ animate: false }));
  const origin = page.querySelector<HTMLButtonElement>('#passkey-rename')!;
  let pointer: PointerEvent | undefined;
  origin.addEventListener('pointerdown', event => { pointer = event; });
  origin.addEventListener('click', () => {
    if (!supported || signal.aborted) return;
    const overlay = document.createElement('div'); overlay.className = 'space-modal-overlay passkey-name-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'passkey-name-title');
    overlay.innerHTML = `<form class="space-name-dialog"><h2 id="passkey-name-title">修改通行密钥名称</h2><label class="sr-only" for="passkey-name">通行密钥名称</label><input id="passkey-name" value="${escape(name ?? '')}" autocomplete="off" spellcheck="false"><p class="field-hint">使用方便辨认的名称，1–40 个字符。不要填写聊天隐私。</p><p class="form-error" role="alert"></p><div class="space-dialog-actions"><button type="button" class="text-button" id="passkey-cancel">取消</button><button type="submit" class="primary-button">验证并保存</button></div></form>`;
    root.append(overlay);
    const resize = new AbortController(), input = overlay.querySelector<HTMLInputElement>('input')!, error = overlay.querySelector<HTMLElement>('.form-error')!;
    let saving = false, pendingName: string | undefined;
    const modal = mountDialog(overlay, { signal, isActive: () => !signal.aborted, returnFocus: origin, initialFocus: input, beforeClose: () => !saving, onClose: () => resize.abort() });
    fitViewport(overlay, resize.signal);
    overlay.querySelector('#passkey-cancel')!.addEventListener('click', () => modal.close());
    overlay.addEventListener('click', e => { if (e.target === overlay) modal.close(); });
    overlay.querySelector('form')!.addEventListener('submit', async event => {
      event.preventDefault(); if (saving || signal.aborted) return;
      let next: string;
      try { next = pendingName ?? normalizePasskeyName(input.value); }
      catch (cause) { error.textContent = (cause as Error).message; input.focus(); return; }
      if (next === name && !pendingName) { modal.close(); return; }
      saving = true; error.textContent = '请完成通行密钥验证…';
      // No await before the fresh, specified-credential assertion.
      const verification = options.verify(signal);
      input.readOnly = true; overlay.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
      let submitted = Boolean(pendingName);
      try {
        userId = await verification;
        signal.throwIfAborted();
        if (!userId) throw new Error('未能取得通行密钥用户标识');
        await signalPasskeyName(options.credential.record, userId, next, signal);
        submitted = true; pendingName = next;
        signal.throwIfAborted();
        await writePasskeyName(options.session, options.credential.record, next, signal);
        signal.throwIfAborted();
        name = next;
        page.querySelector('#passkey-current-name')!.textContent = name;
        page.querySelector('#passkey-feedback')!.textContent = '';
        modal.close({ animate: false });
        options.onRenamed?.();
      } catch (cause) {
        if (!signal.aborted) error.textContent = submitted
          ? '结果待确认：已通知系统更新，但应用名称未保存。请再次验证，重试保存同一名称。'
          : isPlatformVaultCancellation(cause) ? '验证已取消，名称未修改。' : cause instanceof Error ? cause.message : '名称未保存，请重试';
      } finally {
        saving = false; input.readOnly = Boolean(pendingName);
        overlay.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false);
      }
    });
    if (pointer && performance.now() - pointer.timeStamp < 1000) options.prepareKeyboard?.(input, pointer);
    pointer = undefined;
    input.addEventListener('pointerdown', event => options.prepareKeyboard?.(input, event));
    input.focus({ preventScroll: true }); input.select();
  });
}
