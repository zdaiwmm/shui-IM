import { dismissDraggedPanel, motion, retargetMotion, settleValue } from './motion';
import { mountDialog } from './dialog';
import type { PrivateSpace } from './spaces';
import { createElement, Bell, Settings2, PanelsTopLeft, Smartphone, KeyRound, Upload, Download, EyeOff, History, Heart, Pencil, Check, X, Plus, ChevronRight, Trash2, PanelLeftClose, Palette, MonitorDown } from 'lucide';
import { formatPendingCountdown, pendingSpaceExpiry } from './spaces';
export type PresenceStyle = 'capsule' | 'heart';
export function readPresenceStyle(): PresenceStyle { try { return localStorage.getItem('quiet-room:presence-style') === 'heart' ? 'heart' : 'capsule'; } catch { return 'capsule'; } }
export function writePresenceStyle(style: PresenceStyle): void { localStorage.setItem('quiet-room:presence-style', style); }
export const spaceIcons = {
  bell: createElement(Bell).outerHTML, settings: createElement(Settings2).outerHTML, spaces: createElement(PanelsTopLeft).outerHTML,
  device: createElement(Smartphone).outerHTML, key: createElement(KeyRound).outerHTML,
  upload: createElement(Upload).outerHTML, download: createElement(Download).outerHTML,
  cover: createElement(EyeOff).outerHTML, history: createElement(History).outerHTML,
  appearance: createElement(Palette).outerHTML, app: createElement(MonitorDown).outerHTML,
};
const arrow = createElement(ChevronRight).outerHTML, check = createElement(Check).outerHTML, heart = createElement(Heart).outerHTML;
const closeIcon = createElement(X).outerHTML;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
type Action = { id: string; label: string; icon: string; group?: '当前空间' | '本机' | '关于'; keepOpen?: boolean; run: () => void | Promise<void> };

/** Follow the visual viewport when the native keyboard opens, without resizing the chat. */
export function fitViewport(element: HTMLElement, signal: AbortSignal) {
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
  presentation?: 'sidebar' | 'settings'; container?: HTMLElement; openSettings?: () => void;
  spaces: PrivateSpace[]; currentRoom: string; signal: AbortSignal; actions: Action[]; icons?: { close: string; plus: string; settings: string };
  select: (space: PrivateSpace) => Promise<void>; create: () => Promise<void>; rename: (space: PrivateSpace, name: string) => Promise<void>;
removeLabel?: (space: PrivateSpace) => string; initialSettings?: boolean; settingsScrollTop?: number; onSettingsLeave?: (scrollTop: number) => void;
  remove?: (space: PrivateSpace) => Promise<void>; expired?: (space: PrivateSpace) => void;
  listScrollTop?: number;
  refreshUnread?: (signal: AbortSignal) => Promise<void>;
  refreshSpaces?: (signal: AbortSignal) => Promise<PrivateSpace[]>;
  authorization?: (space: PrivateSpace) => {deadline:number;open:()=>Promise<void>} | undefined;
  styleChanged: (style: PresenceStyle) => void; closed: () => void;
}): void {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const sheet = document.createElement('div'); sheet.className = 'space-drawer-overlay' + (options.initialSettings ? ' is-visible is-restored' : ''); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', '私密空间');
  const embedded = Boolean(options.presentation);
  if (embedded) { sheet.className = `space-embedded space-${options.presentation}`; sheet.removeAttribute('aria-modal'); sheet.setAttribute('role', 'region'); }
  (options.container ?? root).append(sheet);
  let busy = false, listScrollTop = options.listScrollTop ?? 0;
  const dialog = embedded ? { close: (_options?: { animate?: boolean; restoreFocus?: boolean }) => { /* Embedded navigation owns its page lifetime. */ } } : mountDialog(sheet, { signal: options.signal, isActive: () => !options.signal.aborted, beforeClose: () => !busy, onClose: () => {
    lifetime.abort(); options.closed();
  } });
  if (embedded) signal.addEventListener('abort', () => sheet.remove(), { once: true });
  const close = () => { if (embedded) { if (!busy) options.closed(); } else dialog.close(); };
  sheet.addEventListener('click', e => { if (e.target === sheet && !busy) close(); });
  function page(title: string, body: string, footer = '', back?: () => void) {
    if (sheet.querySelector('.space-list')) listScrollTop = sheet.querySelector('.space-drawer-scroll')!.scrollTop;
    const priorTitle = sheet.getAttribute('aria-label');
    const previousBody = sheet.querySelector<HTMLElement>('.space-drawer-scroll');
    const previousPaint = previousBody ? getComputedStyle(previousBody).translate : '0 0';
    sheet.setAttribute('aria-label', title);
    sheet.classList.toggle('is-settings-page', title === '设置' || title === '在线状态样式');
    sheet.innerHTML = `<section class="space-drawer"><header class="space-drawer-header">${back ? `<button class="icon-button space-back" aria-label="返回">${arrow}</button>` : ''}<h2>${title}</h2><button class="icon-button space-close" aria-label="${options.presentation === 'sidebar' ? '收起空间侧栏' : '关闭'}">${options.presentation === 'sidebar' ? createElement(PanelLeftClose).outerHTML : closeIcon}</button></header><div class="space-drawer-scroll">${body}<p class="form-error" role="alert"></p></div>${footer ? `<footer class="space-drawer-footer">${footer}</footer>` : ''}</section>`;
    if (previousBody && priorTitle !== title) {
      const content = sheet.querySelector<HTMLElement>('.space-drawer-scroll')!;
      retargetMotion(content, null, { opacity: .8, translate: previousPaint === 'none' || previousPaint === '0px' ? `${back ? 16 : -16}px 0` : previousPaint },
        { opacity: 1, translate: '0 0' }, motion.local);
    }
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
    if (busy || signal.aborted || space.accessState || root.querySelector('.space-context-overlay')) return;
    const overlay = document.createElement('div'); overlay.className = 'space-context-overlay'; overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-label',space.name);
const removable = Boolean(options.remove && space.waiting && !space.accessState);
    overlay.innerHTML = `<div class="space-context-menu"><button id="space-rename">${createElement(Pencil).outerHTML}<span>编辑空间名称</span></button>${removable ? `<button id="space-delete" class="is-danger">${createElement(Trash2).outerHTML}<span>${escape(options.removeLabel?.(space) ?? '删除空间')}</span></button>` : ''}</div>`;
    root.append(overlay);
    const dialog = mountDialog(overlay, { signal, isActive: () => !signal.aborted, returnFocus: origin });
    const rect = origin.getBoundingClientRect(), popup = overlay.firstElementChild as HTMLElement;
    const viewport = visualViewport, top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? innerHeight);
    popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 212))}px`;
popup.style.top = `${Math.max(top + 12, Math.min(rect.bottom - 6, bottom - (removable ? 124 : 70)))}px`;
    overlay.addEventListener('click', e => { if (e.target === overlay) dialog.close({ animate: false }); });
    overlay.querySelector('#space-rename')!.addEventListener('click', () => { dialog.close({ animate: false, restoreFocus: false }); rename(space, origin); });
    overlay.querySelector('#space-delete')?.addEventListener('click', () => {
      dialog.close({ animate: false, restoreFocus: false });
      void run(async () => {
        await options.remove!(space);
        if (signal.aborted) return;
        const index = options.spaces.indexOf(space);
        if (index >= 0) options.spaces.splice(index, 1);
        list();
      });
    });
  }
  function styles() {
    const value = readPresenceStyle();
    page('在线状态样式', `<p class="space-description">选择聊天页顶部的显示方式。</p><div class="space-style-options" role="radiogroup" aria-label="在线状态样式">${(['capsule','heart'] as const).map(s => `<button class="space-style-choice" role="radio" tabindex="${s === value ? 0 : -1}" aria-checked="${s === value}" data-style="${s}"><span class="space-style-preview ${s}" aria-hidden="true">${s === 'capsule' ? `<span>TA</span>${heart}<span>我</span>` : heart}</span><span class="space-style-copy"><strong>${s === 'capsule' ? '在线胶囊' : '心动按钮'}</strong><small>${s === 'capsule' ? '居中显示双方状态 · 默认样式' : '红色爱心，显示在聊天页右上角'}</small></span><i class="space-radio" aria-hidden="true">${check}</i></button>`).join('')}</div><div class="space-presence-note"><p>左半颗代表对方，右半颗代表你。</p><p>在线状态不代表消息已读。</p></div>`, '', settings);
    const choose = (button: HTMLButtonElement) => {
      try { writePresenceStyle(button.dataset.style as PresenceStyle); options.styleChanged(readPresenceStyle()); }
      catch { sheet.querySelector('.form-error')!.textContent = '浏览器未能保存设置，请重试'; return; }
      sheet.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(b => { b.setAttribute('aria-checked',String(b === button)); b.tabIndex = b === button ? 0 : -1; });
    };
    sheet.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(button => {
      button.addEventListener('click', () => choose(button));
      button.addEventListener('keydown', e => { if (['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(e.key)) { e.preventDefault(); const buttons = [...sheet.querySelectorAll<HTMLButtonElement>('[data-style]')]; const next = e.key === 'Home' ? buttons[0]! : e.key === 'End' ? buttons.at(-1)! : buttons.find(b => b !== button)!; choose(next); next.focus(); } });
    });
  }
  function settings() {
    const setting = (a: Action) => `<button class="space-setting" id="${a.id}"><span class="space-setting-icon" data-setting="${a.id}" aria-hidden="true">${a.icon}</span><span class="space-setting-label">${escape(a.label)}</span>${arrow}</button>`;
    const order = ['appearance-settings', 'auto-lock-settings', 'app-access-settings', 'notification-settings', 'manage-devices', 'passkey-management', 'backup-settings', 'local-history-backup', 'local-history-restore', 'recover-other-space', 'cover-practice-menu', 'release-history'];
    const actions = [...options.actions].sort((a, b) => (order.indexOf(a.id) < 0 ? 99 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 99 : order.indexOf(b.id)));
    const groups = [
      ['appearance-settings', 'presence-style-setting', 'notification-settings', 'app-access-settings'],
      ['auto-lock-settings', 'manage-devices', 'passkey-management', 'cover-practice-menu'],
      ['backup-settings', 'local-history-backup', 'local-history-restore', 'recover-other-space'],
      ['release-history'],
    ];
    const presence = `<button class="space-setting" id="presence-style-setting"><span class="space-setting-icon" data-setting="presence-style-setting" aria-hidden="true">${heart}</span><span class="space-setting-label">在线状态样式</span><small class="space-setting-value">${readPresenceStyle() === 'heart' ? '心动按钮' : '在线胶囊'}</small>${arrow}</button>`;
    const known = new Set(groups.flat());
    const cards = groups.map(ids => ids.map(id => id === 'presence-style-setting' ? presence : actions.filter(a => a.id === id).map(setting).join('')).join('')).filter(Boolean);
    const other = actions.filter(a => !known.has(a.id)).map(setting).join('');
    if (other) cards.push(other);
    page('设置', `<div class="space-settings-list">${cards.map(card => `<div class="space-setting-card">${card}</div>`).join('')}</div>`, '', options.presentation === 'settings' ? close : list);
    sheet.querySelector('#presence-style-setting')!.addEventListener('click', () => { styles(); sheet.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus(); });
    for (const action of options.actions) sheet.querySelector(`#${action.id}`)!.addEventListener('click', () => { if (action.keepOpen) void run(async () => { await action.run(); }); else { options.onSettingsLeave?.(sheet.querySelector('.space-drawer-scroll')!.scrollTop); dialog.close({ animate: false }); void action.run(); } });
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
    const status = s.accessState === 'unprepared' ? '请先在原设备打开此空间' : s.accessState === 'restricted' ? '待对方授权' : s.waiting ? waitingCopy : s.preview || '打开空间查看消息';
    const statusLine = s.waiting && !s.accessState
      ? `<small class="space-message-preview is-waiting" ${expiry ? `data-expires="${expiry}" data-countdown="${i}"` : ''}>${escape(waitingCopy)}</small>`
      : selected ? '' : `<small class="space-message-preview">${escape(status)}</small>`;
    return `<div class="space-access-row"><button class="space-row ${selected ? 'is-selected' : ''}" data-space="${i}" aria-current="${selected ? 'true' : 'false'}"><span class="space-row-copy">${selected ? '<small class="space-current-label">当前空间</small>' : ''}<strong>${escape(s.name)}</strong>${statusLine}</span>${selected ? `<span class="space-selected-check" aria-hidden="true">${check}</span>` : `<span class="space-row-trailing"><span class="space-unread" data-unread="${i}" hidden></span><span class="space-row-arrow" aria-hidden="true">${arrow}</span></span>`}</button><button class="space-access-action" data-access="${i}" hidden>授权</button></div>`;
  }
  function list() {
    const focused = sheet.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    const focusedRoom = focused?.dataset.space ? options.spaces[Number(focused.dataset.space)]?.roomId : undefined;
    const focusedId = focused?.id;
    const current = options.spaces.find(s => s.roomId === options.currentRoom), others = options.spaces.filter(s => s !== current);
    page('私密空间', `<div class="space-list">${current ? row(current) : ''}<div class="space-list-heading"><span>其他空间</span><span>${others.length}</span></div>${others.map(row).join('')}${!others.length ? '<p class="space-empty">想和另一个人聊聊？<br>从下方创建一个新空间。</p>' : ''}</div>`, `<button class="space-create" id="space-create">${createElement(Plus).outerHTML}创建新空间</button><button class="space-settings-entry" id="space-settings" aria-label="设置">${spaceIcons.settings}</button>`);
    sheet.querySelector('.space-drawer-scroll')!.scrollTop = listScrollTop; badges();authorizations();
    if (focusedRoom) sheet.querySelector<HTMLButtonElement>(`[data-space="${options.spaces.findIndex(s => s.roomId === focusedRoom)}"]`)?.focus({ preventScroll: true });
    else if (focusedId) sheet.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`)?.focus({ preventScroll: true });
    sheet.querySelectorAll<HTMLButtonElement>('[data-access]').forEach(button=>button.addEventListener('click',()=>{const space=options.spaces[Number(button.dataset.access)]!;const action=options.authorization?.(space);if(action&&action.deadline>performance.now()){dialog.close({animate:false});void action.open();}}));
    sheet.querySelector('#space-settings')!.addEventListener('click', () => { if (options.openSettings) options.openSettings(); else { settings(); sheet.querySelector<HTMLButtonElement>('.space-back')?.focus(); } });
    sheet.querySelector('#space-create')!.addEventListener('click', () => void run(async () => { await options.create(); dialog.close({ animate: false }); }));
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
  overlay.innerHTML = `<section class="space-invite-sheet"><div class="space-invite-handle" aria-hidden="true"><span></span></div><header><span class="space-invite-name">${escape(options.name)}</span><button class="icon-button" id="invite-close" aria-label="关闭邀请">${closeIcon}</button></header>${options.content}</section>`;
  root.append(overlay);
  const dialog = mountDialog(overlay, { signal: options.signal, isActive: () => !options.signal.aborted, onClose: () => { if (overlay.isConnected) options.closed(); } });
  overlay.querySelector('#invite-close')!.addEventListener('click', () => dialog.close());
  overlay.addEventListener('click', e => { if (e.target === overlay) dialog.close(); });
  const handle = overlay.querySelector<HTMLElement>('.space-invite-handle')!;
  const panel = overlay.querySelector<HTMLElement>('.space-invite-sheet')!;
  let drag: { id: number; y: number; offset: number; lastY: number; at: number; velocity: number } | null = null;
  let offset = 0;
  let cancelSettle: (() => void) | undefined;
  const paint = (value: number) => {
    offset = value; panel.style.setProperty('--invite-drag', `${value}px`);
    overlay.style.setProperty('--invite-backdrop', String(.22 * Math.max(.2, 1 - value / Math.max(1, panel.clientHeight))));
  };
  const release = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.id) return;
    const velocity = performance.now() - drag.at < 100 ? drag.velocity : 0;
    drag = null;
    if (!cancelled && dismissDraggedPanel(offset, velocity, panel.clientHeight)) {
      panel.classList.remove('is-dragging');
      dialog.close();
    } else {
      cancelSettle = settleValue(offset, cancelled ? 0 : velocity, paint, () => panel.classList.remove('is-dragging'),
        () => panel.isConnected && !options.signal.aborted && !overlay.classList.contains('is-closing'));
    }
  };
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary || overlay.classList.contains('is-closing')) return;
    cancelSettle?.();
    offset = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
    drag = { id: e.pointerId, y: e.clientY, offset, lastY: e.clientY, at: performance.now(), velocity: 0 };
    panel.classList.add('is-dragging'); paint(offset);
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const now = performance.now();
    const elapsed = now - drag.at;
    if (elapsed > 0) drag.velocity = Math.max(-2000, Math.min(2000, (e.clientY - drag.lastY) * 1000 / elapsed));
    drag.lastY = e.clientY; drag.at = now;
    const limit = Math.max(1, panel.clientHeight);
    const distance = Math.max(0, drag.offset + e.clientY - drag.y);
    paint(limit * Math.tanh(distance / limit));
  });
  handle.addEventListener('pointerup', e => release(e, false));
  handle.addEventListener('pointercancel', e => release(e, true));
  options.signal.addEventListener('abort', () => { cancelSettle?.(); drag = null; }, { once: true });
  return overlay;
}
