import type { MediaDimensions } from './media-dimensions';

/** GIFs use 60% of the sticker box. Sticker natural width is already 2/3 of the source. */
export const GIF_STICKER_SCALE = 0.6;
export const GIF_NATURAL_SCALE = (2 / 3) * GIF_STICKER_SCALE;
export const GIF_MAX_WIDTH_PX = 192 * GIF_STICKER_SCALE;
export const GIF_MAX_HEIGHT = 'min(16.8svh, 128px)';

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

/** Inline GIF limits so the message list cannot fall back to the sticker box. */
export function applyGifDisplayGeometry(element: HTMLElement): void {
  const ratio = element.style.getPropertyValue('--chat-media-ratio');
  const source = element.style.getPropertyValue('--chat-media-source-width');
  element.style.setProperty('--chat-media-max-width', `${GIF_MAX_WIDTH_PX}px`);
  element.style.setProperty('--chat-media-max-height', GIF_MAX_HEIGHT);
  if (source) element.style.setProperty('--chat-media-natural-width', `calc(${source} * ${GIF_NATURAL_SCALE})`);
  if (ratio) element.style.setProperty('--chat-media-width-at-max-height', `calc(${GIF_MAX_HEIGHT} * ${ratio})`);
}
