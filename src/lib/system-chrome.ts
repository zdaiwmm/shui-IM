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
    // Media viewers retain their existing native toolbar treatment.
    const color = document.querySelector('.image-viewer,.video-viewer') ? 'transparent' : getComputedStyle(probe).color;
    if (theme && theme.content !== color) theme.content = color;
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes:true, attributeFilter:['class','data-theme','data-color-scheme'] });
  observer.observe(document.body, { childList:true, attributes:true, attributeFilter:['class'] });
  const app = document.querySelector('#app');
  if (app) observer.observe(app, { childList:true });
  window.addEventListener('appearancechange', sync);
  sync();
  return () => { observer.disconnect(); window.removeEventListener('appearancechange', sync); probe.remove(); };
}
