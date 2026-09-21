import { mountDialog } from './dialog';
import type { PrivateSpace } from './spaces';
export type PresenceStyle = 'capsule' | 'heart';
export function readPresenceStyle(): PresenceStyle { try { return localStorage.getItem('quiet-room:presence-style') === 'heart' ? 'heart' : 'capsule'; } catch { return 'capsule'; } }
export function writePresenceStyle(style: PresenceStyle): void { localStorage.setItem('quiet-room:presence-style', style); }
type Action = { id: string; label: string; icon: string; run: () => void };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
export function mountSpaceDrawer(root: HTMLElement, options: {
  spaces: PrivateSpace[]; currentRoom: string; signal: AbortSignal; actions: Action[]; icons: { close: string; plus: string; settings: string };
  select: (space: PrivateSpace) => Promise<void>; create: () => Promise<void>; rename: (space: PrivateSpace, name: string) => Promise<void>;
  styleChanged: (style: PresenceStyle) => void; closed: () => void;
}): void {
  const sheet = document.createElement('div'); sheet.className = 'space-drawer-overlay'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', '私密空间');
  root.append(sheet);
  const dialog = mountDialog(sheet, { signal: options.signal, isActive: () => !options.signal.aborted, onClose: options.closed });
  const close = () => dialog.close();
  let listScrollTop = 0;
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  function page(title: string, body: string, footer = '', back?: () => void) {
    if (sheet.querySelector('.space-list')) listScrollTop = sheet.querySelector('.space-drawer-scroll')!.scrollTop;
    sheet.setAttribute('aria-label', title);
    sheet.innerHTML = `<section class="space-drawer glass-panel"><header class="space-drawer-header">${back ? `<button class="icon-button space-back" aria-label="返回">${arrow}</button>` : ''}<h2>${title}</h2><button class="icon-button space-close" aria-label="关闭">${options.icons.close}</button></header><div class="space-drawer-scroll">${body}<p class="form-error" role="alert"></p></div>${footer ? `<footer class="space-drawer-footer">${footer}</footer>` : ''}</section>`;
    sheet.querySelector('.space-close')?.addEventListener('click', close);
    sheet.querySelector('.space-back')?.addEventListener('click', back!);
  }
  async function run(action: () => Promise<void>) {
    sheet.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
    try { await action(); } catch (cause) { const error = sheet.querySelector('.form-error'); if (error) error.textContent = cause instanceof Error ? cause.message : '操作未完成，请重试'; }
    finally { sheet.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); }
  }
  function rename(space: PrivateSpace) {
    page('编辑空间名称', `<form id="space-name-form"><label class="space-name-label" for="space-name">空间名称</label><input id="space-name" name="name" maxlength="40" value="${escape(space.name)}" required autocomplete="off"><p class="field-hint">只修改你这边的名称，对方的空间名称不变。</p><button class="primary-button" type="submit">保存</button></form>`, '', list);
    sheet.querySelector('form')!.addEventListener('submit', e => { e.preventDefault(); const name = sheet.querySelector<HTMLInputElement>('input')!.value.trim(); void run(async () => { await options.rename(space, name); space.name = name; list(); }); });
    sheet.querySelector<HTMLInputElement>('input')!.focus();
  }
  function menu(space: PrivateSpace) {
    page(space.name, `<button class="space-setting" id="space-rename"><span>编辑空间名称</span>${arrow}</button>`, '', list);
    sheet.querySelector('#space-rename')!.addEventListener('click', () => rename(space));
    sheet.querySelector<HTMLButtonElement>('#space-rename')!.focus();
  }
  function styles() {
    const value = readPresenceStyle();
    page('在线状态样式', `<p class="space-description">选择聊天页顶部的显示方式。</p><div class="space-style-options" role="radiogroup" aria-label="在线状态样式">${(['capsule','heart'] as const).map(s => `<button class="space-style-choice" role="radio" aria-checked="${s === value}" data-style="${s}"><span class="space-style-preview ${s}">${s === 'capsule' ? 'TA　♡　我' : '♥'}</span><span>${s === 'capsule' ? '在线胶囊' : '心动按钮'}${s === 'capsule' ? '<small>默认样式</small>' : '<small>显示在聊天页右上角</small>'}</span><i aria-hidden="true">${s === value ? '✓' : ''}</i></button>`).join('')}</div>`, '', settings);
    sheet.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(button => button.addEventListener('click', () => void run(async () => { const style = button.dataset.style as PresenceStyle; writePresenceStyle(style); dialog.close({ animate: false }); options.styleChanged(style); })));
  }
  function settings() {
    page('设置', `<button class="space-setting" id="presence-style-setting"><span>${options.icons.settings}在线状态样式</span>${arrow}</button><div class="space-settings-divider"></div>${options.actions.map(a => `<button class="space-setting" id="${a.id}"><span>${a.icon}${escape(a.label)}</span>${arrow}</button>`).join('')}`, '', list);
    sheet.querySelector('#presence-style-setting')!.addEventListener('click', styles);
    for (const action of options.actions) sheet.querySelector(`#${action.id}`)!.addEventListener('click', () => { dialog.close({ animate: false }); action.run(); });
  }
  function list() {
    page('私密空间', `<div class="space-list">${options.spaces.map((s, i) => `<button class="space-row ${s.roomId === options.currentRoom ? 'is-selected' : ''}" data-space="${i}" aria-current="${s.roomId === options.currentRoom ? 'true' : 'false'}"><span class="space-avatar" aria-hidden="true">${escape(s.name.slice(0, 1))}</span><span class="space-row-copy"><strong>${escape(s.name)}</strong>${s.waiting ? '<small>等待对方加入</small>' : ''}</span>${s.roomId === options.currentRoom ? '<span class="space-selected-check" aria-hidden="true">✓</span>' : ''}</button>`).join('')}</div>`, `<button class="space-create text-button" id="space-create">${options.icons.plus}创建新空间</button><button class="space-settings-entry" id="space-settings">${options.icons.settings}<span>设置</span>${arrow}</button>`);
    sheet.querySelector('.space-drawer-scroll')!.scrollTop = listScrollTop;
    sheet.querySelector('#space-settings')!.addEventListener('click', settings);
    sheet.querySelector('#space-create')!.addEventListener('click', () => void run(async () => { await options.create(); dialog.close({ animate: false }); }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-space]').forEach(button => {
      const space = options.spaces[Number(button.dataset.space)]!;
      let timer: number | undefined, pressed = false, x = 0, y = 0;
      const cancel = () => { window.clearTimeout(timer); timer = undefined; };
      button.addEventListener('pointerdown', e => { if (e.button !== 0) return; pressed = false; x = e.clientX; y = e.clientY; timer = window.setTimeout(() => { pressed = true; menu(space); }, 550); });
      button.addEventListener('pointermove', e => { if (Math.hypot(e.clientX-x,e.clientY-y) > 10) cancel(); });
      ['pointerup','pointercancel','pointerleave'].forEach(type => button.addEventListener(type,cancel));
      options.signal.addEventListener('abort', cancel, { once: true });
      button.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); pressed = true; menu(space); });
      button.addEventListener('keydown', e => { if (e.key === 'F2' || e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); menu(space); } });
      button.addEventListener('click', () => { cancel(); if (pressed) { pressed = false; return; } if (space.roomId === options.currentRoom) close(); else void run(async () => { await options.select(space); dialog.close({ animate: false }); }); });
    });
  }
  list();
}
