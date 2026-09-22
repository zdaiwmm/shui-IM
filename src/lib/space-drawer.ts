import { mountDialog } from './dialog';
import type { PrivateSpace } from './spaces';
import { createElement, Settings2, PanelsTopLeft, Smartphone, KeyRound, Upload, Download, EyeOff, History, Heart, Pencil, Check, X, Plus, ChevronRight } from 'lucide';
export type PresenceStyle = 'capsule' | 'heart';
export function readPresenceStyle(): PresenceStyle { try { return localStorage.getItem('quiet-room:presence-style') === 'heart' ? 'heart' : 'capsule'; } catch { return 'capsule'; } }
export function writePresenceStyle(style: PresenceStyle): void { localStorage.setItem('quiet-room:presence-style', style); }
export const spaceIcons = {
  settings: createElement(Settings2).outerHTML, spaces: createElement(PanelsTopLeft).outerHTML,
  device: createElement(Smartphone).outerHTML, key: createElement(KeyRound).outerHTML,
  upload: createElement(Upload).outerHTML, download: createElement(Download).outerHTML,
  cover: createElement(EyeOff).outerHTML, history: createElement(History).outerHTML,
};
const arrow = createElement(ChevronRight).outerHTML, check = createElement(Check).outerHTML, heart = createElement(Heart).outerHTML;
const closeIcon = createElement(X).outerHTML;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
type Action = { id: string; label: string; icon: string; group?: '当前空间' | '本机' | '关于'; run: () => void };

/** Follow the visual viewport when the native keyboard opens, without resizing the chat. */
function fitViewport(element: HTMLElement, signal: AbortSignal) {
  const fit = () => {
    const viewport = window.visualViewport;
    element.style.top = `${viewport?.offsetTop ?? 0}px`;
    element.style.height = `${viewport?.height ?? innerHeight}px`;
  };
  fit();
  window.visualViewport?.addEventListener('resize', fit, { signal });
  window.visualViewport?.addEventListener('scroll', fit, { signal });
  window.addEventListener('resize', fit, { signal });
}

export function mountSpaceDrawer(root: HTMLElement, options: {
  spaces: PrivateSpace[]; currentRoom: string; signal: AbortSignal; actions: Action[]; icons?: { close: string; plus: string; settings: string };
  select: (space: PrivateSpace) => Promise<void>; create: () => Promise<void>; rename: (space: PrivateSpace, name: string) => Promise<void>;
  refreshUnread?: (signal: AbortSignal) => Promise<void>;
  styleChanged: (style: PresenceStyle) => void; closed: () => void;
}): void {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const sheet = document.createElement('div'); sheet.className = 'space-drawer-overlay'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', '私密空间');
  root.append(sheet);
  let styleDirty = false, busy = false, listScrollTop = 0;
  const dialog = mountDialog(sheet, { signal: options.signal, isActive: () => !options.signal.aborted, onClose: () => {
    lifetime.abort(); options.closed();
    if (styleDirty && !options.signal.aborted) options.styleChanged(readPresenceStyle());
  } });
  const close = () => dialog.close();
  sheet.addEventListener('click', e => { if (e.target === sheet && !busy) close(); });
  function page(title: string, body: string, footer = '', back?: () => void) {
    if (sheet.querySelector('.space-list')) listScrollTop = sheet.querySelector('.space-drawer-scroll')!.scrollTop;
    sheet.setAttribute('aria-label', title);
    sheet.innerHTML = `<section class="space-drawer"><header class="space-drawer-header">${back ? `<button class="icon-button space-back" aria-label="返回">${arrow}</button>` : ''}<h2>${title}</h2><button class="icon-button space-close" aria-label="关闭">${closeIcon}</button></header><div class="space-drawer-scroll">${body}<p class="form-error" role="alert"></p></div>${footer ? `<footer class="space-drawer-footer">${footer}</footer>` : ''}</section>`;
    sheet.querySelector('.space-close')?.addEventListener('click', close);
    sheet.querySelector('.space-back')?.addEventListener('click', () => { back!(); sheet.querySelector<HTMLButtonElement>('.space-back,.space-close')?.focus(); });
  }
  async function run(action: () => Promise<void>) {
    if (busy || signal.aborted) return;
    busy = true;
    sheet.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
    try { await action(); } catch (cause) { if (!signal.aborted) { const error = sheet.querySelector('.form-error'); if (error) error.textContent = cause instanceof Error ? cause.message : '操作未完成，请重试'; } }
    finally { busy = false; if (!signal.aborted) sheet.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); }
  }
  function rename(space: PrivateSpace, origin: HTMLButtonElement) {
    const overlay = document.createElement('div'); overlay.className = 'space-modal-overlay'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'space-name-title');
    overlay.innerHTML = `<form class="space-name-dialog" id="space-name-form"><h2 id="space-name-title">编辑空间名称</h2><label class="sr-only" for="space-name">空间名称</label><input id="space-name" name="name" maxlength="40" value="${escape(space.name)}" required autocomplete="off"><p class="field-hint">仅修改你这边的名称，对方的名称不变。</p><p class="form-error" role="alert"></p><div class="space-dialog-actions"><button type="button" class="text-button" id="space-name-cancel">取消</button><button class="primary-button" type="submit">保存</button></div></form>`;
    root.append(overlay);
    const resize = new AbortController(), input = overlay.querySelector<HTMLInputElement>('input')!;
    let saving = false;
    const modal = mountDialog(overlay, { signal, isActive: () => !signal.aborted, returnFocus: origin, initialFocus: input, beforeClose: () => !saving, onClose: () => resize.abort() });
    fitViewport(overlay, resize.signal);
    overlay.querySelector('#space-name-cancel')!.addEventListener('click', () => modal.close());
    overlay.addEventListener('click', e => { if (e.target === overlay) modal.close(); });
    overlay.querySelector('form')!.addEventListener('submit', async e => {
      e.preventDefault(); if (saving) return;
      const name = input.value.trim();
      if (!name || name.length > 40) { overlay.querySelector('.form-error')!.textContent = '请输入 1–40 个字符的空间名称'; input.focus(); return; }
      saving = true; overlay.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
      try {
        await options.rename(space, name);
        if (signal.aborted) return;
        space.name = name; modal.close({ animate: false, restoreFocus: false }); list();
        sheet.querySelector<HTMLButtonElement>(`[data-space="${options.spaces.indexOf(space)}"]`)?.focus();
      } catch (cause) { if (!signal.aborted) overlay.querySelector('.form-error')!.textContent = cause instanceof Error ? cause.message : '名称未保存，请重试'; }
      finally { saving = false; overlay.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); }
    });
    // Synchronous focus retains the user's activation for the iOS keyboard.
    input.focus({ preventScroll: true }); input.select();
  }
  function menu(space: PrivateSpace, origin: HTMLButtonElement) {
    if (busy || signal.aborted || root.querySelector('.space-context-overlay')) return;
    const overlay = document.createElement('div'); overlay.className = 'space-context-overlay'; overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-label',space.name);
    overlay.innerHTML = `<div class="space-context-menu"><button id="space-rename">${createElement(Pencil).outerHTML}<span>编辑空间名称</span></button></div>`;
    root.append(overlay);
    const dialog = mountDialog(overlay, { signal, isActive: () => !signal.aborted, returnFocus: origin });
    const rect = origin.getBoundingClientRect(), popup = overlay.firstElementChild as HTMLElement;
    const viewport = visualViewport, top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? innerHeight);
    popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 212))}px`;
    popup.style.top = `${Math.max(top + 12, Math.min(rect.bottom - 6, bottom - 70))}px`;
    overlay.addEventListener('click', e => { if (e.target === overlay) dialog.close({ animate: false }); });
    overlay.querySelector('#space-rename')!.addEventListener('click', () => { dialog.close({ animate: false, restoreFocus: false }); rename(space, origin); });
  }
  function styles() {
    const value = readPresenceStyle();
    page('在线状态样式', `<p class="space-description">选择聊天页顶部的显示方式。</p><div class="space-style-options" role="radiogroup" aria-label="在线状态样式">${(['capsule','heart'] as const).map(s => `<button class="space-style-choice" role="radio" tabindex="${s === value ? 0 : -1}" aria-checked="${s === value}" data-style="${s}"><span class="space-style-preview ${s}" aria-hidden="true">${s === 'capsule' ? `<span>TA</span>${heart}<span>我</span>` : heart}</span><span class="space-style-copy"><strong>${s === 'capsule' ? '在线胶囊' : '心动按钮'}</strong><small>${s === 'capsule' ? '居中显示双方状态 · 默认样式' : '红色爱心，显示在聊天页右上角'}</small></span><i class="space-radio" aria-hidden="true">${check}</i></button>`).join('')}</div><div class="space-presence-note"><p>左半颗代表对方，右半颗代表你。</p><p>在线状态不代表消息已读。</p></div>`, '<button class="primary-button" id="space-style-done">查看聊天效果</button>', settings);
    const choose = (button: HTMLButtonElement) => {
      try { writePresenceStyle(button.dataset.style as PresenceStyle); styleDirty = true; }
      catch { sheet.querySelector('.form-error')!.textContent = '浏览器未能保存设置，请重试'; return; }
      sheet.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(b => { b.setAttribute('aria-checked',String(b === button)); b.tabIndex = b === button ? 0 : -1; });
    };
    sheet.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(button => {
      button.addEventListener('click', () => choose(button));
      button.addEventListener('keydown', e => { if (['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(e.key)) { e.preventDefault(); const buttons = [...sheet.querySelectorAll<HTMLButtonElement>('[data-style]')]; const next = e.key === 'Home' ? buttons[0]! : e.key === 'End' ? buttons.at(-1)! : buttons.find(b => b !== button)!; choose(next); next.focus(); } });
    });
    sheet.querySelector('#space-style-done')!.addEventListener('click', close);
  }
  function settings() {
    const setting = (a: Action) => `<button class="space-setting" id="${a.id}"><span class="space-setting-icon" aria-hidden="true">${a.icon}</span><span class="space-setting-label">${escape(a.label)}</span>${arrow}</button>`;
    page('设置', `${(['当前空间','本机','关于'] as const).map(group => `<section class="space-setting-group"><h3>${group}</h3>${group === '本机' ? `<button class="space-setting" id="presence-style-setting"><span class="space-setting-icon" aria-hidden="true">${heart}</span><span class="space-setting-label">在线状态样式<small>${readPresenceStyle() === 'heart' ? '心动按钮' : '在线胶囊'}</small></span>${arrow}</button>` : ''}${options.actions.filter(a => (a.group ?? '当前空间') === group).map(setting).join('')}</section>`).join('')}`, '', list);
    sheet.querySelector('#presence-style-setting')!.addEventListener('click', () => { styles(); sheet.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus(); });
    for (const action of options.actions) sheet.querySelector(`#${action.id}`)!.addEventListener('click', () => { dialog.close({ animate: false }); action.run(); });
  }
  function badges() {
    sheet.querySelectorAll<HTMLElement>('[data-unread]').forEach(node => {
      const count = options.spaces[Number(node.dataset.unread)]?.unread ?? 0;
      node.hidden = count === 0; node.textContent = count > 99 ? '99+' : String(count); node.setAttribute('aria-label',`${count} 条未读消息`);
    });
  }
  function row(s: PrivateSpace) {
    const i = options.spaces.indexOf(s), selected = s.roomId === options.currentRoom;
    return `<button class="space-row ${selected ? 'is-selected' : ''}" data-space="${i}" aria-current="${selected ? 'true' : 'false'}"><span class="space-row-copy">${selected ? '<small class="space-current-label">当前空间</small>' : ''}<strong>${escape(s.name)}</strong>${selected ? '' : `<small class="space-message-preview ${s.waiting ? 'is-waiting' : ''}">${escape(s.waiting ? '等待对方加入' : s.preview || '打开空间查看消息')}</small>`}</span>${selected ? `<span class="space-selected-check" aria-hidden="true">${check}</span>` : `<span class="space-row-trailing"><span class="space-unread" data-unread="${i}" hidden></span><span class="space-row-arrow" aria-hidden="true">${arrow}</span></span>`}</button>`;
  }
  function list() {
    const current = options.spaces.find(s => s.roomId === options.currentRoom), others = options.spaces.filter(s => s !== current);
    page('私密空间', `<div class="space-list">${current ? row(current) : ''}<div class="space-list-heading"><span>其他空间</span><span>${others.length}</span></div>${others.map(row).join('')}${!others.length ? '<p class="space-empty">想和另一个人聊聊？<br>从下方创建一个新空间。</p>' : ''}</div>`, `<button class="space-create" id="space-create">${createElement(Plus).outerHTML}创建新空间</button><button class="space-settings-entry" id="space-settings" aria-label="设置">${spaceIcons.settings}</button>`);
    sheet.querySelector('.space-drawer-scroll')!.scrollTop = listScrollTop; badges();
    sheet.querySelector('#space-settings')!.addEventListener('click', () => { settings(); sheet.querySelector<HTMLButtonElement>('.space-back')?.focus(); });
    sheet.querySelector('#space-create')!.addEventListener('click', () => void run(async () => { await options.create(); dialog.close({ animate: false }); }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-space]').forEach(button => {
      const space = options.spaces[Number(button.dataset.space)]!;
      let timer: number | undefined, pressed = false, x = 0, y = 0;
      const cancel = () => { window.clearTimeout(timer); timer = undefined; };
      button.addEventListener('pointerdown', e => { if (e.button !== 0) return; pressed = false; x = e.clientX; y = e.clientY; timer = window.setTimeout(() => { pressed = true; menu(space, button); }, 550); });
      button.addEventListener('pointermove', e => { if (Math.hypot(e.clientX-x,e.clientY-y) > 10) cancel(); });
      ['pointerup','pointercancel','pointerleave'].forEach(type => button.addEventListener(type,cancel));
      signal.addEventListener('abort', cancel, { once: true });
      button.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); pressed = true; menu(space, button); });
      button.addEventListener('keydown', e => { if (e.key === 'F2' || e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); menu(space, button); } });
      button.addEventListener('click', () => { cancel(); if (pressed) { pressed = false; return; } if (space.roomId === options.currentRoom && !space.waiting) close(); else void run(async () => { await options.select(space); dialog.close({ animate: false }); }); });
    });
  }
  list();
  if (options.refreshUnread) {
    const poll = async () => {
      if (signal.aborted) return;
      try { if (!document.hidden) { await options.refreshUnread!(signal); if (!signal.aborted) badges(); } }
      catch { /* Keep the last confirmed count while offline. */ }
      if (!signal.aborted) timer = window.setTimeout(poll, 5000);
    };
    let timer: number | undefined;
    signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true });
    void poll();
  }
}

export function mountSpaceInvite(root: HTMLElement, options: { name: string; signal: AbortSignal; content: string; closed: () => void }) {
  const overlay = document.createElement('div'); overlay.className = 'space-invite-overlay'; overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-labelledby','space-invite-title');
  overlay.innerHTML = `<section class="space-invite-sheet"><div class="space-invite-handle" aria-hidden="true"><span></span></div><header><span class="space-invite-name">${escape(options.name)}</span><button class="icon-button" id="invite-close" aria-label="关闭邀请">${closeIcon}</button></header>${options.content}</section>`;
  root.append(overlay);
  const dialog = mountDialog(overlay, { signal: options.signal, isActive: () => !options.signal.aborted, onClose: () => { if (overlay.isConnected) options.closed(); } });
  overlay.querySelector('#invite-close')!.addEventListener('click', () => dialog.close());
  overlay.addEventListener('click', e => { if (e.target === overlay) dialog.close(); });
  const handle = overlay.querySelector<HTMLElement>('.space-invite-handle')!;
  let start: number | null = null;
  handle.addEventListener('pointerdown', e => { start = e.clientY; handle.setPointerCapture(e.pointerId); });
  handle.addEventListener('pointerup', e => { if (start !== null && e.clientY - start > 45) dialog.close(); start = null; });
  handle.addEventListener('pointercancel', () => { start = null; });
  return overlay;
}
