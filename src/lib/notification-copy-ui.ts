import referenceUrl from '../assets/notification-reference.png';
import { mountDialog } from './dialog';
import { DEFAULT_NOTIFICATION_COPY, normalizeNotificationCopy, notificationCopyError, notificationCopyLength, notificationCopyPaused, NOTIFICATION_COPY_LIMITS, readNotificationCopy, saveNotificationCopy } from './notification-copy';

export function mountNotificationCopy(root: HTMLElement, options: { signal: AbortSignal; isActive: () => boolean; backIcon: string; onBack: () => void }): void {
  const { signal } = options;
  root.innerHTML = `<section class="device-shell notification-copy-page">
    <header class="subpage-header device-header"><button class="icon-button" id="notification-copy-back" type="button" aria-label="返回通知管理">${options.backIcon}</button><div><h1>通知文案</h1></div><button class="notification-copy-save" id="notification-copy-save" type="submit" form="notification-copy-form" disabled>保存</button></header>
    <section class="notification-copy-preview" aria-label="通知预览"><div class="notification-copy-preview-heading"><span id="notification-copy-state">正在读取…</span><div role="group" aria-label="通知预览对照"><button type="button" data-copy-preview aria-pressed="true">编辑效果</button><button type="button" data-copy-reference aria-pressed="false">原截图</button></div></div>
      <figure class="notification-copy-card"><img src="${referenceUrl}" width="722" height="184" alt="通知卡片：Quiet Room，ai.shui.click，有一条新消息，解锁后查看。"><div class="notification-copy-text" hidden><strong data-copy-title></strong><strong>ai.shui.click</strong><strong data-copy-body></strong></div></figure><p class="notification-copy-hint">自填文案排版待真机核对</p>
    </section>
    <main class="device-content notification-copy-content"><form id="notification-copy-form" novalidate>
      <div class="notification-copy-field"><div><label for="notification-copy-title">标题 · 第1行</label><span data-count-title></span></div><input id="notification-copy-title" autocomplete="off" enterkeyhint="next" aria-describedby="notification-copy-title-error" disabled><p id="notification-copy-title-error" role="alert" hidden></p></div>
      <p class="notification-copy-hint notification-copy-source">第2行来源由系统显示，无法修改。</p>
      <div class="notification-copy-field"><div><label for="notification-copy-body">正文 · 第3行</label><span data-count-body></span></div><textarea id="notification-copy-body" rows="2" autocomplete="off" enterkeyhint="done" aria-describedby="notification-copy-body-error" disabled></textarea><p id="notification-copy-body-error" role="alert" hidden></p></div>
      <p class="notification-copy-hint">保存后，用于本机所有空间的新通知。</p>
      <div class="notification-copy-actions"><details><summary>使用说明</summary><p class="notification-copy-hint">留空使用默认文案。仅影响本机，不改变聊天内容、主屏幕名称或旧通知。自填文字可能显示在锁屏上，请勿填写隐私信息。</p></details><button id="notification-copy-reset" type="button" disabled>恢复默认</button></div>
      <p class="notification-copy-hint" data-copy-paused hidden>本机通知已关闭，开启后生效。</p><p class="notification-copy-feedback" role="status" aria-live="polite" hidden></p>
    </form></main></section>`;
  const shell = root.querySelector<HTMLElement>('.notification-copy-page')!;
  const active = () => !signal.aborted && options.isActive() && shell.isConnected;
  const title = shell.querySelector<HTMLInputElement>('#notification-copy-title')!;
  const body = shell.querySelector<HTMLTextAreaElement>('#notification-copy-body')!;
  const fields = { title, body };
  const save = shell.querySelector<HTMLButtonElement>('#notification-copy-save')!;
  const back = shell.querySelector<HTMLButtonElement>('#notification-copy-back')!;
  const reset = shell.querySelector<HTMLButtonElement>('#notification-copy-reset')!;
  const feedback = shell.querySelector<HTMLElement>('.notification-copy-feedback')!;
  let saved = { ...DEFAULT_NOTIFICATION_COPY }, loading = true, saving = false, composing = false, reference = false;
  let confirmation: ReturnType<typeof mountDialog> | undefined;
  const draft = () => ({ title: title.value, body: body.value });
  const dirty = () => title.value !== saved.title || body.value !== saved.body;
  const status = (message: string, error = false) => { feedback.hidden = !message; feedback.textContent = message; feedback.classList.toggle('is-error', error); };
  const paint = () => {
    let invalid = false;
    for (const key of ['title', 'body'] as const) {
      const error = notificationCopyError(key, fields[key].value);
      invalid ||= !!error;
      const hint = shell.querySelector<HTMLElement>(`#notification-copy-${key}-error`)!;
      hint.textContent = error; hint.hidden = !error;
      fields[key].setAttribute('aria-invalid', String(!!error)); fields[key].disabled = loading || saving;
      shell.querySelector(`[data-count-${key}]`)!.textContent = `${notificationCopyLength(fields[key].value)}/${NOTIFICATION_COPY_LIMITS[key]}`;
      shell.querySelector(`[data-copy-${key}]`)!.textContent = fields[key].value.trim() || DEFAULT_NOTIFICATION_COPY[key];
    }
    const original = reference || (title.value.trim() || DEFAULT_NOTIFICATION_COPY.title) === DEFAULT_NOTIFICATION_COPY.title && (body.value.trim() || DEFAULT_NOTIFICATION_COPY.body) === DEFAULT_NOTIFICATION_COPY.body;
    shell.querySelector<HTMLElement>('.notification-copy-text')!.hidden = original;
    shell.querySelector('img')!.setAttribute('aria-hidden', String(!original));
    shell.querySelector('[data-copy-preview]')!.setAttribute('aria-pressed', String(!reference));
    shell.querySelector('[data-copy-reference]')!.setAttribute('aria-pressed', String(reference));
    shell.querySelector('#notification-copy-state')!.textContent = loading ? '正在读取…' : dirty() ? '预览 · 未保存' : '通知预览';
    save.disabled = loading || saving || composing || invalid || !dirty(); save.textContent = saving ? '保存中' : '保存';
    back.disabled = saving; reset.disabled = loading || saving;
    try { shell.querySelector<HTMLElement>('[data-copy-paused]')!.hidden = !notificationCopyPaused(); } catch { /* Keep editing available if switch metadata is corrupt. */ }
  };
  for (const key of ['title', 'body'] as const) {
    fields[key].addEventListener('input', () => { reference = false; status(''); paint(); }, { signal });
    fields[key].addEventListener('compositionstart', () => { composing = true; paint(); }, { signal });
    fields[key].addEventListener('compositionend', () => { composing = false; paint(); }, { signal });
  }
  title.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && !composing) { event.preventDefault(); body.focus(); } }, { signal });
  shell.querySelector('[data-copy-preview]')!.addEventListener('click', () => { reference = false; paint(); }, { signal });
  shell.querySelector('[data-copy-reference]')!.addEventListener('click', () => { reference = true; paint(); }, { signal });
  reset.addEventListener('click', () => { title.value = DEFAULT_NOTIFICATION_COPY.title; body.value = DEFAULT_NOTIFICATION_COPY.body; reference = false; status(''); paint(); }, { signal });
  back.addEventListener('click', () => {
    if (!active() || saving || confirmation) return;
    if (!dirty() || loading) { options.onBack(); return; }
    const sheet = document.createElement('section'); sheet.className = 'confirm-overlay notification-copy-discard'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'notification-copy-discard-heading');
    sheet.innerHTML = '<div class="confirm-dialog"><h2 id="notification-copy-discard-heading">放弃未保存的修改？</h2><button class="text-button danger" data-discard type="button">放弃修改并返回</button><button class="primary-button" data-continue type="button">继续编辑</button></div>';
    root.append(sheet);
    confirmation = mountDialog(sheet, { signal, isActive: active, returnFocus: back, initialFocus: sheet.querySelector<HTMLElement>('[data-continue]'), onClose: () => { confirmation = undefined; } });
    sheet.querySelector('[data-continue]')!.addEventListener('click', () => confirmation?.close(), { signal });
    sheet.querySelector('[data-discard]')!.addEventListener('click', () => { confirmation?.close({ animate: false, restoreFocus: false }); options.onBack(); }, { signal });
  }, { signal });
  shell.querySelector('form')!.addEventListener('submit', async event => {
    event.preventDefault(); if (save.disabled || !active()) return;
    const value = normalizeNotificationCopy(draft());
    (document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur(); saving = true; status(''); paint();
    try {
      const result = await saveNotificationCopy(value, signal);
      if (!active()) return;
      saved = result; title.value = result.title; body.value = result.body; status('已保存');
    } catch { if (active()) status('保存失败，请重试。修改已保留。', true); }
    finally { if (active()) { saving = false; paint(); } }
  }, { signal });
  window.addEventListener('beforeunload', event => { if (active() && !loading && dirty()) { event.preventDefault(); event.returnValue = ''; } }, { signal });
  window.addEventListener('storage', () => { if (active()) paint(); }, { signal });
  // Privacy/navigation abort drops the unsaved fixed copy and immediately removes modal ownership.
  signal.addEventListener('abort', () => { if (signal.reason === 'navigation') return; title.value = ''; body.value = ''; shell.querySelectorAll('[data-copy-title], [data-copy-body]').forEach(el => { el.textContent = ''; }); }, { once: true });
  void readNotificationCopy().then(value => {
    if (!active()) return;
    saved = value; title.value = value.title; body.value = value.body; loading = false; paint();
  }).catch(() => { if (active()) { loading = false; title.value = saved.title; body.value = saved.body; status('本机文案暂时无法读取，可重新保存。', true); paint(); } });
}
