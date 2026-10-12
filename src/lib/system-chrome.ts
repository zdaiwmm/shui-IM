import { mountAppearance } from './appearance';
/** Top and bottom can be different. The canonical canvas stylesheet owns
 * those surfaces; a transparent hint lets Safari sample each native edge. */
export function mountSystemChrome(): () => void {
  mountAppearance();
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    const theme = document.querySelector<HTMLMetaElement>('#system-chrome-color');
    if (theme) theme.content = 'transparent';
  };
  scheme.addEventListener('change', sync);
  sync();
  return () => scheme.removeEventListener('change', sync);
}
