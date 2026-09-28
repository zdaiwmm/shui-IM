import { mountDialog } from './dialog';
import { cloudBackupPreference } from './cloud-backup';
import { authorizeLocalHistoryBackup, type LocalHistoryAccess } from './local-history-backup';
import type { VaultSession } from './vault';

export function paintCloudBackup(root: HTMLElement, session: VaultSession, error = '', running = false): void {
  const toggle = root.querySelector<HTMLButtonElement>('[data-cloud-switch]');
  const status = root.querySelector<HTMLElement>('[data-cloud-status]');
  if (!toggle || !status) return;
  const policy = session.vault.cloudBackupPreference;
  toggle.setAttribute('aria-checked', String(Boolean(policy?.enabled)));
  toggle.disabled = !policy || toggle.dataset.saving === 'true';
  const time = session.vault.backup?.historySyncedAt;
  status.textContent = error || (!policy ? '正在读取设置…' : !policy.enabled ? '已关闭，已有云端备份仍可恢复。'
    : !navigator.onLine ? '等待联网后自动备份。' : running ? '已开启，正在自动备份。'
    : time ? `上次备份：${new Date(time).toLocaleString()}` : '已开启，打开并解锁页面时自动备份。');
  const retry = root.querySelector<HTMLButtonElement>('[data-cloud-retry]');
  if (retry) retry.hidden = !error;
}

export function attachCloudBackupSwitch(options: { root: HTMLElement; session: VaultSession; signal: AbortSignal; isActive: () => boolean; onChanged: () => void }): void {
  const { root, session, signal, isActive, onChanged } = options;
  const toggle = root.querySelector<HTMLButtonElement>('[data-cloud-switch]')!;
  const active = () => !signal.aborted && isActive() && toggle.isConnected;
  const refresh = async () => {
    try { await cloudBackupPreference(session, signal); if (active()) paintCloudBackup(root, session); return true; }
    catch { if (active()) paintCloudBackup(root, session, '设置暂时无法读取，请联网后重试。'); return false; }
  };
  let saving = false;
  const save = async (enabled: boolean, report: (message: string) => void) => {
    if (saving || !active()) return false;
    saving = true; toggle.dataset.saving = 'true'; paintCloudBackup(root, session);
    try {
      await cloudBackupPreference(session, signal, enabled);
      if (!active()) return false;
      onChanged(); return true;
    } catch {
      if (active()) {
        const confirmed = await refresh();
        if (active() && confirmed && session.vault.cloudBackupPreference?.enabled === enabled) { onChanged(); return true; }
        if (active()) report('设置暂未确认，请检查网络或其他设备上的设置后重试。');
      }
      return false;
    } finally { saving = false; delete toggle.dataset.saving; if (active()) paintCloudBackup(root, session); }
  };
  toggle.addEventListener('click', () => {
    if (!active() || saving) return;
    if (session.vault.cloudBackupPreference?.enabled) {
      void save(false, message => { root.querySelector('[data-cloud-status]')!.textContent = message; }).then(ok => {
        if (!ok && active()) paintCloudBackup(root, session, '关闭未确认，请联网后重试。');
      });
      return;
    }
    const overlay = document.createElement('section');
    overlay.className = 'recovery-code-sheet backup-privacy-sheet';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'backup-privacy-title');
    overlay.innerHTML = `<div class="recovery-code-panel backup-privacy-panel" tabindex="-1">
      <h2 id="backup-privacy-title">开启前，请了解这些</h2>
      <ul><li><strong>聊天先在设备上加密。</strong>平台保存的是加密后的内容，无法直接查看，也不保管你的恢复码。</li>
      <li><strong>请保管好恢复码。</strong>别人拿到它可能读取备份；丢失后，平台无法替你找回。</li>
      </ul>
      <details><summary>还需要了解什么？</summary><p class="field-hint">平台仍会记录备份时间、大小、所属空间和设备等必要信息。照片和文件能否找回，还取决于原文件是否保留。</p><p class="field-hint">适用于这个空间中你的设备，不改变对方的设置。页面打开、解锁且联网时自动备份。关闭后保留已有备份；空间身份恢复所需的加密材料会继续保存。</p></details>
      <p class="form-error" role="alert"></p><button class="primary-button" data-enable type="button">了解并开启</button><button class="text-button" data-cancel type="button">暂不开启</button>
    </div>`;
    root.append(overlay);
    const dialog = mountDialog(overlay, { signal, isActive: active, returnFocus: toggle, beforeClose: () => !saving });
    overlay.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
    overlay.addEventListener('click', event => { if (event.target === overlay) dialog.close(); });
    const enable = overlay.querySelector<HTMLButtonElement>('[data-enable]')!;
    enable.addEventListener('click', async () => {
      if (saving) return;
      enable.disabled = true;
      const ok = await save(true, message => { overlay.querySelector('.form-error')!.textContent = message; });
      enable.disabled = false;
      if (ok) dialog.close();
    });
  }, { signal });
  root.querySelector('[data-cloud-retry]')!.addEventListener('click', () => { void refresh().then(() => { if (active()) onChanged(); }); }, { signal });
  paintCloudBackup(root, session);
  void refresh();
}

/** File bytes never leave this browser. The code may fetch the encrypted key
 * wrapper needed by a file exported on another authorized device. */
export function requestLocalBackupCode(options: { root: HTMLElement; session: VaultSession; file: File; signal: AbortSignal; isActive: () => boolean }): Promise<LocalHistoryAccess> {
  const { root, session, file, signal, isActive } = options;
  const previous = root.firstElementChild as HTMLElement;
  const page = document.createElement('section');
  page.className = 'gateway gateway-intro backup-code-page';
  page.innerHTML = `<div class="gateway-intro-content"><h1>验证恢复码</h1><p data-filename></p><p>输入备份时保存的恢复码，找回你在这个空间的记录。</p>
    <form><label for="local-restore-code">恢复码</label><textarea id="local-restore-code" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="粘贴恢复码；有多个旧码时每行一个"></textarea>
    <p class="field-hint">文件不会上传。换设备恢复旧文件时，可能需要联网读取加密的恢复材料。</p><p class="form-error" role="alert"></p>
    <button class="primary-button" type="submit">验证恢复码</button></form><button class="text-button" data-cancel type="button">返回</button></div>`;
  page.querySelector('[data-filename]')!.textContent = file.name;
  previous.hidden = true; root.append(page);
  const input = page.querySelector('textarea')!;
  input.focus();
  return new Promise((resolve, reject) => {
    let busy = false;
    const controller = new AbortController();
    const taskSignal = AbortSignal.any([signal, controller.signal]);
    const clean = () => { input.value = ''; page.remove(); previous.hidden = false; signal.removeEventListener('abort', abort); };
    const abort = () => { controller.abort(); clean(); reject(new DOMException('已取消选择', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    page.querySelector('[data-cancel]')!.addEventListener('click', abort);
    page.querySelector('form')!.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !input.value.trim()) return;
      busy = true;
      const submit = page.querySelector<HTMLButtonElement>('[type="submit"]')!;
      submit.disabled = true;
      try {
        const access = await authorizeLocalHistoryBackup(session, file, input.value.trim(), taskSignal);
        if (!isActive() || taskSignal.aborted) return;
        clean(); resolve(access);
      } catch (cause) {
        if (!taskSignal.aborted && isActive()) page.querySelector('.form-error')!.textContent = cause instanceof Error ? cause.message : '无法验证恢复码，请重试';
      } finally { busy = false; submit.disabled = false; }
    });
  });
}
