import { mountAppearance } from './appearance';
/** Let browser chrome sample the page without forcing an opaque toolbar tint. */
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
