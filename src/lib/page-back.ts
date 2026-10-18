import '../page-back.css';

const pages = '.gateway,.pairing-screen,.device-shell,.recovery-flow-page,.backup-page,.gallery-shell,.image-detail,.space-profile-page,.space-drawer,.passkey-manager,.password-page';

/** Move the existing page action, preserving its business handler and label. */
export function mountPageBacks(root: HTMLElement): void {
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
    button.classList.add('page-back-button'); button.type = 'button';
    button.textContent = '返回';
    footer.append(button); page.append(footer);
    if (previousParent?.tagName === 'FOOTER' && !previousParent.children.length && !previousParent.textContent?.trim()) previousParent.remove();
  };
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLButtonElement) normalize(node);
    node.querySelectorAll<HTMLButtonElement>('button').forEach(normalize);
  };
  scan(root);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) scan(node);
  }).observe(root, {childList:true,subtree:true});
}
