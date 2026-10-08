// Standalone presentation model: no app entry, service worker, storage or network API.
const root = document.querySelector('#app'), chat = root.querySelector('.demo-chat');
const status = root.querySelector('#demo-status');
const spaces = [{ name: '日常', waiting: false }];
let current = 0, origin = 'list', epoch = 0, nextOutcome = '', listScroll = 0;
const svg = (path) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="${path}"/></svg>`;
const closeIcon = svg('M6 6l12 12M18 6L6 18'), arrow = svg('M9 5l7 7-7 7');
function clearPanels() { root.querySelectorAll('.space-drawer-overlay,.space-invite-overlay,.space-embedded').forEach(el => el.remove()); chat.inert = false; }
function announce(text) { status.textContent = text; }
function showList(focus = false) {
  clearPanels();
  const desktop = innerWidth >= 1024;
  const overlay = document.createElement('div');
  overlay.className = desktop ? 'space-embedded space-sidebar' : 'space-drawer-overlay is-visible';
  overlay.setAttribute('role', desktop ? 'region' : 'dialog'); overlay.setAttribute('aria-label', '私密空间');
  if (!desktop) { overlay.setAttribute('aria-modal', 'true'); chat.inert = true; }
  overlay.innerHTML = `<section class="space-drawer"><header class="space-drawer-header"><h2>私密空间</h2><button class="icon-button space-close" aria-label="关闭空间列表">${closeIcon}</button></header><div class="space-drawer-scroll"><div class="space-list">${row(current, true)}<div class="space-list-heading"><span>其他空间</span><span>${spaces.length - 1}</span></div>${spaces.map((_, i) => i === current ? '' : row(i, false)).join('')}</div><p class="form-error" role="alert"></p></div><footer class="space-drawer-footer"><button class="space-create" id="space-create">${svg('M12 5v14M5 12h14')}创建新空间</button></footer></section>`;
  root.append(overlay);
  overlay.querySelector('.space-drawer-scroll').scrollTop = listScroll;
  overlay.querySelector('.space-close').onclick = () => { clearPanels(); document.querySelector('#open-spaces').focus(); };
  overlay.onclick = e => { if (e.target === overlay) clearPanels(); };
  overlay.querySelector('#space-create').onclick = () => {
    listScroll = overlay.querySelector('.space-drawer-scroll').scrollTop;
    if (nextOutcome) { const result = nextOutcome; nextOutcome = ''; overlay.querySelector('.form-error').textContent = result === 'cancel' ? '创建已取消，可以重试。' : '创建失败，请重试。'; return; }
    spaces.push({ name: `私密空间 ${spaces.length + 1}`, waiting: true }); current = spaces.length - 1; origin = 'list'; showInvite();
  };
  overlay.querySelectorAll('[data-space]').forEach(button => button.onclick = () => { current = Number(button.dataset.space); origin = 'list'; if (spaces[current].waiting) showInvite(); else { clearPanels(); announce(`已打开 ${spaces[current].name}（模拟）`); } });
  overlay.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); clearPanels(); document.querySelector('#open-spaces').focus(); } };
  if (focus) overlay.querySelector(`[data-space="${current}"]`).focus({ preventScroll: true });
}
function row(i, selected) { const s = spaces[i]; return `<button class="space-row ${selected ? 'is-selected' : ''}" data-space="${i}" aria-current="${selected}"><span class="space-row-copy">${selected ? '<small class="space-current-label">当前空间</small>' : ''}<strong>${s.name}</strong><span class="space-message-preview ${s.waiting ? 'is-waiting' : ''}">${s.waiting ? '等待对方加入 · 可继续邀请' : '下午见。'}</span></span>${selected ? `<span class="space-selected-check">${svg('M5 12l4 4L19 6')}</span>` : `<span class="space-row-arrow">${arrow}</span>`}</button>`; }
function showInvite() {
  clearPanels(); chat.inert = true;
  const activeEpoch = ++epoch, overlay = document.createElement('div');
  overlay.className = 'space-invite-overlay is-visible'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'space-invite-title');
  overlay.innerHTML = `<section class="space-invite-sheet"><div class="space-invite-handle" aria-hidden="true"><span></span></div><header><span class="space-invite-name">${spaces[current].name}</span><button class="icon-button" id="invite-close" aria-label="关闭邀请">${closeIcon}</button></header><div class="space-invite-body"><h1 id="space-invite-title">邀请对方加入</h1><p>把邀请链接发给对方，<br>开启只属于你们的对话。</p><div class="space-invite-status"><i></i><span>等待对方打开邀请</span></div></div><footer class="space-invite-actions"><button class="primary-button" id="copy-invite">复制邀请链接</button><p>关闭后，你可以在空间列表中继续邀请。</p></footer></section>`;
  root.append(overlay);
  const close = () => { if (activeEpoch !== epoch) return; ++epoch; if (origin === 'list' && spaces[current].waiting) { showList(true); announce('已返回列表，待加入空间保留。'); } else { clearPanels(); announce('首次创建入口：邀请已关闭，保留原聊天底层。'); } };
  overlay.querySelector('#invite-close').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  overlay.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  overlay.querySelector('#copy-invite').onclick = e => { e.target.textContent = '已复制（模拟）'; };
  const handle = overlay.querySelector('.space-invite-handle'); let start = null;
  handle.onpointerdown = e => { start = e.clientY; handle.setPointerCapture(e.pointerId); };
  handle.onpointermove = e => { if (start !== null) overlay.querySelector('.space-invite-sheet').style.setProperty('--invite-drag', `${Math.max(0, e.clientY - start)}px`); };
  handle.onpointerup = e => { if (start !== null && e.clientY - start > 80) close(); else overlay.querySelector('.space-invite-sheet').style.removeProperty('--invite-drag'); start = null; };
  handle.onpointercancel = () => { start = null; overlay.querySelector('.space-invite-sheet').style.removeProperty('--invite-drag'); };
  overlay.querySelector('#invite-close').focus();
}
document.querySelector('#open-spaces').onclick = () => { origin = 'list'; showList(); };
document.querySelector('#first-entry').onclick = () => { spaces.push({ name: '首次空间', waiting: true }); current = spaces.length - 1; origin = 'first'; showInvite(); };
document.querySelector('#join').onclick = () => { ++epoch; spaces[current].waiting = false; clearPanels(); announce('对方已加入：进入聊天，旧关闭回调不再返回列表。'); };
document.querySelector('#lock').onclick = e => { e.stopPropagation(); ++epoch; clearPanels(); chat.classList.add('is-locked'); };
chat.onclick = () => { if (chat.classList.contains('is-locked')) { chat.classList.remove('is-locked'); announce('重新进入模拟。正式实现仍要求原保护解锁。'); } };
document.querySelector('#cancel-create').onclick = () => { nextOutcome = 'cancel'; showList(); };
document.querySelector('#fail-create').onclick = () => { nextOutcome = 'fail'; showList(); };
// Prototype-only shortcuts keep external event simulations reachable behind a modal.
document.addEventListener('keydown', e => { if (e.altKey && e.key.toLowerCase() === 'j') document.querySelector('#join').click(); if (e.altKey && e.key.toLowerCase() === 'l') document.querySelector('#lock').click(); });
