/** Anchored Safe-only confirmation. No OS/cloud deletion or recovery is implied. */
export function mountMediaDeleteConfirm(anchor: HTMLButtonElement, kind: '照片' | '视频',
  remove: () => Promise<void> | void): () => void {
  const events = new AbortController();
  const panel = document.createElement('div');
  panel.className = 'media-delete-confirm';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `删除${kind}`);
  const description = document.createElement('p');
  description.textContent = `此${kind}将从本机保险箱中删除。聊天中的原消息会保留。`;
  const error = document.createElement('p');
  error.className = 'media-delete-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.dataset.confirmMediaDelete = '';
  confirm.textContent = `删除${kind}`;
  panel.append(description, error, confirm);
  anchor.parentElement!.append(panel);
  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'false');
  let busy = false;
  const close = (focus = false) => {
    panel.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    if (focus && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  anchor.addEventListener('click', event => {
    if (busy) return;
    if (!panel.hidden) { close(); return; }
    error.hidden = true;
    panel.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    if (event.detail === 0) confirm.focus({ preventScroll: true });
  }, { signal: events.signal });
  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  }, { capture: true, signal: events.signal });
  document.addEventListener('keydown', event => {
    if (!panel.hidden && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close(true);
    }
  }, { capture: true, signal: events.signal });
  confirm.addEventListener('click', async () => {
    if (busy || panel.hidden) return;
    busy = true; confirm.disabled = true; anchor.disabled = true;
    try { await remove(); close(); }
    catch {
      if (!events.signal.aborted) { error.textContent = '删除未能保存，请重试'; error.hidden = false; }
    } finally {
      busy = false; confirm.disabled = false; anchor.disabled = false;
    }
  }, { signal: events.signal });
  return () => { events.abort(); panel.remove(); };
}
