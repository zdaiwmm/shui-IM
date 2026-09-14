import { mountDialog } from './dialog';
import { restoreUnifiedHistory, type HistoryRestoreProgress } from './cloud-backup';
import type { VaultSession } from './vault';
import { clearHistoryRestoreTask, saveHistoryRestoreTask } from './history-restore-task';

type Options = {
  root: HTMLElement;
  session: VaultSession;
  signal: AbortSignal;
  isActive: () => boolean;
  onChanged: () => void;
};

/** Page-owned network work with an encrypted task that survives page teardown. */
export function attachHistoryRestore(options: Options): () => void {
  const { root, session, signal, isActive } = options;
  const entry = root.querySelector<HTMLButtonElement>('[data-restore]')!;
  let operation: AbortController | undefined;
  let view: HistoryRestoreProgress | undefined;
  let retryCodes = session.vault.historyRestoreTask?.codes.join('\n') ?? '';
  let error = retryCodes ? '恢复任务已暂停，可点击重试继续' : '';
  let cancelling = false;
  let disposed = false;
  let progressSheet: HTMLElement | undefined;
  let inputSheet: HTMLElement | undefined;
  let disposeDialog: (() => void) | undefined;
  let dialogSequence = 0;
  const active = () => !disposed && !signal.aborted && isActive() && entry.isConnected;
  const setEntry = () => {
    if (!active()) return;
    entry.textContent = operation ? '正在恢复中，点击查看进度' : retryCodes && error ? '恢复未完成，点击查看并重试' : '恢复历史记录';
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
      sheet.style.setProperty('--restore-viewport-height', sheet.style.height);
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
    progressSheet.querySelector('[data-phase]')!.textContent = error ? !view ? '恢复任务已暂停' : reading ? '备份核验中断' : '历史导入中断，已写入记录会保留' : view?.waitingForService ? '备份服务繁忙，等待后自动继续' : reading
      ? view?.totalParts ? `正在核验备份（${view.scannedParts}/${view.totalParts}）` : '正在读取备份…'
      : complete ? '恢复已完成' : '正在恢复…';
    progressSheet.querySelector('[data-percent]')!.textContent = view?.percent == null ? '—' : `${view.percent}%`;
    const bar = progressSheet.querySelector<HTMLProgressElement>('progress')!;
    if (view?.percent == null) bar.removeAttribute('value'); else bar.value = view.percent;
    for (const kind of ['chat', 'gallery'] as const) {
      const node = progressSheet.querySelector(`[data-count="${kind}"]`);
      if (node) node.textContent = reading ? `待恢复 ${view?.[kind]?.total ?? 0} 条` : `${view?.[kind]?.restored ?? 0} / ${view?.[kind]?.total ?? 0} 条`;
    }
    const detail = progressSheet.querySelector<HTMLElement>('[data-detail]')!;
    detail.textContent = error ? `${error}。${reading ? '本轮尚未开始导入新的记录，之前已导入的内容会保留。' : '已写入的记录会保留。'}连接恢复后可点击重试，只补缺失内容。` : complete
      ? '缺失记录已补齐，本机已有内容不会重复导入。图片原件在查看时下载。'
      : `${reading ? '正在核验并对比本机，待恢复总数尚未确定。' : '每批写入后立即保存。'}收起弹窗后继续；离开页面或锁定会暂停，回来可继续，直到完成或取消。`;
    detail.classList.toggle('form-error', Boolean(error));
    const retry = progressSheet.querySelector<HTMLButtonElement>('[data-retry]')!;
    retry.hidden = !error;
    retry.disabled = cancelling;
    progressSheet.querySelector<HTMLButtonElement>('[data-change-code]')!.hidden = !error;
    const cancel = progressSheet.querySelector<HTMLButtonElement>('[data-cancel]')!;
    cancel.hidden = complete && !error;
    cancel.disabled = cancelling;
    progressSheet.querySelector('[data-dismiss]')!.textContent = complete ? '完成' : '收起进度';
  };
  const openProgress = () => {
    if (progressSheet?.isConnected || !active()) return;
    const { sheet, dialog } = mount('正在恢复历史记录', `<div class="history-restore-progress-copy" role="status"><span data-phase></span><strong data-percent></strong></div>
      <progress class="history-restore-progress" max="100" aria-label="恢复进度"></progress><dl class="history-restore-counts"><div><dt>聊天记录</dt><dd><span data-count="chat"></span></dd></div>
      ${session.vault.role === 'creator' ? '<div><dt>保险库</dt><dd><span data-count="gallery"></span></dd></div>' : ''}</dl>
      <p class="field-hint" data-detail></p><div class="history-restore-actions"><button type="button" class="primary-button" data-retry hidden>重试恢复</button><button type="button" class="secondary-button" data-dismiss>收起进度</button><button type="button" class="text-button" data-change-code hidden>更换恢复码</button><button type="button" class="text-button" data-cancel>取消恢复</button></div>`);
    progressSheet = sheet;
    sheet.querySelector('[data-dismiss]')!.addEventListener('click', () => dialog.close());
    sheet.querySelector('[data-retry]')!.addEventListener('click', () => { if (retryCodes && !operation) void run(retryCodes); });
    const cancel = async (replace: boolean) => {
      if (cancelling || !active()) return;
      cancelling = true; operation?.abort(); paintProgress();
      try {
        await clearHistoryRestoreTask(session, signal);
        retryCodes = ''; error = ''; view = undefined;
        if (active()) { setEntry(); dialog.dispose(); if (replace) openInput(); }
      } catch (cause) {
        if (active()) {
          retryCodes = session.vault.historyRestoreTask?.codes.join('\n') ?? retryCodes;
          error = cause instanceof Error ? cause.message : '取消未保存，请重试'; setEntry(); paintProgress();
        }
      } finally { cancelling = false; if (active()) paintProgress(); }
    };
    sheet.querySelector('[data-change-code]')!.addEventListener('click', () => void cancel(true));
    sheet.querySelector('[data-cancel]')!.addEventListener('click', () => void cancel(false));
    paintProgress();
  };
  const run = async (codes: string) => {
    if (operation || cancelling || !active()) return;
    const current = new AbortController(); operation = current; error = ''; view = undefined;
    retryCodes = codes;
    // A failed or cancelled import can have committed records or projection events.
    options.onChanged(); setEntry(); openProgress();
    try {
      const taskSignal = AbortSignal.any([signal, current.signal]);
      await saveHistoryRestoreTask(session, codes, taskSignal);
      await restoreUnifiedHistory(session, codes, taskSignal, progress => {
        if (!active() || operation !== current) return;
        view = progress; paintProgress();
      });
      await clearHistoryRestoreTask(session, taskSignal);
      retryCodes = '';
    } catch (cause) {
      if (active() && !current.signal.aborted) error = cause instanceof Error ? cause.message : '网络异常，请检查连接后重试';
    } finally {
      codes = '';
      if (!active()) retryCodes = '';
      if (operation === current) operation = undefined;
      if (active()) { setEntry(); paintProgress(); }
    }
  };
  const openInput = () => {
    if (!active() || inputSheet?.isConnected) return;
    const { sheet, dialog } = mount('恢复历史记录', `<form class="history-restore-form"><label for="history-restore-code">恢复码</label>
      <div class="history-restore-input"><textarea id="history-restore-code" name="code" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="QR3-…" required></textarea></div>
      <button class="primary-button" type="submit" disabled>确认恢复</button></form>`, 'textarea');
    inputSheet = sheet;
    const input = sheet.querySelector('textarea')!;
    const submit = sheet.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const usable = () => active() && sheet.isConnected && !sheet.inert;
    const update = () => { submit.disabled = !input.value.trim(); };
    input.addEventListener('input', update);
    sheet.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      if (!usable() || submit.disabled || operation) return;
      const codes = input.value.trim(); input.value = ''; input.blur();
      dialog.close({ restoreFocus: false });
      void run(codes);
    });
  };
  entry.addEventListener('click', () => { if (operation || retryCodes && error) openProgress(); else openInput(); }, { signal });
  const dispose = () => { disposed = true; retryCodes = ''; operation?.abort(); disposeDialog?.(); };
  signal.addEventListener('abort', dispose, { once: true });
  setEntry();
  return () => { signal.removeEventListener('abort', dispose); dispose(); };
}
