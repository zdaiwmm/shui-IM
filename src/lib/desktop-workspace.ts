import { createElement, PanelLeftOpen } from 'lucide';

export const desktopWidth = '(min-width: 1024px)';
const pages = '.chat-shell,.gallery-shell,.device-shell,.backup-page,.recovery-flow-page,.image-detail,.desktop-settings-page,.save-entry-page,.cover-practice-page';

/** Layout only: the caller owns authentication, one active room and all cleanup. */
export class DesktopWorkspace {
  private readonly media = matchMedia(desktopWidth);
  private host: HTMLElement | null = null;
  private lifetime: AbortController | null = null;
  private owner: object | null = null;
  private collapsed = false;
  private page: HTMLElement | null = null;
  constructor(private root: HTMLElement, private options: {
    context: () => { owner: object; signal: AbortSignal } | null;
    mount: (host: HTMLElement, signal: AbortSignal) => Promise<void>;
    beforeLayout: () => (() => void);
  }) {
    new MutationObserver(() => this.sync()).observe(root, { childList: true });
    this.media.addEventListener('change', () => this.sync());
    root.addEventListener('click', event => {
      if (!this.active || !(event.target instanceof Element) || !event.target.closest('#open-spaces,#access-spaces,.desktop-sidebar-toggle')) return;
      event.preventDefault(); event.stopImmediatePropagation(); this.toggle();
    }, { capture: true });
  }
  get active() { return this.root.dataset.desktopWorkspace === 'true'; }
  collapse() { this.collapsed = true; this.sync(); this.focusToggle(); }
  private toggle() { this.collapsed = !this.collapsed; this.sync(); this.focusToggle(); }
  private focusToggle() {
    const selector = this.collapsed ? '#open-spaces,#access-spaces,.desktop-sidebar-toggle' : '.desktop-sidebar .space-close';
    this.root.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
  }
  clear() {
    this.lifetime?.abort(); this.lifetime = null; this.host?.remove(); this.host = null;
    this.owner = null; this.page = null; delete this.root.dataset.desktopWorkspace; delete this.root.dataset.sidebarCollapsed;
  }
  sync() {
    const context = this.options.context();
    const page = [...this.root.children].find((node): node is HTMLElement => node instanceof HTMLElement && node.matches(pages) && !node.classList.contains('page-transition-outgoing'));
    if (!context || context.signal.aborted || !page) { this.clear(); return; }
    const wide = this.media.matches;
    const changed = this.active !== wide || this.root.dataset.sidebarCollapsed !== String(this.collapsed) || this.page !== page;
    const restore = changed ? this.options.beforeLayout() : () => {};
    this.page = page;
    this.root.dataset.desktopWorkspace = String(wide);
    this.root.dataset.sidebarCollapsed = String(this.collapsed);
    if (this.host && (!this.host.isConnected || this.owner !== context.owner)) {
      this.lifetime?.abort(); this.host.remove(); this.host = null;
    }
    if (!wide && this.host) { this.lifetime?.abort(); this.host.remove(); this.host = null; }
    if (wide && !this.host) {
      const host = document.createElement('aside'); host.className = 'desktop-sidebar'; host.setAttribute('aria-label', '私密空间导航');
      this.host = host; this.owner = context.owner; this.lifetime = new AbortController();
      const signal = AbortSignal.any([context.signal, this.lifetime.signal]);
      signal.addEventListener('abort', () => host.remove(), { once: true });
      this.root.append(host);
      void this.options.mount(host, signal).catch(() => {
        if (signal.aborted || !host.isConnected) return;
        host.innerHTML = '<p role="alert">空间列表暂不可用</p><button type="button" class="secondary-button">重试</button>';
        host.querySelector('button')!.addEventListener('click', () => { this.lifetime?.abort(); this.host = null; this.sync(); });
      });
    }
    if (this.host) { this.host.hidden = !wide || this.collapsed; this.host.inert = Boolean(this.root.querySelector(':scope > [aria-modal="true"]:not(.is-closing)')); }
    const header = page.querySelector<HTMLElement>('.chat-header,.subpage-header,.gallery-header,.space-drawer-header,header');
    if (wide && header && !header.querySelector('#open-spaces,#access-spaces,.desktop-sidebar-toggle')) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button desktop-sidebar-toggle';
      button.innerHTML = createElement(PanelLeftOpen).outerHTML; header.prepend(button);
    }
    page.querySelectorAll<HTMLElement>('#open-spaces,#access-spaces,.desktop-sidebar-toggle').forEach(button => {
      if (!wide) { if (button.classList.contains('desktop-sidebar-toggle')) button.remove(); return; }
      button.setAttribute('aria-label', this.collapsed ? '展开空间侧栏' : '收起空间侧栏');
      button.setAttribute('aria-expanded', String(!this.collapsed));
    });
    restore();
  }
}
