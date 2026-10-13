/** Pick artwork size from measured content, retaining readable text and a scroll fallback. */
export function mountGatewayIntros(root: HTMLElement): () => void {
  let current: HTMLElement | null = null, resize: ResizeObserver | null = null, changes: MutationObserver | null = null;
  const fit = () => {
      const content = current?.querySelector<HTMLElement>('.gateway-intro-content');
      if (!current?.isConnected || !content) return;
      for (const size of ['large', 'small', 'none']) {
        current.dataset.hero = size;
        if (content.scrollHeight <= content.clientHeight + 1) break;
      }
  };
  const discover = () => {
    const next = root.querySelector<HTMLElement>(':scope > .gateway-intro');
    if (next === current) return;
    resize?.disconnect(); changes?.disconnect(); current = next;
    if (!current) return;
    const content = current.querySelector<HTMLElement>('.gateway-intro-content');
    const art = content?.querySelector<HTMLElement>(':scope > .entry-art, :scope > .gateway-mark');
    if (art) { const hero = document.createElement('div'); hero.className = 'gateway-entry-hero'; hero.setAttribute('aria-hidden', 'true'); art.before(hero); hero.append(art); }
    resize = new ResizeObserver(fit); resize.observe(current); if (content) resize.observe(content);
    changes = new MutationObserver(fit); if (content) changes.observe(content, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden'] });
    fit();
  };
  const observer = new MutationObserver(discover); observer.observe(root, { childList: true }); discover();
  return () => { resize?.disconnect(); changes?.disconnect(); observer.disconnect(); };
}
