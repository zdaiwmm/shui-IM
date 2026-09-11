import { createVideoPoster } from './video-poster';
import { createConcealedImage } from './concealed-image';
import { videoMimeType } from './video-media';

/** A local selection, not a message or a receipt. Never persisted as plaintext. */
export class VideoUploadView {
  readonly element = document.createElement('article');
  private readonly abort = new AbortController();
  private readonly urls = new Set<string>();
  private readonly label = document.createElement('span');
  private readonly progress = document.createElement('progress');
  private readonly retry = document.createElement('button');
  private readonly preview = document.createElement('img');
  private readonly tile = document.createElement('div');

  constructor(id: string, file: File, retry: () => void, remove: () => void, changed: () => void) {
    this.element.className = 'message outgoing video-upload';
    this.element.dataset.clientMsgId = id;
    this.element.dataset.uploadState = 'preparing';
    this.tile.className = 'message-bubble video-upload-tile';
    this.preview.alt = '视频封面（已模糊）';
    this.preview.hidden = true;
    const icon = document.createElement('span');
    icon.className = 'video-upload-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 5 11 7-11 7Z"/></svg>';
    const status = document.createElement('div');
    status.className = 'video-upload-status';
    this.label.setAttribute('role', 'status');
    this.progress.max = 1;
    this.progress.setAttribute('aria-label', '视频上传进度');
    const actions = document.createElement('div');
    actions.className = 'video-upload-actions';
    this.retry.type = 'button';
    this.retry.textContent = '重试';
    this.retry.addEventListener('click', retry);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '移除';
    cancel.addEventListener('click', remove);
    actions.append(this.retry, cancel);
    status.append(this.label, this.progress, actions);
    this.tile.append(this.preview, icon, status);
    this.element.append(this.tile);
    this.update('preparing');
    // The user-selected complete original needs no remote integrity check.
    // Received attachments still take the full authenticated-download path.
    void this.preparePoster(file, changed);
  }

  update(state: 'preparing' | 'uploading' | 'finishing' | 'failed', ratio = 0): void {
    if (this.abort.signal.aborted) return;
    this.element.dataset.uploadState = state;
    const value = Math.max(0, Math.min(1, ratio));
    this.label.textContent = state === 'preparing' ? '正在准备视频…'
      : state === 'finishing' ? '上传完成，正在发送…'
        : state === 'failed' ? '视频发送失败' : `正在上传 ${Math.round(value * 100)}%`;
    this.progress.hidden = state === 'failed';
    if (state === 'preparing') this.progress.removeAttribute('value');
    else this.progress.value = state === 'finishing' ? 1 : value;
    this.retry.disabled = state !== 'failed';
    this.element.setAttribute('aria-busy', String(state !== 'failed'));
  }

  private url(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  private async preparePoster(file: File, changed: () => void): Promise<void> {
    const signal = this.abort.signal;
    try {
      const originalUrl = this.url(new Blob([file], { type: videoMimeType({ mimeType: file.type, originalName: file.name })! }));
      const poster = await createVideoPoster(originalUrl, signal);
      signal.throwIfAborted();
      const posterUrl = this.url(poster.blob);
      const decoded = new Image();
      decoded.src = posterUrl;
      await decoded.decode();
      const concealed = await createConcealedImage(decoded, signal);
      signal.throwIfAborted();
      this.preview.src = this.url(concealed);
      this.preview.hidden = false;
      this.tile.style.aspectRatio = `${poster.width} / ${poster.height}`;
      this.tile.style.setProperty('--video-upload-ratio', String(poster.width / poster.height));
      this.element.dataset.poster = 'ready';
      changed();
      for (const url of [originalUrl, posterUrl]) { URL.revokeObjectURL(url); this.urls.delete(url); }
    } catch {
      // Unsupported camera codecs retain the tile and genuine upload progress.
      if (!signal.aborted) this.element.dataset.poster = 'unavailable';
      for (const url of this.urls) URL.revokeObjectURL(url);
      this.urls.clear();
    }
  }

  destroy(): void {
    this.abort.abort();
    this.preview.removeAttribute('src');
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.element.remove();
  }
}
