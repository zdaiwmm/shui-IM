import { createElement, Image as ImageIcon, Video, RotateCcw, X } from 'lucide';
import { setChatMediaDimensions } from './chat-media-geometry';
import { readMediaDimensions, type MediaDimensions } from './media-dimensions';
import { createVideoPoster } from './video-poster';
import { createConcealedImage } from './concealed-image';
import { isVideoFile, videoMimeType } from './video-media';

type UploadState = 'preparing' | 'uploading' | 'finishing' | 'failed';

/** A complete local selection, never a received message or a read receipt. */
export class MediaUploadView {
  readonly element = document.createElement('article');
  private readonly abort = new AbortController();
  private readonly urls = new Set<string>();
  private readonly label = document.createElement('span');
  private readonly percent = document.createElement('strong');
  private readonly ring = document.createElement('span');
  private readonly retry = document.createElement('button');
  private readonly cancel = document.createElement('button');
  private readonly status = document.createElement('div');
  private readonly tile = document.createElement('div');
  private readonly kind: string;

  constructor(id: string, files: File[], expression: boolean, autoHide: boolean,
    retry: () => void, remove: () => void, changed: () => void) {
    const video = isVideoFile({ mimeType: files[0]!.type, originalName: files[0]!.name });
    this.kind = video ? '视频' : expression ? '表情' : files.length > 1 ? '图片相册' : '图片';
    this.element.className = `message outgoing has-media media-upload${video ? ' video-upload' : ''}`;
    this.element.dataset.clientMsgId = id;
    this.element.dataset.concealed = String(!expression || autoHide);
    this.element.setAttribute('aria-label', `正在发送${this.kind}`);
    this.tile.className = `message-bubble media-upload-tile${expression ? ' media-upload-expression' : ''}`;
    const previews = document.createElement('div');
    previews.className = files.length > 1
      ? `media-upload-previews image-album album-count-${files.length <= 4 ? files.length : 'many'}`
      : 'media-upload-previews';
    this.tile.classList.toggle('media-upload-album', files.length > 1);
    this.status.className = 'media-upload-status';
    this.ring.className = 'media-upload-ring';
    this.ring.setAttribute('role', 'progressbar');
    this.ring.setAttribute('aria-label', `${this.kind}上传进度`);
    this.ring.setAttribute('aria-valuemin', '0');
    this.ring.setAttribute('aria-valuemax', '100');
    const text = document.createElement('span');
    text.className = 'media-upload-copy';
    this.label.setAttribute('role', 'status');
    this.label.setAttribute('aria-live', 'polite');
    text.append(this.percent, this.label);
    this.retry.type = 'button';
    this.retry.className = 'media-upload-retry';
    const retryText = document.createElement('span');
    retryText.textContent = '重试';
    this.retry.append(createElement(RotateCcw), retryText);
    this.retry.addEventListener('click', retry);
    this.cancel.type = 'button';
    this.cancel.className = 'media-upload-remove';
    this.cancel.setAttribute('aria-label', `移除未发送的${this.kind}`);
    this.cancel.append(createElement(X));
    this.cancel.addEventListener('click', remove);
    this.status.append(this.ring, text, this.retry);
    this.tile.append(previews, this.status, this.cancel);
    this.element.append(this.tile);
    this.update('preparing');
    // Measure before the first timeline insertion, independently of poster/blur
    // generation. Every later state uses these same original dimensions.
    this.geometryReady = files.length > 1;
    const source = video ? new Blob([files[0]!], { type: videoMimeType({ mimeType: files[0]!.type, originalName: files[0]!.name })! }) : files[0]!;
    this.ready = files.length === 1 ? readMediaDimensions(source, this.abort.signal).then(dimensions => {
      this.geometryReady = true;
      if (!dimensions || this.abort.signal.aborted) return;
      this.dimensions = dimensions;
      const ratio = dimensions.width / dimensions.height;
      this.tile.style.aspectRatio = String(ratio);
      this.tile.style.setProperty('--media-upload-ratio', String(ratio));
      this.tile.style.setProperty('--media-upload-natural-width', `${dimensions.width * (expression ? 2 / 3 : 1)}px`);
    }) : Promise.resolve();
    this.preparation = this.ready.catch(() => {});
    for (const [index, file] of files.entries()) {
      const cell = document.createElement('div');
      cell.className = 'media-upload-preview album-cell';
      const icon = createElement(video ? Video : ImageIcon);
      icon.classList.add('media-upload-placeholder');
      icon.setAttribute('aria-hidden', 'true');
      cell.append(icon);
      previews.append(cell);
      // Decode sequentially to bound simultaneous image/canvas memory.
      this.preparation = this.preparation.then(() => this.prepare(file, cell, index, files.length, !expression || autoHide, changed));
    }
  }

  geometryReady = false;
  readonly ready: Promise<void>;
  private preparation = Promise.resolve();

  update(state: UploadState, ratio = 0): void {
    if (this.abort.signal.aborted) return;
    this.element.dataset.uploadState = state;
    this.status.dataset.state = state;
    const value = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    this.percent.textContent = `${value}%`;
    this.percent.hidden = state !== 'uploading';
    this.label.textContent = state === 'preparing' ? '准备中' : state === 'finishing' ? '发送中'
      : state === 'failed' ? '上传失败' : '上传中';
    this.ring.hidden = state === 'failed';
    this.ring.style.setProperty('--upload-progress', `${value}%`);
    if (state === 'uploading') this.ring.setAttribute('aria-valuenow', String(value));
    else this.ring.removeAttribute('aria-valuenow');
    this.retry.hidden = this.cancel.hidden = state !== 'failed';
    this.retry.disabled = state !== 'failed';
    this.element.setAttribute('aria-busy', String(state !== 'failed'));
  }

  private url(blob: Blob): string {
    this.abort.signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  private revoke(url: string): void { URL.revokeObjectURL(url); this.urls.delete(url); }

  private async prepare(file: File, cell: HTMLElement, index: number, count: number, conceal: boolean, changed: () => void): Promise<void> {
    const signal = this.abort.signal;
    const temporary: string[] = [];
    const decoded = new Image();
    const clear = () => decoded.removeAttribute('src');
    try {
      signal.throwIfAborted();
      signal.addEventListener('abort', clear, { once: true });
      const video = isVideoFile({ mimeType: file.type, originalName: file.name });
      const original = this.url(video ? new Blob([file], { type: videoMimeType({ mimeType: file.type, originalName: file.name })! }) : file);
      temporary.push(original);
      const poster = video ? await createVideoPoster(original, signal) : null;
      signal.throwIfAborted();
      const source = poster ? this.url(poster.blob) : original;
      if (poster) temporary.push(source);
      decoded.src = source;
      await decoded.decode();
      signal.throwIfAborted();
      const preview = document.createElement('img');
      // Concealed originals are never attached to the painted DOM, even for one frame.
      preview.src = conceal ? this.url(await createConcealedImage(decoded, signal)) : source;
      signal.throwIfAborted();
      preview.alt = `${this.kind}${count > 1 ? ` ${index + 1}/${count}` : ''}${conceal ? '（已模糊）' : ''}`;
      preview.draggable = false;
      cell.replaceChildren(preview);
      if (video) {
        const badge = document.createElement('span');
        badge.className = 'media-upload-video-label';
        badge.append(createElement(Video), document.createTextNode('视频'));
        cell.append(badge);
      }
      this.element.dataset.poster = 'ready';
      changed();
      if (!conceal) temporary.splice(temporary.indexOf(source), 1);
    } catch {
      if (!signal.aborted) { cell.dataset.preview = 'unavailable'; this.element.dataset.poster = 'unavailable'; }
    } finally {
      signal.removeEventListener('abort', clear);
      clear();
      for (const url of temporary) this.revoke(url);
    }
  }

  private handedOff = false;
  private dimensions?: MediaDimensions;

  handoff(message: HTMLElement, signal: AbortSignal): void {
    const bubble = message.querySelector<HTMLElement>('.image-bubble');
    if (!bubble || this.handedOff || this.abort.signal.aborted) return;
    this.handedOff = true;
    if (this.dimensions) {
      setChatMediaDimensions(bubble, this.dimensions);
      const preview = bubble.querySelector<HTMLElement>(':scope > .image-preview');
      if (preview) setChatMediaDimensions(preview, this.dimensions);
    }
    const overlay = document.createElement('div');
    overlay.className = 'media-upload-handoff';
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    const previews = this.tile.querySelector('.media-upload-previews')!;
    overlay.append(previews, this.status);
    bubble.append(overlay);
    const cleanup = () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', cleanup);
      for (const image of previews.querySelectorAll('img')) image.removeAttribute('src');
      overlay.remove();
      this.destroy(true);
    };
    const settle = () => {
      if (![...bubble.querySelectorAll('.image-preview')].every(node => node.getAttribute('data-image-state') === 'loaded')) return;
      observer.disconnect();
      previews.remove();
      const animation = this.status.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 320,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards',
      });
      void animation.finished.then(cleanup, cleanup);
    };
    // Observe only this short-lived handoff, never the timeline or document.
    const observer = new MutationObserver(settle);
    observer.observe(bubble, { subtree: true, attributes: true, attributeFilter: ['data-image-state'] });
    const timeout = window.setTimeout(cleanup, 5000);
    signal.addEventListener('abort', cleanup, { once: true });
    if (signal.aborted) cleanup();
    else settle();
  }

  destroy(force = false): void {
    if (this.handedOff && !force) { this.element.remove(); return; }
    this.abort.abort();
    for (const image of this.element.querySelectorAll('img')) image.removeAttribute('src');
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.element.remove();
  }
}
