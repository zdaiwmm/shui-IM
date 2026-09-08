import { createElement, X } from 'lucide';
import type { ImageManifest } from './types';
import { photoDetailGroups, type PhotoTags } from './photo-detail-model';
import { readPhotoMetadata } from './photo-metadata';

export function mountPhotoDetails(viewer: HTMLElement, options: {
  manifest: ImageManifest;
  sentAt?: string;
  signal: AbortSignal;
  load: () => Promise<{ blob: Blob; width?: number; height?: number }>;
  close: () => void;
}): () => void {
  const controller = new AbortController();
  const panel = document.createElement('section');
  panel.className = 'photo-details';
  panel.setAttribute('aria-label', '图片详情');
  panel.innerHTML = `<div class="photo-details-handle" aria-hidden="true"></div>
    <header><h2>图片详情</h2><button class="viewer-control" type="button" data-photo-details-close aria-label="收起图片详情" title="收起图片详情"></button></header>
    <p class="photo-details-status" role="status">正在读取图片属性</p>
    <div class="photo-details-content" tabindex="0" aria-label="图片属性"></div>`;
  const close = panel.querySelector<HTMLButtonElement>('[data-photo-details-close]')!;
  close.append(createElement(X));
  close.addEventListener('click', options.close);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); options.close(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation();
  });
  const content = panel.querySelector<HTMLElement>('.photo-details-content')!;
  const status = panel.querySelector<HTMLElement>('.photo-details-status')!;
  const render = (tags: PhotoTags, dimensions?: { width: number; height: number }) => {
    const sections = photoDetailGroups(options.manifest, options.sentAt, tags, dimensions).map(group => {
      const section = document.createElement('section');
      const title = document.createElement('h3');
      title.textContent = group.title;
      const list = document.createElement('dl');
      for (const row of group.rows) {
        const wrapper = document.createElement('div');
        const label = document.createElement('dt');
        label.textContent = row.label;
        const value = document.createElement('dd');
        value.textContent = row.value;
        value.classList.toggle('is-missing', row.value === '未记录');
        wrapper.append(label, value);
        list.append(wrapper);
      }
      section.append(title, list);
      return section;
    });
    content.replaceChildren(...sections);
  };
  const cleanup = () => {
    options.signal.removeEventListener('abort', cleanup);
    controller.abort();
    panel.remove();
    viewer.classList.remove('has-photo-details');
  };
  options.signal.addEventListener('abort', cleanup, { once: true });
  viewer.append(panel);
  viewer.classList.add('has-photo-details');
  close.focus({ preventScroll: true });
  void (async () => {
    try {
      const cached = await options.load();
      controller.signal.throwIfAborted();
      const metadata = await readPhotoMetadata(cached.blob, controller.signal);
      controller.signal.throwIfAborted();
      if (!viewer.isConnected) return;
      const image = viewer.querySelector<HTMLImageElement>('.viewer-media-layer:not([inert]) img');
      const width = cached.width ?? image?.naturalWidth;
      const height = cached.height ?? image?.naturalHeight;
      render(metadata.tags, width && height ? { width, height } : undefined);
      status.textContent = metadata.unavailable ? '无法读取内嵌属性，已显示文件信息' : '';
      status.hidden = !metadata.unavailable;
    } catch {
      if (controller.signal.aborted || !panel.isConnected) return;
      render({});
      status.textContent = '图片属性读取失败';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', () => { options.close(); viewer.querySelector<HTMLButtonElement>('[data-viewer-details]')?.click(); });
      status.append(retry);
    }
  })();
  return cleanup;
}
