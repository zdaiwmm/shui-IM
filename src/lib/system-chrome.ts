/** Browser chrome is a color hint; the document edge remains the fallback. */
export function mountSystemChrome(root: HTMLElement): () => void {
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    const theme = document.querySelector<HTMLMetaElement>('#system-chrome-color');
    const viewing = Boolean(root.querySelector(':scope > .image-viewer'));
    document.documentElement.dataset.colorScheme = scheme.matches ? 'dark' : 'light';
    if (!theme) return;
    if (!viewing) { theme.content = 'transparent'; return; }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) { theme.content = 'transparent'; return; }
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    theme.content = `rgb(${red}, ${green}, ${blue})`;
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { childList: true });
  scheme.addEventListener('change', sync);
  sync();
  return () => { observer.disconnect(); scheme.removeEventListener('change', sync); };
}
