import { motion, reducedMotion, travelFrames } from './motion';

type Effect = { animations: Animation[]; widths: number[]; duration: number };
const effects = new WeakMap<HTMLElement, Effect>();

export function clearMediaCapsule(host: HTMLElement): void {
  effects.get(host)?.animations.forEach(animation => animation.cancel());
  effects.delete(host);
  host.querySelectorAll(':scope > .media-capsule-retiring').forEach(layer => layer.remove());
}

/** A persistent 32px shell. Only its width transforms; text and icons receive
 * the inverse scale. State changes can interrupt without an empty frame. */
export function transitionMediaCapsule(host: HTMLElement, paint: () => void, contentChanged = true, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const oldWidth = host.getBoundingClientRect().width;
  const oldBackground = getComputedStyle(host).backgroundColor;
  let content = host.querySelector<HTMLElement>(':scope > .media-capsule-content');
  if (!content) {
    content = document.createElement('div'); content.className = 'media-capsule-content';
    content.append(...host.childNodes); host.append(content);
  }
  if (!contentChanged) {
    // Progress often arrives several times per frame. Preserve a running
    // transition when its destination geometry has not changed.
    paint();
    if (Math.abs(content.offsetWidth - host.offsetWidth) < 1) return;
  }
  const previous = effects.get(host);
  const time = Number(previous?.animations[0]?.currentTime ?? 0);
  const index = previous ? Math.min(59, Math.max(0, Math.floor(time / previous.duration * 60))) : 0;
  const velocity = previous && previous.animations[0]?.playState === 'running'
    ? (previous.widths[index + 1]! - previous.widths[index]!) * 60 * 1000 / previous.duration : 0;
  const retiring = document.createElement('div'); retiring.className = 'media-capsule-retiring';
  retiring.inert = true; retiring.setAttribute('aria-hidden', 'true');
  if (contentChanged && host.isConnected) for (const layer of [content]) {
    const clone = layer.cloneNode(true) as HTMLElement;
    const style = getComputedStyle(layer);
    // A rapid stage change can interrupt the incoming label near opacity 0.
    // Keep a fully painted outgoing label while its replacement fades in.
    clone.style.opacity = '1'; clone.style.color = style.color; clone.style.font = style.font;
    clone.style.transform = 'none'; clone.style.scale = 'none';
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    retiring.append(clone);
  }
  clearMediaCapsule(host);
  host.style.width = ''; paint();
  const width = host.getBoundingClientRect().width;
  if (!oldWidth || !width || reducedMotion() || document.hidden || !host.isConnected) return;
  if (!contentChanged && Math.abs(width - oldWidth) < .1) return;
  host.style.width = `${width}px`;
  const widths = travelFrames(oldWidth, width, velocity, motion.panel).map(value => Math.max(1,value));
  const options = { duration: motion.panel, easing: 'linear', fill: 'backwards' as FillMode };
  const animations = [host.animate(widths.map(value => ({ transform: `scaleX(${value / width})` })), options),
    content.animate(widths.map(value => ({ scale: `${width / Math.max(1,value)} 1` })), options)];
  const background = getComputedStyle(host).backgroundColor;
  if (oldBackground !== background) animations.push(host.animate([{backgroundColor:oldBackground},{backgroundColor:background}],{duration:motion.local,fill:'backwards'}));
  if (contentChanged) {
    host.append(retiring);
    animations.push(retiring.animate(widths.map(value => ({ scale: `${width / Math.max(1,value)} 1` })), options));
    animations.push(retiring.animate([{opacity:1},{opacity:0}], {duration:motion.local,fill:'both'}));
    animations.push(content.animate([{opacity:0},{opacity:1}], {duration:motion.local,fill:'backwards'}));
  }
  const effect = { animations, widths, duration: motion.panel }; effects.set(host,effect);
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const finish = () => { if (preference.matches || document.hidden) animations.forEach(animation => { try { animation.finish(); } catch { animation.cancel(); } }); };
  const cancel = () => clearMediaCapsule(host);
  signal?.addEventListener('abort',cancel,{once:true});
  preference.addEventListener('change',finish); document.addEventListener('visibilitychange',finish);
  void Promise.allSettled(animations.map(animation=>animation.finished)).then(()=>{
    signal?.removeEventListener('abort',cancel);
    preference.removeEventListener('change',finish); document.removeEventListener('visibilitychange',finish);
    retiring.remove(); if(effects.get(host)===effect)effects.delete(host);
  });
}

/** Loaded content replaces progress without a blank flash. Privacy owners can
 * synchronously abort and remove the retiring label. */
export function retireMediaCapsule(host: HTMLElement, signal?: AbortSignal): void {
  const width = host.getBoundingClientRect().width;
  clearMediaCapsule(host); host.style.width = `${width}px`;
  host.inert = true; host.setAttribute('aria-hidden','true');
  const effect = host.animate([{opacity:1},{opacity:0}],{duration:reducedMotion()?0:motion.local,fill:'forwards'});
  const clear = () => { effect.cancel(); host.remove(); signal?.removeEventListener('abort',clear); };
  signal?.addEventListener('abort',clear,{once:true});
  if(signal?.aborted)clear(); else void effect.finished.then(clear,clear);
}
