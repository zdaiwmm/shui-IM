import { mountAppearance } from './appearance';
/** Match the browser's top color hint to the same opaque surface as the header.
 * The CSS canvas still owns the independent bottom safe area. */
export function mountSystemChrome(): () => void {
  mountAppearance();
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;color:var(--chrome-top-surface)';
  document.body.append(probe);
  const sync = () => {
    const theme = document.querySelector<HTMLMetaElement>('#system-chrome-color');
    // Keep the video surface opaque through maximization and native handoff.
    const color = document.querySelector('.image-viewer:not(.video-viewer)') ? 'transparent' : getComputedStyle(probe).color;
    if (theme && theme.content !== color) theme.content = color;
  };
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); }); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { attributes:true, attributeFilter:['class','data-theme','data-color-scheme'] });
  observer.observe(document.body, { childList:true, attributes:true, attributeFilter:['class'] });
  const app = document.querySelector('#app');
  if (app) observer.observe(app, { childList:true, subtree:true, attributes:true, attributeFilter:['class','data-presentation','data-safe-viewer'] });
  window.addEventListener('appearancechange', sync);
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', sync);
  sync();
  return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('appearancechange', sync); document.removeEventListener('focusin', sync); document.removeEventListener('focusout', sync); probe.remove(); };
}
