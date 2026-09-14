import type { MediaDimensions } from './media-dimensions';

/** Original geometry shared by loading, uploaded and decoded chat media. */
export function setChatMediaDimensions(element: HTMLElement, { width, height }: MediaDimensions): void {
  element.dataset.mediaDimensions = 'known';
  element.style.setProperty('--chat-media-aspect', `${width} / ${height}`);
  element.style.setProperty('--chat-media-ratio', String(width / height));
  element.style.setProperty('--chat-media-source-width', `${width}px`);
  element.style.setProperty('--chat-expression-natural-width', `${width * 2 / 3}px`);
  element.style.setProperty('--chat-media-height-width', `calc(min(42svh, 320px) * ${width / height})`);
  element.style.setProperty('--chat-expression-height-width', `calc(min(28svh, 213.333px) * ${width / height})`);
}
