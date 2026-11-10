import { ChevronRight, Ellipsis, createElement } from 'lucide';
import { mountDialog } from './dialog';
import { uiLiteral } from './language';

export const noticeExitMs = 190;
const mounted = new WeakSet<HTMLElement>();

function noticeItems(rail: HTMLElement): HTMLElement[] {
  return [...rail.children].filter((item): item is HTMLElement =>
    item instanceof HTMLElement && !item.hidden && !item.hasAttribute('data-rail-decoration'));
}

function titleOf(item: HTMLElement): string {
  return item.querySelector('strong')?.textContent?.trim() || item.textContent?.trim() || '';
}

/** Keep original actions as the owners of their state, permissions and side effects. */
function showDetails(root: HTMLElement, rail: HTMLElement, sources: HTMLElement[]) {
  const sheet = document.createElement('section');
  sheet.className = 'confirm-overlay notice-detail-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', uiLiteral('提示详情'));
  sheet.innerHTML = uiLiteral('<div class="confirm-dialog"><h2>提示详情</h2><div class="notice-detail-list"></div><button class="secondary-button" type="button" data-close>关闭</button></div>');
  const list = sheet.querySelector('.notice-detail-list')!;
  const active = () => rail.isConnected && !document.hidden && root.getAttribute('aria-hidden') !== 'true';
  root.append(sheet);
  const dialog = mountDialog(sheet, {isActive:active, presentation:'sheet'});
  for (const item of sources) {
    const section = document.createElement('section');
    const title = document.createElement('strong');
    title.textContent = titleOf(item);
    section.append(title);
    for (const field of item.querySelectorAll('.pinned-recovery-content > span, .upload-reminder > div > span')) {
      if (!field.textContent || field.textContent === title.textContent) continue;
      const p = document.createElement('p'); p.textContent = field.textContent; section.append(p);
    }
    for (const action of item.querySelectorAll<HTMLButtonElement>('button:not([hidden], :disabled, .notice-summary)')) {
      const label = action.getAttribute('aria-label') || action.querySelector('strong')?.textContent || action.textContent;
      if (!label) continue;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary-button'; button.textContent = label;
      button.addEventListener('click', () => {
        dialog.close({animate:false, restoreFocus:false});
        if (active() && rail.contains(action) && !item.hidden && !action.disabled && !action.hidden) action.click();
      });
      section.append(button);
    }
    list.append(section);
  }
  sheet.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
}

export function mountNoticeRail(root: HTMLElement, rail: HTMLElement): HTMLElement {
  if (mounted.has(rail)) return rail;
  mounted.add(rail);
  rail.classList.add('notice-rail');
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'notice-more'; more.dataset.railDecoration = '';
  more.setAttribute('aria-label', uiLiteral('提示详情')); more.hidden = true;
  more.append(createElement(Ellipsis)); rail.append(more);
  const items = () => noticeItems(rail).sort((a,b) => Number(b.dataset.noticePriority ?? 10) - Number(a.dataset.noticePriority ?? 10));
  more.addEventListener('click', () => showDetails(root, rail, items()));
  let current: HTMLElement | undefined;
  let lastLabel = '';
  let ghost: HTMLElement | undefined;
  function refresh() {
    const available = items();
    const next = available[0];
    const pending = available.filter(item => !item.matches('.app-toast,.chat-history-loading,.hidden-album-hint'));
    const hideMore = pending.length < 2 || next?.matches('.app-toast,.chat-history-loading') === true;
    more.dataset.count = String(pending.length);
    if (more.hidden !== hideMore) more.hidden = hideMore;
    if (current !== next) {
      current?.removeAttribute('data-rail-current');
      ghost?.remove();
      if (current && !current.matches('.app-toast') && lastLabel && rail.isConnected && !document.hidden && root.getAttribute('aria-hidden') !== 'true') {
        const leaving = document.createElement('div');
        leaving.className = 'notice-ghost'; leaving.dataset.railDecoration = '';
        leaving.setAttribute('aria-hidden','true'); leaving.inert = true;
        const text = document.createElement('span'); text.textContent = lastLabel;
        leaving.append(text); rail.append(leaving); ghost = leaving;
        window.setTimeout(() => leaving.remove(), noticeExitMs);
      }
      current = next;
      if (next) next.dataset.railCurrent = '';
    }
    if (current && current.hasAttribute('data-notice-details') && !current.querySelector(':scope > .notice-summary')) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'notice-summary';
      const label = document.createElement('span'); label.textContent = titleOf(current);
      button.append(label,createElement(ChevronRight)); current.prepend(button);
      const source = current;
      button.addEventListener('click', () => showDetails(root, rail, [source]));
    }
    lastLabel = current ? titleOf(current) : '';
  }
  // Observe this short list only. Progress text updates leave the active node and animation intact.
  const observer = new MutationObserver(refresh);
  observer.observe(rail, {childList:true,subtree:true,attributes:true,attributeFilter:['hidden','data-notice-priority']});
  refresh();
  return rail;
}

function alignPageRail(header: HTMLElement, rail: HTMLElement) {
  // Reserve the actual back/close/action targets (including localized labels).
  const rect = header.getBoundingClientRect();
  const mid = rect.left + rect.width / 2;
  let left = 8, right = 8;
  let center = rect.height / 2;
  for (const button of header.querySelectorAll<HTMLElement>('button,a[href],[role=button]')) {
    if (rail.contains(button) || button.closest('[role=tablist]') || !button.getClientRects().length) continue;
    const box = button.getBoundingClientRect();
    center = (box.top + box.bottom) / 2 - rect.top;
    if ((box.left + box.right) / 2 < mid) left = Math.max(left,box.right - rect.left + 4);
    else right = Math.max(right,rect.right - box.left + 4);
  }
  rail.style.setProperty('--notice-left', left+'px');
  rail.style.setProperty('--notice-right', right+'px');
  rail.style.setProperty('--notice-center', center+'px');
}

/** Bind feedback to the visible page. Overlays own their rail while chat is covered. */
export function currentNoticeRail(root: HTMLElement): HTMLElement {
  const page = [...root.children].reverse().find((child): child is HTMLElement =>
    child instanceof HTMLElement && !child.hidden && !child.inert &&
    !child.matches('.notice-rail,.desktop-sidebar,.is-closing,.page-transition-outgoing,.local-page-outgoing,.privacy-curtain') && child.getClientRects().length > 0);
  const surface = page ?? root;
  const chat = surface.matches('.chat-shell') ? surface.querySelector<HTMLElement>('.system-notices') : null;
  if (chat) return mountNoticeRail(root,chat);
  // Form prompts and sheet section headings are content, even when marked up as headers.
  const navigation = '.subpage-header,.chat-header,.space-drawer-header,.space-profile-header,.reader-header,.viewer-header,.recovery-flow-nav';
  const header = [...surface.querySelectorAll<HTMLElement>(navigation)].find(node =>
    !node.closest('[inert],.is-closing,.local-page-outgoing') && node.getClientRects().length > 0);
  const parent = header ?? surface;
  let rail = parent.querySelector<HTMLElement>(':scope > .page-notice-rail');
  if (!rail) {
    rail = document.createElement('div'); rail.className = 'page-notice-rail';
    if (header) {
      if (getComputedStyle(header).position === 'static') header.classList.add('notice-page-relative');
      header.classList.add('notice-page-header');
    }
    parent.append(rail);
    if (header) {
      const slot = rail;
      const observer = new ResizeObserver(() => {
        if (!slot.isConnected) { observer.disconnect(); return; }
        alignPageRail(header,slot);
      });
      observer.observe(header);
    }
  }
  if (header) {
    alignPageRail(header,rail);
  }
  return mountNoticeRail(root,rail);
}
