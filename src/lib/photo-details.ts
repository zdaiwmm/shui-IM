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
}): (animate?: boolean) => void {
  const controller = new AbortController();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  viewer.querySelectorAll<HTMLElement>('.photo-details.is-closing, .photo-details-backdrop.is-closing').forEach(element => element.remove());
  const backdrop = document.createElement('div');
  backdrop.className = 'photo-details-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.addEventListener('click', options.close);
  const panel = document.createElement('section');
  panel.className = 'photo-details is-opening';
  panel.addEventListener('animationend', event => { if (event.animationName === 'photo-details-enter') panel.classList.remove('is-opening'); });
  panel.setAttribute('aria-label', '图片详情');
  panel.innerHTML = `<button class="photo-details-handle" type="button" aria-label="展开全屏图片详情" aria-expanded="false"></button>
    <header><h2>图片详情</h2><button class="viewer-control" type="button" data-photo-details-close aria-label="收起图片详情" title="收起图片详情"></button></header>
    <p class="photo-details-status" role="status">正在读取图片属性</p>
    <div class="photo-details-content" tabindex="0" aria-label="图片属性"></div>`;
  const close = panel.querySelector<HTMLButtonElement>('[data-photo-details-close]')!;
  const expandButton = panel.querySelector<HTMLButtonElement>('.photo-details-handle')!;
  close.append(createElement(X));
  close.addEventListener('click', options.close);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); options.close(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation();
    if (event.key === 'Tab' && panel.classList.contains('is-expanded')) {
      event.stopPropagation();
      const targets = [...panel.querySelectorAll<HTMLElement>('button, [tabindex="0"]')];
      const index = targets.indexOf(document.activeElement as HTMLElement);
      if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === targets.length - 1)) {
        event.preventDefault();
        targets[event.shiftKey ? targets.length - 1 : 0]?.focus({ preventScroll: true });
      }
    }
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
  let closing = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeAnimation: Animation | undefined;
  let suppressExpandClickUntil = 0;
  const destroy = () => {
    clearTimeout(closeTimer);
    resizeAnimation?.cancel();
    options.signal.removeEventListener('abort', destroy);
    controller.abort();
    panel.remove();
    backdrop.remove();
    if (!viewer.querySelector('.photo-details')) viewer.classList.remove('has-photo-details');
  };
  const cleanup = (animate = false) => {
    if (!animate || reducedMotion) { destroy(); return; }
    if (closing) return;
    closing = true;
    controller.abort();
    const transform = getComputedStyle(panel).transform;
    resizeAnimation?.cancel();
    panel.style.setProperty('--details-drag', `${transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42}px`);
    panel.classList.remove('is-opening');
    panel.inert = true;
    panel.classList.add('is-closing');
    backdrop.classList.add('is-closing');
    closeTimer = setTimeout(destroy, 520);
  };
  options.signal.addEventListener('abort', destroy, { once: true });
  const expand = () => {
    if (closing || panel.classList.contains('is-expanded')) return;
    const top = panel.getBoundingClientRect().top;
    panel.classList.remove('is-opening');
    panel.classList.add('is-expanded');
    expandButton.setAttribute('aria-expanded', 'true');
    expandButton.setAttribute('aria-disabled', 'true');
    if (!reducedMotion) resizeAnimation = panel.animate([
      { transform: `translateY(${top - panel.getBoundingClientRect().top}px)` }, { transform: 'translateY(0)' },
    ], { duration: 620, easing: 'cubic-bezier(.22,.7,.18,1)' });
  };
  expandButton.addEventListener('click', () => { if (performance.now() >= suppressExpandClickUntil) expand(); });
  let drag: { x: number; y: number; offset: number; distance: number; content: boolean; allowed: boolean } | undefined;
  const beginDrag = (x: number, y: number, target: EventTarget | null) => {
    if (closing || (target instanceof Element && target.closest('button') && target !== expandButton)) return;
    const transform = getComputedStyle(panel).transform;
    const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
    resizeAnimation?.cancel();
    resizeAnimation = undefined;
    panel.style.setProperty('--details-drag', `${offset}px`);
    drag = { x, y, offset, distance: 0, content: content.contains(target as Node), allowed: !content.contains(target as Node) || content.scrollTop <= 0 };
  };
  const moveDrag = (x: number, y: number, event: Event) => {
    if (!drag?.allowed) return;
    const distance = y - drag.y;
    if ((distance < 0 && drag.content) || Math.abs(x - drag.x) > Math.max(8, Math.abs(distance))) { drag.allowed = false; return; }
    if (Math.abs(distance) < 8) return;
    if (event.cancelable) event.preventDefault();
    drag.distance = distance;
    if (distance < 0 && !panel.classList.contains('is-expanded')) {
      const top = panel.getBoundingClientRect().top;
      panel.classList.add('is-expanded');
      drag.offset += top - panel.getBoundingClientRect().top;
      expandButton.setAttribute('aria-expanded', 'true');
      expandButton.setAttribute('aria-disabled', 'true');
    }
    panel.classList.remove('is-opening');
    panel.classList.add('is-dragging');
    panel.style.setProperty('--details-drag', `${Math.max(0, drag.offset + distance)}px`);
  };
  const endDrag = (cancel = false) => {
    const distance = drag?.distance ?? 0;
    if (distance) suppressExpandClickUntil = performance.now() + 400;
    drag = undefined;
    panel.classList.remove('is-dragging');
    if (!cancel && distance >= Math.min(100, panel.clientHeight * 0.22)) options.close();
    else panel.style.setProperty('--details-drag', '0px');
  };
  panel.addEventListener('touchstart', event => {
    if (event.touches.length === 1) beginDrag(event.touches[0]!.clientX, event.touches[0]!.clientY, event.target);
    else endDrag(true);
  }, { passive: true });
  panel.addEventListener('touchmove', event => {
    if (event.touches.length === 1) moveDrag(event.touches[0]!.clientX, event.touches[0]!.clientY, event);
  }, { passive: false });
  panel.addEventListener('touchend', () => endDrag());
  panel.addEventListener('touchcancel', () => endDrag(true));
  panel.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || content.contains(event.target as Node)) return;
    beginDrag(event.clientX, event.clientY, event.target);
    if (drag) panel.setPointerCapture(event.pointerId);
  });
  panel.addEventListener('pointermove', event => { if (event.pointerType === 'mouse') moveDrag(event.clientX, event.clientY, event); });
  panel.addEventListener('pointerup', event => { if (event.pointerType === 'mouse') endDrag(); });
  panel.addEventListener('pointercancel', event => { if (event.pointerType === 'mouse') endDrag(true); });
  viewer.append(backdrop, panel);
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
