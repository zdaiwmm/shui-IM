import {uiNotice} from './ui-notice';
import { presenceCircuitMarkup } from './presence-circuit';
import { layoutViewport } from './form-input';
import { animatePageReplacement } from './motion';
import { mountDialog } from './dialog';
import { bindHalfSheetHandle } from './half-sheet';
import { spaceAvatarMarkup, bindSpaceAvatarPlayback } from './space-avatar';
import type { PrivateSpace } from './spaces';
import { Image, createElement, Bell, Settings, PanelsTopLeft, Smartphone, KeyRound, Upload, Download, EyeOff, History, Heart, Pencil, Check, Plus, ChevronRight, Trash2, PanelLeftClose, Palette, MonitorDown, ArrowLeft, X } from 'lucide';
import { formatPendingCountdown, pendingSpaceExpiry } from './spaces';
export type PresenceStyle = 'capsule' | 'heart';
export function readPresenceStyle(): PresenceStyle { try { return localStorage.getItem('quiet-room:presence-style') === 'heart' ? 'heart' : 'capsule'; } catch { return 'capsule'; } }
export function writePresenceStyle(style: PresenceStyle): void { localStorage.setItem('quiet-room:presence-style', style); }
export const spaceIcons = {
  bell: createElement(Bell).outerHTML, settings: createElement(Settings).outerHTML, spaces: createElement(PanelsTopLeft).outerHTML,
  device: createElement(Smartphone).outerHTML, key: createElement(KeyRound).outerHTML,
  upload: createElement(Upload).outerHTML, download: createElement(Download).outerHTML,
  cover: createElement(EyeOff).outerHTML, history: createElement(History).outerHTML,
  appearance: createElement(Palette).outerHTML, app: createElement(MonitorDown).outerHTML,
};
const arrow = createElement(ChevronRight).outerHTML, check = createElement(Check).outerHTML, heart = createElement(Heart).outerHTML;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
type Action = { id: string; label: string; icon: string; group?: '当前密室' | '本机' | '关于'; keepOpen?: boolean | (() => boolean); run: (showSpaceList: () => void) => void | Promise<void> };

/** Follow the visual viewport when the native keyboard opens, without resizing the chat. */
export function fitViewport(element: HTMLElement, signal: AbortSignal) {
  const fit = () => {
    const viewport = layoutViewport();
    element.style.top = `${viewport?.offsetTop ?? 0}px`;
    element.style.height = `${viewport?.height ?? innerHeight}px`;
  };
  fit();
  layoutViewport()?.addEventListener('resize', fit, { signal });
  layoutViewport()?.addEventListener('scroll', fit, { signal });
  window.addEventListener('resize', fit, { signal });
}

export function mountSpaceDrawer(root: HTMLElement, options: {
  presentation?: 'sidebar' | 'settings'; container?: HTMLElement; openSettings?: () => void;
  spaces: PrivateSpace[]; currentRoom: string; signal: AbortSignal; actions: Action[]; icons?: { close: string; plus: string; settings: string };
  select: (space: PrivateSpace) => Promise<void>; create: () => Promise<void>; allowCreate?:boolean; rename: (space: PrivateSpace, name: string) => Promise<void>;
removeLabel?: (space: PrivateSpace) => string; initialSettings?: boolean; restoreSettings?: boolean; settingsScrollTop?: number; onSettingsLeave?: (scrollTop: number) => void;
  editAvatar?: (space: PrivateSpace) => Promise<import('./space-avatar').SpaceAvatar | null>;
  remove?: (space: PrivateSpace) => Promise<void | boolean>; expired?: (space: PrivateSpace) => void;
  listScrollTop?: number;
  refreshUnread?: (signal: AbortSignal) => Promise<void>;
  refreshSpaces?: (signal: AbortSignal) => Promise<PrivateSpace[]>;
  authorization?: (space: PrivateSpace) => {deadline:number;open:()=>Promise<void>} | undefined;
  canStylePresence?: () => boolean;
  styleChanged: (style: PresenceStyle) => void; closed: (sheet: HTMLElement) => void;
}): void {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const sheet = document.createElement('div'); sheet.className = 'space-drawer-overlay' + (options.initialSettings && options.restoreSettings ? ' is-visible is-restored' : ''); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', '切换密室');
  const embedded = Boolean(options.presentation);
  if (embedded) { sheet.className = `space-embedded space-${options.presentation}`; sheet.removeAttribute('aria-modal'); sheet.setAttribute('role', 'region'); }
  (options.container ?? root).append(sheet);
  let handingOff = false, listReturnSettings = false;
  let busy = false, listScrollTop = options.listScrollTop ?? 0, settingsScrollTop = options.settingsScrollTop ?? 0;
  let pageLifetime = new AbortController();
  signal.addEventListener('abort', () => pageLifetime.abort(), { once: true });
  const dialog = embedded ? { close: (_options?: { animate?: boolean; restoreFocus?: boolean }) => { /* Embedded navigation owns its page lifetime. */ } } : mountDialog(sheet, { signal: options.signal, isActive: () => !options.signal.aborted,
    returnFocus: root.querySelector<HTMLElement>(options.initialSettings ? ':scope > .chat-shell #chat-settings' : ':scope > .chat-shell #open-spaces'),
    beforeClose: () => !busy, onClose: () => {
    lifetime.abort(); if (!handingOff) options.closed(sheet);
  } });
  if (embedded) signal.addEventListener('abort', () => sheet.remove(), { once: true });
  const close = () => { if (embedded) { if (!busy) options.closed(sheet); } else dialog.close(); };
  sheet.addEventListener('click', e => { if (e.target === sheet && !busy) close(); });
  function page(title: string, body: string, footer = '', back?: () => void) {
    pageLifetime.abort(); pageLifetime = new AbortController();
    const previousPage = sheet.querySelector<HTMLElement>(':scope > .space-drawer');
    const previousScrollTop=previousPage?.querySelector('.space-drawer-scroll')?.scrollTop??0;
    if (previousPage?.querySelector('.space-list')) listScrollTop = previousPage.querySelector('.space-drawer-scroll')!.scrollTop;
    const priorTitle = sheet.getAttribute('aria-label');
    if (priorTitle === '设置') settingsScrollTop = previousPage?.querySelector('.space-drawer-scroll')?.scrollTop ?? settingsScrollTop;
    // Snapshot the old family before changing its ancestor classes. Reparenting
    // the live panel under the new family resizes/reflows it during the slide.
    const previousCanvas=previousPage?sheet.cloneNode(true) as HTMLElement:null;
    if(previousCanvas&&previousPage){
      previousCanvas.querySelectorAll('.local-page-outgoing').forEach(node=>node.remove());
      previousCanvas.style.cssText='position:fixed;inset:0;width:100%;height:100%;pointer-events:none;transition:none;';
      const panel=previousCanvas.querySelector<HTMLElement>(':scope > .space-drawer')!,rect=previousPage.getBoundingClientRect();
      panel.classList.add('local-page-outgoing');
      Object.assign(panel.style,{position:'absolute',left:`${rect.left}px`,top:`${rect.top}px`,right:'auto',bottom:'auto',width:`${rect.width}px`,height:`${rect.height}px`,maxHeight:'none',transform:'none',transition:'none'});
      panel.querySelector('.space-drawer-scroll')!.scrollTop=previousPage.querySelector('.space-drawer-scroll')!.scrollTop;
    }
    sheet.setAttribute('aria-label', title);
    sheet.classList.toggle('is-settings-page', title === '设置');
    sheet.classList.toggle('is-space-list-page', title === '切换密室');
    const listing = title === '切换密室';
    const settingsSheet = !embedded && title === '设置';
    sheet.classList.toggle('is-settings-subpage', title === '在线状态样式');
    sheet.classList.toggle('is-settings-sheet', settingsSheet);
    const fullPage=listing&&!embedded;
    const leading=!embedded?'':back?`<button class="icon-button space-back" aria-label="返回">${createElement(ArrowLeft).outerHTML}</button>`:`<button class="icon-button space-close" aria-label="${options.presentation==='sidebar'?'收起密室侧栏':'返回聊天'}">${createElement(options.presentation==='sidebar'?PanelLeftClose:ArrowLeft).outerHTML}</button>`;
    const trailing=`${listing&&options.allowCreate!==false?`<button class="icon-button space-create" id="space-create" type="button" aria-label="新增密室">${createElement(Plus).outerHTML}<span>新增</span></button>`:''}${listing&&embedded?`<button class="icon-button" id="space-settings" aria-label="设置">${spaceIcons.settings}</button>`:''}${settingsSheet?`<button class="icon-button settings-desktop-close" type="button" aria-label="关闭设置">${createElement(X).outerHTML}</button>`:''}`;
    const controls=`${footer}${!embedded&&back&&title!=='设置'&&!listing?'<button class="text-button space-back" type="button">返回</button>':''}${fullPage?'<button class="text-button space-return" type="button">返回</button>':''}`;
    sheet.innerHTML=`<section class="space-drawer"><header class="space-drawer-header">${leading}<h2>${title}</h2>${trailing}</header><div class="space-drawer-scroll">${body}<p class="form-error" role="alert"></p></div>${controls?`<footer class="space-drawer-footer">${controls}</footer>`:''}${settingsSheet?'<button class="settings-dismiss-handle" type="button" aria-label="上滑关闭设置"><span></span></button>':''}</section>`;
    sheet.querySelector('.space-return')?.addEventListener('click',()=>{if(listReturnSettings)settings();else close();});
    sheet.querySelector('.settings-desktop-close')?.addEventListener('click',close);
    const handle=sheet.querySelector<HTMLElement>('.settings-dismiss-handle');
    handle?.addEventListener('click',close);
    let drag:{id:number;y:number}|undefined;const panel=sheet.querySelector<HTMLElement>(':scope > .space-drawer')!;
    const clearDrag=()=>{drag=undefined;panel.classList.remove('is-settings-dragging');panel.style.removeProperty('--settings-drag');};
    handle?.addEventListener('pointerdown',event=>{if(event.button!==0||busy)return;drag={id:event.pointerId,y:event.clientY};panel.classList.add('is-settings-dragging');handle.setPointerCapture(event.pointerId);});
    handle?.addEventListener('pointermove',event=>{if(drag?.id===event.pointerId)panel.style.setProperty('--settings-drag',`${Math.min(0,event.clientY-drag.y)}px`);});
    handle?.addEventListener('pointerup',event=>{if(drag?.id===event.pointerId&&drag.y-event.clientY>32)close();clearDrag();});
    handle?.addEventListener('pointercancel',clearDrag);

    bindSpaceAvatarPlayback(sheet, AbortSignal.any([signal, pageLifetime.signal]));
    if (previousCanvas && priorTitle !== title && (!settingsSheet || priorTitle === '在线状态样式' || priorTitle === '切换密室')) {
      // Keep the old overlay outside the new page family. Nesting it under
      // the successor reapplies that family's layout rules to the old list.
      animatePageReplacement(root, previousCanvas, sheet, title === '设置', signal, true);
      previousCanvas.querySelector('.space-drawer-scroll')!.scrollTop=previousScrollTop;
    }
    sheet.querySelector('.space-close')?.addEventListener('click', close);
    sheet.querySelector('.space-back')?.addEventListener('click', () => { back!(); sheet.querySelector<HTMLButtonElement>('.space-back,.space-close')?.focus({ preventScroll: true }); });
  }
  async function run(action: () => Promise<void>) {
    if (busy || signal.aborted) return;
    busy = true;
    sheet.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
    try { await action(); } catch (cause) { if (!signal.aborted) { uiNotice(root,cause instanceof Error ? cause.message : '操作未完成，请重试'); } }
    finally { busy = false; if (!signal.aborted) sheet.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); }
  }
  function rename(space: PrivateSpace, origin: HTMLButtonElement) {
    const overlay = document.createElement('div'); overlay.className = 'space-modal-overlay'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'space-name-title');
    overlay.innerHTML = `<form class="space-name-dialog" id="space-name-form"><h2 id="space-name-title">编辑密室名称</h2><label class="sr-only" for="space-name">密室名称</label><input id="space-name" name="name" maxlength="40" value="${escape(space.name)}" required autocomplete="off"><p class="field-hint">仅修改你这边的名称，对方的名称不变。</p><p class="form-error" role="alert"></p><div class="space-dialog-actions"><button type="button" class="text-button" id="space-name-cancel">取消</button><button class="primary-button" type="submit">保存</button></div></form>`;
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
      if (!name || name.length > 40) { uiNotice(root,'请输入 1–40 个字符的密室名称'); input.focus({ preventScroll: true }); return; }
      saving = true; overlay.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
      try {
        await options.rename(space, name);
        if (signal.aborted) return;
        space.name = name; modal.close({ animate: false, restoreFocus: false }); list();
        sheet.querySelector<HTMLButtonElement>(`[data-space="${options.spaces.indexOf(space)}"]`)?.focus({ preventScroll: true });
      } catch (cause) { if (!signal.aborted) uiNotice(root,cause instanceof Error ? cause.message : '名称未保存，请重试'); }
      finally { saving = false; overlay.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); }
    });
    // Synchronous focus retains the user's activation for the iOS keyboard.
    input.focus({ preventScroll: true }); input.select();
  }
  function menu(space: PrivateSpace, origin: HTMLButtonElement) {
    if (busy || signal.aborted || space.accessState || root.querySelector('.space-context-overlay')) return;
    const overlay = document.createElement('div'); overlay.className = 'space-context-overlay'; overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-label',space.name);
const removable = Boolean(options.remove && (space.waiting || space.roomArchiveV2) && !space.accessState);
    overlay.innerHTML = `<div class="space-context-menu"><button id="space-rename">${createElement(Pencil).outerHTML}<span>编辑密室名称</span></button>${options.editAvatar ? `<button id="space-avatar-edit">${createElement(Image).outerHTML}<span>修改密室头像</span></button>` : ''}${removable ? `<button id="space-delete" class="is-danger">${createElement(Trash2).outerHTML}<span>${escape(options.removeLabel?.(space) ?? '删除密室')}</span></button>` : ''}</div>`;
    root.append(overlay);
    const dialog = mountDialog(overlay, { signal, isActive: () => !signal.aborted, returnFocus: origin });
    const rect = origin.getBoundingClientRect(), popup = overlay.firstElementChild as HTMLElement;
    const viewport = layoutViewport(), top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? innerHeight);
    popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 212))}px`;
    popup.style.top = `${Math.max(top + 12, Math.min(rect.bottom - 6, bottom - ((removable ? 124 : 70) + (options.editAvatar ? 44 : 0))))}px`;
    overlay.addEventListener('click', e => { if (e.target === overlay) dialog.close({ animate: false }); });
    overlay.querySelector('#space-rename')!.addEventListener('click', () => { dialog.close({ animate: false, restoreFocus: false }); rename(space, origin); });
    overlay.querySelector('#space-avatar-edit')?.addEventListener('click', () => {
      dialog.close({ animate: false, restoreFocus: false });
      void run(async () => { const avatar = await options.editAvatar!(space); if (signal.aborted) return; if (avatar) space.avatar = avatar; list(); });
    });
    overlay.querySelector('#space-delete')?.addEventListener('click', () => {
      dialog.close({ animate: false, restoreFocus: false });
      void run(async () => {
        if (await options.remove!(space) === false) return;
        if (signal.aborted) return;
        const index = options.spaces.indexOf(space);
        if (index >= 0) options.spaces.splice(index, 1);
        list();
      });
    });
  }
  function styles() {
    if (signal.aborted || options.canStylePresence?.() === false) return;
    const value = readPresenceStyle();
    page('在线状态样式', `<p class="space-description">选择聊天页顶部的显示方式。</p><div class="space-style-options" role="radiogroup" aria-label="在线状态样式">${(['capsule','heart'] as const).map(s => `<button class="space-style-choice" role="radio" tabindex="${s === value ? 0 : -1}" aria-checked="${s === value}" data-style="${s}"><span class="space-style-preview ${s}" aria-hidden="true">${s === 'capsule' ? `<span>TA</span>${presenceCircuitMarkup.replace('data-phase="unknown"','data-phase="online" data-self="true" data-peer="true"')}<span>我</span>` : presenceCircuitMarkup.replace('viewBox="0 0 100 24"', 'viewBox="34 -5.52 32 32"').replace('data-phase="unknown"','data-phase="online" data-self="true" data-peer="true" data-compact="true"')}</span><span class="space-style-copy"><strong>${s === 'capsule' ? '在线胶囊' : '心动按钮'}</strong><small>${s === 'capsule' ? '双方状态与连接动效' : '简洁爱心，显示在聊天页右上角'}</small></span><i class="space-radio" aria-hidden="true">${check}</i></button>`).join('')}</div><div class="space-presence-note"><p>左半颗代表对方，右半颗代表你。</p><p>在线状态不代表消息已读。</p></div>`, '', settings);
    const choose = (button: HTMLButtonElement) => {
      if (signal.aborted) return;
      if (options.canStylePresence?.() === false) { uiNotice(root,'加入密室后可设置'); return; }
      try { writePresenceStyle(button.dataset.style as PresenceStyle); options.styleChanged(readPresenceStyle()); }
      catch { uiNotice(root,'浏览器未能保存设置，请重试'); return; }
      sheet.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(b => { b.setAttribute('aria-checked',String(b === button)); b.tabIndex = b === button ? 0 : -1; });
    };
    sheet.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(button => {
      button.addEventListener('click', () => choose(button));
      button.addEventListener('keydown', e => { if (['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(e.key)) { e.preventDefault(); const buttons = [...sheet.querySelectorAll<HTMLButtonElement>('[data-style]')]; const next = e.key === 'Home' ? buttons[0]! : e.key === 'End' ? buttons.at(-1)! : buttons.find(b => b !== button)!; choose(next); next.focus({ preventScroll: true }); } });
    });
  }
  function settings() {
    const setting = (a: Action) => `<button class="space-setting ${a.id === 'chamber-close' ? 'is-danger' : ''}" id="${a.id}"><span class="space-setting-icon" data-setting="${a.id}" aria-hidden="true">${a.icon}</span><span class="space-setting-label">${escape(a.label)}</span>${arrow}</button>`;
    const order = ['appearance-settings', 'auto-lock-settings', 'app-access-settings', 'notification-settings', 'manage-devices', 'passkey-management', 'backup-settings', 'local-history-backup', 'local-history-restore', 'recover-other-space', 'cover-practice-menu', 'release-history'];
    const actions = [...options.actions].sort((a, b) => (order.indexOf(a.id) < 0 ? 99 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 99 : order.indexOf(b.id)));
    const groups = [
      {title:'聊天体验',ids:['appearance-settings','presence-style-setting','notification-settings']},
      {title:'隐私保护',ids:['room-lock-settings','auto-lock-settings','passkey-management','cover-practice-menu']},
      {title:'密室与设备',ids:['chamber-switch-space','manage-devices','help-peer-enter']},
      {title:'备份与恢复',ids:['archive-settings','archive-restore','backup-settings','local-history-backup','local-history-restore','recover-other-space']},
      {title:'关于',ids:['app-access-settings','release-history']},
      {title:'密室操作',ids:['chamber-close']},
    ];
    const presence = `<button class="space-setting" id="presence-style-setting" ${options.canStylePresence?.() === false ? 'disabled' : ''}><span class="space-setting-icon" data-setting="presence-style-setting" aria-hidden="true">${heart}</span><span class="space-setting-label">在线状态样式</span><small class="space-setting-value">${options.canStylePresence?.() === false ? '加入密室后可设置' : readPresenceStyle() === 'heart' ? '心动按钮' : '在线胶囊'}</small>${arrow}</button>`;
    const known = new Set(groups.flatMap(group=>group.ids));
    const cards = groups.map(group=>{const content=group.ids.map(id=>id==='presence-style-setting'?presence:actions.filter(a=>a.id===id).map(setting).join('')).join('');return content?`<section class="space-setting-section" aria-label="${group.title}"><h3>${group.title}</h3><div class="space-setting-card">${content}</div></section>`:'';}).filter(Boolean);
    const other = actions.filter(a => !known.has(a.id)).map(setting).join('');
    if (other) cards.push(`<div class="space-setting-card">${other}</div>`);
    page('设置', `<div class="space-settings-list">${cards.join('')}</div>`, '', options.presentation === 'settings' ? close : list);
    sheet.querySelector('.space-drawer-scroll')!.scrollTop = settingsScrollTop;
    sheet.querySelector('#presence-style-setting')!.addEventListener('click', () => { styles(); sheet.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus({ preventScroll: true }); });
    for (const action of options.actions) sheet.querySelector(`#${action.id}`)!.addEventListener('click', () => { if (typeof action.keepOpen === 'function' ? action.keepOpen() : action.keepOpen) void run(async () => { await action.run(list); }); else { options.onSettingsLeave?.(sheet.querySelector('.space-drawer-scroll')!.scrollTop); handingOff = true; void action.run(list); } });
  }
  function authorizations() {
    sheet.querySelectorAll<HTMLButtonElement>('[data-access]').forEach(button=>{const space=options.spaces[Number(button.dataset.access)];const action=space&&options.authorization?.(space);button.hidden=!action||action.deadline<=performance.now();});
  }
  function badges() {
    sheet.querySelectorAll<HTMLElement>('[data-unread]').forEach(node => {
      const count = options.spaces[Number(node.dataset.unread)]?.unread ?? 0;
      node.hidden = count === 0; node.textContent = count > 99 ? '99+' : String(count); node.setAttribute('aria-label',`${count} 条未读消息`);
    });
  }
  function row(s: PrivateSpace) {
    const i = options.spaces.indexOf(s), selected = s.roomId === options.currentRoom;
const expiry = pendingSpaceExpiry(s);
    const waitingCopy = `等待对方加入${expiry ? ` · 剩余 ${formatPendingCountdown(expiry - Date.now())}` : ''}`;
    const status = s.accessState === 'unprepared' ? '请先在原设备打开此密室' : s.accessState === 'restricted' ? '待对方授权' : s.waiting ? waitingCopy : s.preview || '打开密室查看消息';
    const statusLine = s.waiting && !s.accessState
      ? `<small class="space-message-preview is-waiting" ${expiry ? `data-expires="${expiry}" data-countdown="${i}"` : ''}>${escape(waitingCopy)}</small>`
      : `<small class="space-message-preview">${escape(status)}</small>`;
    return `<div class="space-access-row"><button class="space-row ${selected ? 'is-selected' : ''}" data-space="${i}" aria-current="${selected ? 'true' : 'false'}">${spaceAvatarMarkup(s.avatar, s.name)}<span class="space-row-copy"><strong>${escape(s.name)}</strong>${statusLine}</span><span class="space-row-trailing"><span class="space-unread" data-unread="${i}" hidden></span>${selected ? '' : `<span class="space-row-arrow" aria-hidden="true">${arrow}</span>`}</span></button><button class="space-access-action" data-access="${i}" aria-label="授权 ${escape(s.name)} 的设备请求" hidden><span>授权</span></button></div>`;
  }
  function list() {
    if(sheet.getAttribute('aria-label')==='设置')listReturnSettings=true;
    const focused = sheet.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    const focusedRoom = focused?.dataset.space ? options.spaces[Number(focused.dataset.space)]?.roomId : undefined;
    const focusedId = focused?.id;
    const current = options.spaces.find(s => s.roomId === options.currentRoom), others = options.spaces.filter(s => s !== current);
    page('切换密室', `<div class="space-list">${current ? row(current) : ''}${others.map(row).join('')}${!options.spaces.length ? `<p class="space-empty">当前没有可进入的密室${options.allowCreate===false?'':'<br>点击右上角新增密室。'}</p>` : ''}</div>`);
    sheet.querySelector('.space-drawer-scroll')!.scrollTop = listScrollTop; badges();authorizations();
    if (focusedRoom) sheet.querySelector<HTMLButtonElement>(`[data-space="${options.spaces.findIndex(s => s.roomId === focusedRoom)}"]`)?.focus({ preventScroll: true });
    else if (focusedId) sheet.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`)?.focus({ preventScroll: true });
    sheet.querySelectorAll<HTMLButtonElement>('[data-access]').forEach(button=>button.addEventListener('click',()=>{const space=options.spaces[Number(button.dataset.access)]!;const action=options.authorization?.(space);if(action&&action.deadline>performance.now()){dialog.close({animate:false});void action.open();}}));
    sheet.querySelector('#space-settings')?.addEventListener('click', () => { if (options.openSettings) options.openSettings(); else { settings(); sheet.querySelector<HTMLButtonElement>('.space-back')?.focus({ preventScroll: true }); } });
    sheet.querySelector('#space-create')?.addEventListener('click', () => void run(async () => { await options.create(); }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-space]').forEach(button => {
      const space = options.spaces[Number(button.dataset.space)]!;
      let timer: number | undefined, pressed = false, x = 0, y = 0;
      const cancel = () => { window.clearTimeout(timer); timer = undefined; };
      button.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        pressed = false; x = e.clientX; y = e.clientY;
        const started = performance.now();
        let moved = false;
        const gesture = new AbortController();
        try { button.setPointerCapture(e.pointerId); } catch { /* Capture is a hint; the timer still runs. */ }
        const finish = (open: boolean) => {
          if (gesture.signal.aborted) return;
          gesture.abort();
          window.clearTimeout(timer); timer = undefined;
          if (open && !moved && !signal.aborted) { pressed = true; menu(space, button); }
        };
        timer = window.setTimeout(() => finish(true), 500);
        button.addEventListener('pointermove', event => { if (Math.hypot(event.clientX - x, event.clientY - y) > 12) { moved = true; finish(false); } }, { signal: gesture.signal });
        button.addEventListener('pointerup', () => finish(false), { signal: gesture.signal });
        button.addEventListener('pointercancel', event => finish(!moved && performance.now() - started >= 350 && event.pointerId === e.pointerId), { signal: gesture.signal });
        signal.addEventListener('abort', () => finish(false), { signal: gesture.signal });
      });
      button.addEventListener('contextmenu', e => { e.preventDefault(); window.clearTimeout(timer); timer = undefined; pressed = true; menu(space, button); });
      button.addEventListener('keydown', e => { if (e.key === 'F2' || e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); menu(space, button); } });
      button.addEventListener('click', () => { cancel(); if (pressed) { pressed = false; return; } if (space.roomId === options.currentRoom && !space.waiting && options.presentation !== 'sidebar') close(); else void run(async () => { await options.select(space); dialog.close({ animate: false }); }); });
    });
  }
  if (embedded) {
    const observer = new MutationObserver(() => { if (!sheet.isConnected) lifetime.abort(); });
    observer.observe(root, { childList: true });
    signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  }
  if (options.initialSettings) { settings(); sheet.querySelector('.space-drawer-scroll')!.scrollTop = options.settingsScrollTop ?? 0; } else list();
  // Resolve the initial offscreen position before the dialog's next-frame reveal.
  void sheet.offsetHeight;
  if (options.refreshSpaces) {
    let refreshTimer: number | undefined;
    const refresh = async () => {
      if (signal.aborted) return;
      try {
        if (!busy && !document.hidden && !root.querySelector('.space-context-overlay,.space-modal-overlay')) {
          const spaces = await options.refreshSpaces!(signal);
          if (signal.aborted) return;
          if (!busy && !root.querySelector('.space-context-overlay,.space-modal-overlay') && JSON.stringify(spaces) !== JSON.stringify(options.spaces)) {
            options.spaces.splice(0, options.spaces.length, ...spaces);
            if (sheet.querySelector('.space-list')) list();
          }
        }
      } catch { /* Retain confirmed rows while offline; retry without closing the drawer. */ }
      if (!signal.aborted) refreshTimer = window.setTimeout(refresh, 3000);
    };
    signal.addEventListener('abort', () => window.clearTimeout(refreshTimer), { once: true });
    refreshTimer = window.setTimeout(refresh, 3000);
  }
  const expiredRooms = new Set<string>();
  const paintCountdowns = () => {
    const presence = sheet.querySelector<HTMLButtonElement>('#presence-style-setting');
    if (presence) {
      presence.disabled = options.canStylePresence?.() === false;
      presence.querySelector('.space-setting-value')!.textContent = presence.disabled ? '加入密室后可设置' : readPresenceStyle() === 'heart' ? '心动按钮' : '在线胶囊';
    }
    const now = Date.now();
    sheet.querySelectorAll<HTMLElement>('[data-expires]').forEach(node => {
      const expiry = Number(node.dataset.expires);
      const remaining = expiry - now;
      const space = options.spaces[Number(node.dataset.countdown)];
      node.textContent = remaining <= 0 ? '等待对方加入 · 已到期' : `等待对方加入 · 剩余 ${formatPendingCountdown(remaining)}`;
      if (remaining <= 0 && space && !expiredRooms.has(space.roomId)) { expiredRooms.add(space.roomId); options.expired?.(space); }
    });
  };
  paintCountdowns();
  const countdownTimer = window.setInterval(paintCountdowns, 1000);
  signal.addEventListener('abort', () => window.clearInterval(countdownTimer), { once: true });
  if(options.authorization){const timer=window.setInterval(authorizations,250);signal.addEventListener('abort',()=>window.clearInterval(timer),{once:true});}
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
  overlay.innerHTML = `<section class="space-invite-sheet"><button class="half-sheet-handle space-invite-handle" id="invite-close" type="button" aria-label="关闭邀请"><span></span></button>${options.content}</section>`;
  root.append(overlay);
  const dialog = mountDialog(overlay, { signal: options.signal, isActive: () => !options.signal.aborted, onClose: () => { if (overlay.isConnected) options.closed(); } });
  overlay.addEventListener('click', e => { if (e.target === overlay) dialog.close(); });
  bindHalfSheetHandle(overlay.querySelector<HTMLButtonElement>('.space-invite-handle')!, overlay.firstElementChild as HTMLElement, options.signal, () => dialog.close());
  return overlay;
}
