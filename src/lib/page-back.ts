import '../page-back.css';

const pages = '.gateway,.pairing-screen,.device-shell,.recovery-flow-page,.backup-page,.gallery-shell,.image-detail,.space-profile-page,.space-drawer,.passkey-manager,.password-page';

/** Move the existing page action, preserving its business handler and label. */
export function mountPageBacks(root: HTMLElement): void {
  const footers = new Map<HTMLElement, HTMLElement>();
  const resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      const footer = entry.target as HTMLElement, page = footers.get(footer);
      if (page?.isConnected) page.style.setProperty('--page-back-height', `${footer.offsetHeight}px`);
    }
  });
  const normalize = (button: HTMLButtonElement) => {
    if (button.classList.contains('page-back-button') || button.classList.contains('page-back-duplicate')) return;
    const label = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
    if (!/^返回/u.test(label)) return;
    if (button.closest('.confirm-overlay:not(.password-page),.space-modal-overlay,.form-input-overlay,.page-transition-outgoing')) return;
    const page = button.closest<HTMLElement>(pages);
    if (!page || page.classList.contains('numeric-password-page')) return;
    let footer = page.querySelector<HTMLElement>(':scope > .page-back-footer');
    if (footer) { button.classList.add('page-back-duplicate'); return; }
    if (button.closest('header')) { const placeholder = document.createElement('span'); placeholder.setAttribute('aria-hidden','true'); button.before(placeholder); }
    page.classList.add('page-back-page');
    footer = document.createElement('footer'); footer.className = 'page-back-footer';
    const previousParent = button.parentElement;
    const actions:HTMLButtonElement[]=[];
    if(previousParent?.matches('footer,.welcome-actions,.chamber-import-actions')||previousParent===page&&page.classList.contains('gateway')) {
      let sibling=button.previousElementSibling;
      while(sibling instanceof HTMLButtonElement&&sibling.matches('.primary-button,.secondary-button,.text-button')) {
        const form=sibling.form;
        if(form){form.id ||= `page-form-${crypto.randomUUID()}`;sibling.setAttribute('form',form.id);}
        actions.unshift(sibling);sibling=sibling.previousElementSibling;
      }
    }
    button.classList.add('page-back-button'); button.type = 'button';
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', label);
    button.textContent = '返回';
    footer.append(...actions,button); page.append(footer);
    page.style.setProperty('--page-back-height', `${footer.offsetHeight}px`);
    footers.set(footer, page); resize.observe(footer);
    if (previousParent?.tagName === 'FOOTER' && !previousParent.children.length && !previousParent.textContent?.trim()) previousParent.remove();
  };
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLButtonElement) normalize(node);
    node.querySelectorAll<HTMLButtonElement>('button').forEach(normalize);
  };
  scan(root);
  new MutationObserver(records => {
    for (const [footer, page] of footers) if (!root.contains(page) || !page.contains(footer)) { resize.unobserve(footer); footers.delete(footer); }
    for (const record of records) for (const node of record.addedNodes) scan(node);
  }).observe(root, {childList:true,subtree:true});
}
