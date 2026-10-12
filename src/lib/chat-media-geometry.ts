import type { MediaDimensions } from './media-dimensions';
import { motion, reducedMotion, travelFrames } from './motion';

const geometryEffects = new WeakMap<HTMLElement, Animation[]>();

/** Legacy media can learn its trusted dimensions after decode. Commit layout
 * once, then interpolate only the visual shell. Capsules stay 32px throughout. */
export function transitionChatMediaGeometry(element: HTMLElement, paint: () => void, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const before = element.getBoundingClientRect();
  geometryEffects.get(element)?.forEach(animation => animation.cancel());
  paint();
  const after = element.getBoundingClientRect();
  if (!element.isConnected || reducedMotion() || document.hidden || !before.width || !before.height || !after.width || !after.height
    || Math.abs(before.width-after.width)+Math.abs(before.height-after.height)<.5) return;
  const x = travelFrames(before.width/after.width,1,0,motion.media), y = travelFrames(before.height/after.height,1,0,motion.media);
  const options = {duration:motion.media,easing:'linear',fill:'backwards' as FillMode};
  const origin = element.style.transformOrigin; element.style.transformOrigin = 'top left';
  const effects = [element.animate(x.map((value,i)=>({transform:`scale(${value},${y[i]})`})),options)];
  for(const capsule of element.querySelectorAll<HTMLElement>('.message-meta,.media-upload-status,.media-load-capsule')) {
    capsule.style.transformOrigin = 'right bottom';
    const left = capsule.matches('.media-load-capsule') && Boolean(capsule.closest('.incoming'));
    effects.push(capsule.animate(x.map((value,i)=>({scale:`${1/value} ${1/y[i]!}`,translate:`${(left?-1:1)*(7-7/value)}px ${7-7/y[i]!}px`})),options));
  }
  geometryEffects.set(element,effects);
  const preference=matchMedia('(prefers-reduced-motion: reduce)');
  const finish=()=>{if(preference.matches||document.hidden)effects.forEach(effect=>{try{effect.finish();}catch{effect.cancel();}});};
  const cancel=()=>{effects.forEach(effect=>effect.cancel());element.style.transformOrigin=origin;};
  signal?.addEventListener('abort',cancel,{once:true});
  preference.addEventListener('change',finish);document.addEventListener('visibilitychange',finish);
  void Promise.allSettled(effects.map(effect=>effect.finished)).then(()=>{
    signal?.removeEventListener('abort',cancel);
    preference.removeEventListener('change',finish);document.removeEventListener('visibilitychange',finish);
    if(geometryEffects.get(element)===effects){element.style.transformOrigin=origin;geometryEffects.delete(element);}
  });
}

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
