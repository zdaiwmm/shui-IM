import { mountDialog } from './dialog';
import { restoreUnifiedHistory, type HistoryRestoreProgress } from './cloud-backup';
import type { VaultSession } from './vault';

type Options = {
  root: HTMLElement;
  session: VaultSession;
  signal: AbortSignal;
  isActive: () => boolean;
  withClipboard: <T>(action: () => Promise<T>) => Promise<T>;
  onChanged: () => void;
};

/** One page-owned operation; dismissing a dialog never submits or cancels it. */
export function attachHistoryRestore(options: Options): () => void {
  const { root, session, signal, isActive } = options;
  const entry = root.querySelector<HTMLButtonElement>('[data-restore]')!;
  let operation: AbortController | undefined;
  let view: HistoryRestoreProgress | undefined;
  let error = '';
  let progressSheet: HTMLElement | undefined;
  let inputSheet: HTMLElement | undefined;
  let disposeDialog: (() => void) | undefined;
  let dialogSequence = 0;
  const active = () => !signal.aborted && isActive() && entry.isConnected;
  const setEntry = () => {
    if (!active()) return;
    entry.textContent = operation ? '正在恢复中，点击查看进度' : '恢复历史记录';
    entry.classList.toggle('is-restoring', Boolean(operation));
  };
  const mount = (title: string, content: string, initial?: string) => {
    const sheet = document.createElement('section');
    const titleId = `history-restore-title-${++dialogSequence}`;
    sheet.className = 'recovery-code-sheet history-restore-sheet';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', titleId);
    sheet.innerHTML = `<div class="recovery-code-panel history-restore-panel" tabindex="-1"><div class="history-restore-heading"><h2 id="${titleId}"></h2><button class="icon-button" type="button" data-close aria-label="收起弹窗">×</button></div>${content}</div>`;
    sheet.querySelector('h2')!.textContent = title;
    root.append(sheet);
    const viewport = window.visualViewport;
    const position = () => {
      sheet.style.top = `${viewport?.offsetTop ?? 0}px`;
      sheet.style.height = `${viewport?.height ?? window.innerHeight}px`;
    };
    position(); viewport?.addEventListener('resize', position); viewport?.addEventListener('scroll', position);
    const focus = sheet.querySelector<HTMLElement>(initial ?? '.history-restore-panel')!;
    const dialog = mountDialog(sheet, { signal, isActive: active, returnFocus: entry, initialFocus: focus,
      onClose: () => {
        viewport?.removeEventListener('resize', position); viewport?.removeEventListener('scroll', position);
        const input = sheet.querySelector<HTMLTextAreaElement>('textarea'); if (input) { input.value = ''; input.removeAttribute('id'); }
        if (inputSheet === sheet) inputSheet = undefined;
        if (progressSheet === sheet) progressSheet = undefined;
      } });
    // Safari needs focus inside the original trusted click, before the animation frame.
    focus.focus({ preventScroll: true });
    sheet.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    sheet.addEventListener('click', event => { if (event.target === sheet) dialog.close(); });
    disposeDialog = dialog.dispose;
    return { sheet, dialog };
  };
  const paintProgress = () => {
    if (!progressSheet?.isConnected || !active()) return;
    const reading = !view || view.phase === 'reading';
    const complete = view?.phase === 'complete';
    progressSheet.querySelector('h2')!.textContent = error ? '恢复未完成' : complete ? '恢复完成' : '正在恢复历史记录';
    progressSheet.querySelector('[data-phase]')!.textContent = error ? '已保留恢复进度' : view?.waitingForService ? '备份服务繁忙，等待后自动继续' : reading
      ? view?.totalParts ? `正在读取备份（${view.scannedParts}/${view.totalParts}）` : '正在读取备份…'
      : complete ? '恢复已完成' : '正在恢复…';
    progressSheet.querySelector('[data-percent]')!.textContent = view?.percent == null ? '—' : `${view.percent}%`;
    const bar = progressSheet.querySelector<HTMLProgressElement>('progress')!;
    if (view?.percent == null) bar.removeAttribute('value'); else bar.value = view.percent;
    for (const kind of ['chat', 'gallery'] as const) {
      const node = progressSheet.querySelector(`[data-count="${kind}"]`);
      if (node) node.textContent = reading ? '— / —' : `${view?.[kind]?.restored ?? 0} / ${view?.[kind]?.total ?? 0}`;
    }
    const detail = progressSheet.querySelector<HTMLElement>('[data-detail]')!;
    detail.textContent = error ? `${error}。已完成的记录会保留，可重新输入恢复码重试。` : complete
      ? '本次备份中的记录已处理完成，重复内容会去重。图片原件在查看时下载。'
      : '请保持页面解锁和网络连接。收起弹窗后恢复继续；离开此页或锁定会中止，可重新恢复。';
    detail.classList.toggle('form-error', Boolean(error));
    const retry = progressSheet.querySelector<HTMLButtonElement>('[data-retry]')!;
    retry.hidden = !error;
    progressSheet.querySelector('[data-dismiss]')!.textContent = complete ? '完成' : '收起进度';
  };
  const openProgress = () => {
    if (progressSheet?.isConnected || !active()) return;
    const { sheet, dialog } = mount('正在恢复历史记录', `<div class="history-restore-progress-copy" role="status"><span data-phase></span><strong data-percent></strong></div>
      <progress class="history-restore-progress" max="100" aria-label="恢复进度"></progress><dl class="history-restore-counts"><div><dt>聊天记录</dt><dd><span data-count="chat"></span> 条</dd></div>
      ${session.vault.role === 'creator' ? '<div><dt>保险库</dt><dd><span data-count="gallery"></span> 条</dd></div>' : ''}</dl>
      <p class="field-hint" data-detail></p><div class="history-restore-actions"><button type="button" class="primary-button" data-retry hidden>重新输入恢复码</button><button type="button" class="secondary-button" data-dismiss>收起进度</button></div>`);
    progressSheet = sheet;
    sheet.querySelector('[data-dismiss]')!.addEventListener('click', () => dialog.close());
    sheet.querySelector('[data-retry]')!.addEventListener('click', () => { dialog.dispose(); openInput(); });
    paintProgress();
  };
  const run = async (codes: string) => {
    if (operation || !active()) return;
    const current = new AbortController(); operation = current; error = ''; view = undefined;
    // A failed or cancelled import can have committed records or projection events.
    options.onChanged(); setEntry(); openProgress();
    try {
      await restoreUnifiedHistory(session, codes, AbortSignal.any([signal, current.signal]), progress => {
        if (!active() || operation !== current) return;
        view = progress; paintProgress();
      });
    } catch (cause) {
      if (active() && !current.signal.aborted) error = cause instanceof Error ? cause.message : '网络异常，请检查连接后重试';
    } finally {
      codes = '';
      if (operation === current) operation = undefined;
      if (active()) { setEntry(); paintProgress(); }
    }
  };
  const openInput = () => {
    if (!active() || inputSheet?.isConnected) return;
    const { sheet, dialog } = mount('恢复历史记录', `<form class="history-restore-form"><label for="history-restore-code">恢复码</label>
      <div class="history-restore-input"><textarea id="history-restore-code" name="code" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="QR3-…" required></textarea><button class="text-button" type="button" data-paste data-clipboard="unknown">粘贴</button></div>
      <p class="field-hint">可输入本会话多个设备的恢复码，每行一个，最多 6 个。</p><p class="field-hint" data-clipboard-hint role="status"></p>
      <button class="primary-button" type="submit" disabled>确认恢复</button></form>`, 'textarea');
    inputSheet = sheet;
    const input = sheet.querySelector('textarea')!;
    const submit = sheet.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const paste = sheet.querySelector<HTMLButtonElement>('[data-paste]')!;
    const hint = sheet.querySelector<HTMLElement>('[data-clipboard-hint]')!;
    const usable = () => active() && sheet.isConnected && !sheet.inert;
    const update = () => { submit.disabled = !input.value.trim(); };
    input.addEventListener('input', update);
    // Never prompt or steal keyboard focus merely to probe clipboard contents.
    // Safari can leave this unknown; a neutral Paste action still permits a trusted request.
    const probe = async () => {
      try {
        if (!navigator.clipboard?.readText || !navigator.permissions?.query) return;
        const permission = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
        if (permission.state !== 'granted' || !usable()) return;
        const text = await navigator.clipboard.readText();
        if (!usable()) return;
        paste.disabled = !text.trim(); paste.dataset.clipboard = text.trim() ? 'content' : 'empty';
      } catch { /* Permission is unknown; preserve native paste as fallback. */ }
    };
    void probe();
    input.addEventListener('paste', event => {
      const hasText = Boolean(event.clipboardData?.getData('text').trim());
      paste.disabled = !hasText; paste.dataset.clipboard = hasText ? 'content' : 'empty';
    });
    paste.addEventListener('click', async () => {
      try {
        const text = await options.withClipboard(() => navigator.clipboard.readText());
        if (!usable()) return;
        paste.dataset.clipboard = text.trim() ? 'content' : 'empty'; paste.disabled = !text.trim();
        if (text.trim()) { input.value = text; update(); } else hint.textContent = '剪贴板为空';
      } catch { if (usable()) hint.textContent = '无法读取剪贴板，请长按输入框粘贴。'; }
      if (usable()) input.focus({ preventScroll: true });
    });
    sheet.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      if (!usable() || submit.disabled || operation) return;
      const codes = input.value.trim(); input.value = ''; input.blur();
      dialog.close({ restoreFocus: false });
      void run(codes);
    });
  };
  entry.addEventListener('click', () => { if (operation) openProgress(); else openInput(); }, { signal });
  return () => { operation?.abort(); disposeDialog?.(); };
}
