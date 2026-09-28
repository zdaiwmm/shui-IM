// Isolated review prototype. No network, persistence, app entry point or Service Worker.
const $ = (selector) => document.querySelector(selector);
const timeline = $('#timeline');
const draft = $('#draft');
const composer = $('#composer');
const menu = $('#menu');
const viewer = $('#viewer');
const phone = $('.phone');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const state = { panel: 'none', pinned: true, unread: 0, reply: null, returns: [], locked: false, epoch: 0, sequence: 0, draftVersion: 0, sending: new Set(), category: 'recent', menuRow: null, viewerSource: null, pointer: null, composing: false };
const motion = new Map();
const timers = new Set();
const pickerPositions = new Map();
const reduce = () => motionPreference.matches || $('#reduce-motion').checked;
const sleep = (fn, delay) => { const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; };
const rows = () => [...timeline.querySelectorAll('.row')];
const bottom = () => Math.max(0, timeline.scrollHeight - timeline.clientHeight);
const atBottom = () => bottom() - timeline.scrollTop < 4;

function say(text) {
  $('#notice').textContent = text;
  $('#notice').hidden = false;
  const epoch = state.epoch;
  sleep(() => { if (epoch === state.epoch && $('#notice').textContent === text) $('#notice').hidden = true; }, 3600);
}
function animate(node, frames, duration = 240) {
  motion.get(node)?.cancel();
  motion.delete(node);
  if (reduce() || state.locked) return;
  const animation = node.animate(frames, { duration, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
  animation.currentTime = 0;
  motion.set(node, animation);
  const release = () => { if (motion.get(node) === animation) motion.delete(node); };
  void animation.finished.then(release, release);
}
function stopMotion() { for (const a of motion.values()) a.cancel(); motion.clear(); }
function captureAnchor() {
  const top = timeline.getBoundingClientRect().top;
  const row = rows().find(node => node.getBoundingClientRect().bottom > top + 2);
  return { id: row?.id, offset: row ? row.getBoundingClientRect().top - top : 0, top: timeline.scrollTop, pinned: state.pinned };
}
function restoreAnchor(anchor) {
  if (!anchor) return;
  const row = anchor.id && document.getElementById(anchor.id);
  if (anchor.pinned) timeline.scrollTop = bottom();
  else if (row) timeline.scrollTop += row.getBoundingClientRect().top - timeline.getBoundingClientRect().top - anchor.offset;
  else timeline.scrollTop = Math.min(anchor.top, bottom());
}
// Capture the current painted positions before cancellation, commit layout once,
// and install inverse transforms in the same task. Input/header never fade out.
function transaction(change, { follow = state.pinned, animated = true, source = null } = {}) {
  const anchor = captureAnchor();
  const top = timeline.getBoundingClientRect().top;
  const edge = timeline.getBoundingClientRect().bottom;
  const visible = rows().filter(row => { const r = row.getBoundingClientRect(); return r.bottom >= top && r.top <= edge; });
  const positions = new Map(visible.map(row => [row, row.getBoundingClientRect().top]));
  const composerBottom = composer.getBoundingClientRect().bottom;
  stopMotion();
  change();
  state.pinned = follow;
  if (follow) timeline.scrollTop = bottom(); else restoreAnchor({ ...anchor, pinned: false });
  if (animated && !reduce()) {
    for (const [row, oldTop] of positions) {
      if (!row.isConnected) continue;
      const offset = oldTop - row.getBoundingClientRect().top;
      if (Math.abs(offset) > .5) animate(row, [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }]);
    }
    // The composer grows upward. Retarget its painted bottom so a new line
    // cannot push the enlarged input below the viewport for one frame.
    const delta = composerBottom - composer.getBoundingClientRect().bottom;
    if (Math.abs(delta) > .5) animate(composer, [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }]);
    if (source) {
      const newest = timeline.lastElementChild;
      if (newest && !positions.has(newest)) {
        const offset = Math.max(10, Math.min(120, source.top - newest.getBoundingClientRect().top));
        animate(newest, [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], 260);
      }
    }
  }
  updateControls();
}
function updateControls() {
  if (state.pinned) state.unread = 0;
  $('#latest').hidden = state.pinned;
  $('#latest').textContent = state.unread ? `↓ ${state.unread} 条新消息` : '↓ 最新消息';
  $('#return').hidden = state.returns.length === 0;
}
function resizeDraft() {
  draft.style.height = '44px';
  draft.style.height = `${Math.min(132, Math.max(44, draft.scrollHeight))}px`;
}
function setPanel(panel) {
  if (state.locked) return;
  const oldPanel = state.panel;
  if (oldPanel === 'expressions') pickerPositions.set(state.category, $('#expression-grid').scrollTop);
  state.panel = panel;
  transaction(() => {
    $('#deck').hidden = panel === 'none' || (panel === 'keyboard' && !$('#simulate-keyboard').checked);
    $('#keyboard').hidden = panel !== 'keyboard';
    $('#picker').hidden = panel !== 'expressions';
    $('#expressions').setAttribute('aria-expanded', String(panel === 'expressions'));
  });
  if (panel === 'expressions') {
    draft.blur();
    $('#expression-grid').scrollTop = pickerPositions.get(state.category) || 0;
  }
}
function addMessage({ text, outgoing = false, kind = 'text', reply = null, status = '✓', id = null }) {
  const row = document.createElement('article');
  row.className = `row${outgoing ? ' outgoing' : ''}`;
  row.id = id || `message-${++state.sequence}`;
  row.dataset.text = text;
  row.tabIndex = -1;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (reply) {
    const quote = document.createElement('button');
    quote.className = 'quote';
    const label = document.createElement('small'); label.textContent = '回复';
    const excerpt = document.createElement('span'); excerpt.textContent = reply.text;
    quote.append(label, excerpt);
    quote.addEventListener('click', () => jumpTo(reply.id));
    bubble.append(quote);
  }
  if (kind === 'image') {
    const picture = document.createElement('button');
    picture.className = 'media landscape';
    picture.setAttribute('aria-label', '打开模拟图片');
    picture.addEventListener('click', () => openViewer(picture));
    bubble.append(picture);
  } else {
    const content = document.createElement('div'); content.textContent = text;
    content.className = kind === 'expression' ? 'expression' : 'message-text';
    bubble.append(content);
  }
  const metadata = document.createElement('span');
  metadata.className = 'meta'; metadata.textContent = '14:26';
  if (outgoing) {
    const receipt = document.createElement('span'); receipt.className = 'receipt'; receipt.textContent = status;
    receipt.setAttribute('aria-label', status === '◷' ? '等待发送' : '服务器已保存（模拟）'); metadata.append(receipt);
  }
  bubble.append(metadata); row.append(bubble); timeline.append(row);
  row.addEventListener('contextmenu', event => { event.preventDefault(); openMenu(row); });
  row.addEventListener('pointerdown', event => startGesture(event, row));
  row.addEventListener('click', event => { if (row.dataset.suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); delete row.dataset.suppressClick; } }, true);
  return row;
}
function settleReceipt(row) {
  const epoch = state.epoch;
  sleep(() => {
    if (epoch !== state.epoch || !row.isConnected || state.locked || $('#offline').checked || row.querySelector('.media-status')) return;
    const receipt = row.querySelector('.receipt');
    if (receipt) { receipt.textContent = '✓'; receipt.setAttribute('aria-label', '服务器已保存（模拟）'); }
  }, 650);
}
async function sendText(event) {
  event?.preventDefault();
  if (state.locked || state.composing) return;
  const text = draft.value.trim(); const version = state.draftVersion;
  if (!text || state.sending.has(version)) return;
  const reply = state.reply; const epoch = state.epoch;
  const fail = $('#fail-save').checked; $('#fail-save').checked = false;
  state.sending.add(version); $('#send').dataset.saving = 'true';
  // Simulate the durable local enqueue, not a real persistence operation.
  await new Promise(resolve => setTimeout(resolve, 120));
  state.sending.delete(version);
  if (!state.sending.size) delete $('#send').dataset.saving;
  if (state.locked || epoch !== state.epoch) return;
  if (fail) { say('消息未能安全保存，草稿已保留。可再次发送。'); return; }
  const source = draft.getBoundingClientRect(); let row;
  transaction(() => {
    row = addMessage({ text, outgoing: true, reply, status: '◷' });
    if (state.draftVersion === version) { draft.value = ''; state.draftVersion++; resizeDraft(); }
    if (state.reply === reply) { state.reply = null; $('#reply-draft').hidden = true; }
    state.returns = [];
  }, { follow: true, source });
  settleReceipt(row);
}
function receive() {
  if (state.locked) return;
  const follow = state.pinned;
  transaction(() => addMessage({ text: '刚看到一片很好看的云，晚一点发给你。' }), { follow });
  if (!follow) { state.unread++; updateControls(); }
}
function setReply(row) {
  if (!row?.isConnected || state.locked) return;
  const text = row.dataset.text;
  closeMenu();
  transaction(() => { state.reply = { id: row.id, text }; $('#reply-text').textContent = text; $('#reply-draft').hidden = false; });
  draft.focus({ preventScroll: true });
}
function jumpTo(id) {
  const target = document.getElementById(id);
  if (!target) { say('这台设备未保存可读取的原消息'); return; }
  state.returns.push(captureAnchor()); if (state.returns.length > 10) state.returns.shift();
  stopMotion(); state.pinned = false;
  timeline.scrollTop += target.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 48;
  target.classList.add('highlight');
  sleep(() => target.classList.remove('highlight'), 1400);
  updateControls();
}
function returnToReading() {
  const anchor = state.returns.pop(); if (!anchor) return;
  stopMotion(); state.pinned = anchor.pinned; restoreAnchor(anchor); updateControls();
}
function goLatest() { stopMotion(); state.pinned = true; timeline.scrollTop = bottom(); state.returns = []; updateControls(); }
function openMenu(row) {
  if (state.locked || viewer.open) return;
  closeMenu(); stopMotion(); state.menuRow = row;
  const bubble = row.querySelector('.bubble'); bubble.classList.add('menu-source');
  const r = bubble.getBoundingClientRect(); const p = phone.getBoundingClientRect();
  const width = 208; const height = 200;
  menu.style.left = `${Math.max(p.left + 12, Math.min(p.right - width - 12, r.left))}px`;
  menu.style.top = `${Math.max(p.top + 14, Math.min(p.bottom - height - 14, r.bottom + 8))}px`;
  menu.showModal();
  animate(menu, [{ transform: 'translateY(5px)', opacity: .7 }, { transform: 'translateY(0)', opacity: 1 }], 160);
}
function closeMenu() {
  state.menuRow?.querySelector('.bubble')?.classList.remove('menu-source');
  if (menu.open) menu.close();
  motion.get(menu)?.cancel(); motion.delete(menu); state.menuRow = null;
}
function react(emoji) {
  const row = state.menuRow; closeMenu(); if (!row) return;
  transaction(() => {
    let badge = row.querySelector('.reaction');
    if (!badge) { badge = document.createElement('button'); badge.className = 'reaction'; row.append(badge); badge.addEventListener('click', () => transaction(() => badge.remove())); }
    badge.textContent = `${emoji} 1`; badge.setAttribute('aria-label', `取消回应 ${emoji}`);
  });
}
function openViewer(source) {
  if (state.locked || menu.open) return;
  stopMotion(); state.viewerSource = source;
  const p = phone.getBoundingClientRect();
  Object.assign(viewer.style, { top: `${p.top}px`, left: `${p.left}px`, width: `${p.width}px`, height: `${p.height}px` });
  viewer.showModal();
  const original = source.getBoundingClientRect(); const image = $('.viewer-art'); const target = image.getBoundingClientRect();
  image.style.transformOrigin = '0 0';
  animate(image, [{ transform: `translate(${original.left - target.left}px,${original.top - target.top}px) scale(${original.width / target.width},${original.height / target.height})` }, { transform: 'none' }], 240);
}
function closeViewer() {
  if (!viewer.open) return;
  stopMotion(); viewer.close(); state.viewerSource?.focus({ preventScroll: true }); state.viewerSource = null;
}
function startGesture(event, row) {
  if (state.locked || event.button !== 0 || event.target.closest('.quote,.reaction,.retry-media') || row.querySelector('.selectable')) return;
  const gesture = { row, x: event.clientX, y: event.clientY, axis: null, dx: 0, timer: null, start: performance.now(), id: event.pointerId };
  state.pointer = gesture;
  gesture.timer = sleep(() => { if (state.pointer === gesture && !gesture.axis) { state.pointer = null; row.dataset.suppressClick = 'true'; openMenu(row); } }, 450);
}
window.addEventListener('pointermove', event => {
  const g = state.pointer; if (!g || event.pointerId !== g.id) return;
  const dx = g.x - event.clientX; const dy = event.clientY - g.y;
  if (!g.axis && Math.hypot(dx, dy) > 8) {
    clearTimeout(g.timer); timers.delete(g.timer);
    g.axis = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.3 ? 'reply' : 'scroll';
  }
  if (g.axis === 'scroll') return;
  if (g.axis !== 'reply') return;
  event.preventDefault(); g.dx = Math.max(0, dx);
  const offset = Math.min(70, g.dx * .78);
  g.row.querySelector('.bubble').style.transform = `translateX(-${offset}px)`;
  let indicator = g.row.querySelector('.reply-indicator');
  if (!indicator) { indicator = document.createElement('span'); indicator.className = 'reply-indicator'; g.row.append(indicator); }
  indicator.textContent = g.dx >= 64 ? '↩' : '‹';
}, { passive: false });
function finishGesture(event, cancelled = false) {
  const g = state.pointer; if (!g || (event && event.pointerId !== g.id)) return;
  clearTimeout(g.timer); timers.delete(g.timer); state.pointer = null;
  const bubble = g.row.querySelector('.bubble'); const from = bubble.style.transform;
  bubble.style.removeProperty('transform'); g.row.querySelector('.reply-indicator')?.remove();
  if (g.axis === 'reply') {
    g.row.dataset.suppressClick = 'true';
    if (!cancelled && g.dx >= 64) setReply(g.row);
    if (!cancelled) animate(bubble, [{ transform: from || 'none' }, { transform: 'none' }], 180);
    sleep(() => delete g.row.dataset.suppressClick, 100);
  }
}
window.addEventListener('pointerup', event => finishGesture(event));
window.addEventListener('pointercancel', event => finishGesture(event, true));
function renderExpressions() {
  const items = state.category === 'favorites' ? ['❤️','🌿','🙂','☀️','🌙'] : ['🙂','❤️','🌿','☀️','🌙','👍','🥰','👀','🎉','🐱','🌸','☕','🫶','🍃','✨','😌','🍊','🦋','🌼','🤍'];
  $('#expression-grid').replaceChildren(...items.map(emoji => {
    const button = document.createElement('button'); button.textContent = emoji; button.setAttribute('aria-label', `发送 ${emoji}`);
    button.addEventListener('click', () => {
      const fail = $('#fail-save').checked; $('#fail-save').checked = false;
      if (fail) { say('表情未能安全保存，请再次点击发送'); return; }
      let row; transaction(() => { row = addMessage({ text: emoji, kind: 'expression', outgoing: true, status: '◷' }); }, { follow: true }); settleReceipt(row);
    }); return button;
  }));
}
function sendMedia() {
  if (state.locked) return;
  let row; transaction(() => { row = addMessage({ text: '一张山景图片', kind: 'image', outgoing: true, status: '◷' }); }, { follow: true });
  const status = document.createElement('button'); status.className = 'media-status retry-media'; row.querySelector('.media').append(status);
  const attempt = () => {
    if (state.locked || !row.isConnected) return;
    const epoch = state.epoch; status.textContent = '正在准备'; status.disabled = true;
    sleep(() => {
      if (epoch !== state.epoch || !row.isConnected) return;
      if ($('#offline').checked) { status.textContent = '重试'; status.disabled = false; return; }
      status.textContent = '上传 62%';
      sleep(() => { if (epoch !== state.epoch || !row.isConnected) return; status.remove(); settleReceipt(row); }, 650);
    }, 450);
  };
  // The status is an independent control, never nested inside the image button.
  row.querySelector('.media').after(status);
  status.addEventListener('click', event => { event.stopPropagation(); attempt(); }); attempt();
}
function lock() {
  state.locked = true; state.epoch++; stopMotion(); finishGesture(null, true);
  for (const timer of timers) clearTimeout(timer); timers.clear();
  closeMenu(); if (viewer.open) viewer.close();
  state.reply = null; state.returns = []; state.viewerSource = null; state.sending.clear();
  draft.value = ''; state.draftVersion++; timeline.replaceChildren();
  $('#privacy').hidden = false; $('.chat').inert = true; $('#unlock').focus();
}
function reset() {
  state.epoch++; stopMotion(); finishGesture(null, true);
  for (const timer of timers) clearTimeout(timer); timers.clear();
  closeMenu(); if (viewer.open) viewer.close();
  Object.assign(state, { locked: false, panel: 'none', pinned: true, unread: 0, reply: null, returns: [], sequence: 0, viewerSource: null });
  state.sending.clear(); state.draftVersion++; draft.value = ''; resizeDraft();
  $('.chat').inert = false; $('#privacy').hidden = true; $('#reply-draft').hidden = true; $('#notice').hidden = true; delete $('#send').dataset.saving;
  $('#offline').checked = false; $('#fail-save').checked = false;
  timeline.replaceChildren();
  const date = document.createElement('div'); date.className = 'date'; date.textContent = '今天'; timeline.append(date);
  const text = ['今天下午要不要出去走走？','好呀，去河边怎么样？','可以，那里傍晚的光很好看。','那就六点在桥边见。','我带一壶茶，你不用买喝的。','好，我带一些水果。','刚才路过花店，看到一束很漂亮的花。','是什么颜色的？','淡黄色的，很适合今天。','听起来就让人心情很好。','路上慢慢来，不着急。','知道啦，出门前告诉你。','想起上次在那边看到的落日。','那次我们聊了好久。','今天应该也会是晴天。','那就等傍晚见。'];
  text.forEach((value, i) => addMessage({ text: value, outgoing: i % 2 === 1, id: `seed-${i}` }));
  addMessage({ text: '河边的山景', kind: 'image', id: 'seed-photo' });
  addMessage({ text: '那我出门前再给你发消息。', outgoing: true, reply: { id: 'seed-3', text: '那就六点在桥边见。' }, id: 'seed-quote' });
  setPanel('none'); goLatest(); renderExpressions();
}

composer.addEventListener('submit', sendText);
$('#send').addEventListener('pointerdown', event => event.preventDefault());
draft.addEventListener('focus', () => { if (state.panel !== 'keyboard') setPanel('keyboard'); });
draft.addEventListener('input', () => { state.draftVersion++; transaction(resizeDraft); });
draft.addEventListener('compositionstart', () => state.composing = true);
draft.addEventListener('compositionend', () => state.composing = false);
draft.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) sendText(event); });
$('#expressions').addEventListener('pointerdown', event => event.preventDefault());
$('#expressions').addEventListener('click', () => { if (state.panel === 'expressions') { setPanel('keyboard'); draft.focus({ preventScroll: true }); } else setPanel('expressions'); });
$('#to-keyboard').addEventListener('click', () => { setPanel('keyboard'); draft.focus({ preventScroll: true }); });
$('#dismiss-keyboard').addEventListener('click', () => { draft.blur(); setPanel('none'); });
$('#simulate-keyboard').addEventListener('change', () => setPanel(state.panel));
$('#cancel-reply').addEventListener('pointerdown', event => event.preventDefault());
$('#cancel-reply').addEventListener('click', () => transaction(() => { state.reply = null; $('#reply-draft').hidden = true; }));
$('#latest').addEventListener('pointerdown', event => event.preventDefault());
$('#latest').addEventListener('click', goLatest);
$('#return').addEventListener('pointerdown', event => event.preventDefault());
$('#return').addEventListener('click', returnToReading);
timeline.addEventListener('wheel', () => { stopMotion(); state.pinned = false; }, { passive: true });
timeline.addEventListener('touchstart', () => { stopMotion(); }, { passive: true });
timeline.addEventListener('scroll', () => { state.pinned = atBottom(); updateControls(); }, { passive: true });
$('#receive').addEventListener('click', receive);
$('#attach').addEventListener('click', sendMedia);
$('#lock').addEventListener('click', lock);
$('#unlock').addEventListener('click', reset);
$('#reset').addEventListener('click', reset);
$('#more').addEventListener('click', () => say('这是交互原型；可用左侧场景体验，不接入真实空间。'));
$('#offline').addEventListener('change', () => { if (!$('#offline').checked) { timeline.querySelectorAll('.outgoing').forEach(settleReceipt); say('连接已恢复，等待中的消息继续发送'); } else say('当前离线，消息保存在本地待发状态（模拟）'); });
$('#reduce-motion').addEventListener('change', stopMotion);
motionPreference.addEventListener('change', stopMotion);
$('#menu-reply').addEventListener('click', () => setReply(state.menuRow));
$('#menu-select').addEventListener('click', () => { const row = state.menuRow; closeMenu(); row?.querySelector('.bubble').classList.add('selectable'); say('已启用文字选择'); });
$('#menu-close').addEventListener('click', closeMenu);
menu.addEventListener('cancel', event => { event.preventDefault(); closeMenu(); });
menu.addEventListener('click', event => { if (event.target === menu) { const r = menu.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeMenu(); } });
document.querySelectorAll('[data-react]').forEach(button => button.addEventListener('click', () => react(button.dataset.react)));
$('#close-viewer').addEventListener('click', closeViewer);
viewer.addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
$('#favorite').addEventListener('click', () => { const saved = $('#favorite').getAttribute('aria-pressed') !== 'true'; $('#favorite').setAttribute('aria-pressed', String(saved)); $('#favorite').textContent = saved ? '★' : '☆'; });
let viewerDrag = null;
$('.viewer-art').addEventListener('pointerdown', event => { viewerDrag = { y: event.clientY, id: event.pointerId }; $('.viewer-art').setPointerCapture(event.pointerId); motion.get($('.viewer-art'))?.cancel(); });
$('.viewer-art').addEventListener('pointermove', event => { if (!viewerDrag || viewerDrag.id !== event.pointerId) return; const dy = Math.max(0, event.clientY - viewerDrag.y); $('.viewer-art').style.transform = `translateY(${dy}px)`; });
const endViewerDrag = (event, cancelled = false) => { if (!viewerDrag) return; const dy = event.clientY - viewerDrag.y; viewerDrag = null; const from = $('.viewer-art').style.transform; $('.viewer-art').style.removeProperty('transform'); if (!cancelled && dy > 85) closeViewer(); else animate($('.viewer-art'), [{ transform: from || 'none' }, { transform: 'none' }], 180); };
$('.viewer-art').addEventListener('pointerup', event => endViewerDrag(event));
$('.viewer-art').addEventListener('pointercancel', event => endViewerDrag(event, true));
document.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => {
  pickerPositions.set(state.category, $('#expression-grid').scrollTop); state.category = button.dataset.category;
  document.querySelectorAll('[data-category]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderExpressions(); $('#expression-grid').scrollTop = pickerPositions.get(state.category) || 0;
}));
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  reset(); const scene = button.dataset.scenario;
  const captions = { typing: '正在看前文时输入，不自动跳回底部；键盘打开后仍可滚动消息。', send: '点击发送，或快速连续输入。草稿清空、输入框收缩与气泡进入同步。', reply: '点击蓝色气泡中的引用，再点“返回刚才位置”。也可以向左滑动消息回复。', incoming: '已停留在历史位置。新消息只增加提示，不拉走当前内容。', media: '点击图片查看；长按或右键消息打开菜单。离线后点＋可演示图片上传重试。', expressions: '连续发送表情，再切回键盘；草稿与面板滚动位置保留。' };
  if (scene === 'typing' || scene === 'incoming') { state.pinned = false; timeline.scrollTop = 150; updateControls(); }
  if (scene === 'typing') draft.focus({ preventScroll: true });
  if (scene === 'send') { draft.value = '刚想起上次的落日，\n今天也一起慢慢走回去吧。'; state.draftVersion++; draft.focus({ preventScroll: true }); transaction(resizeDraft); }
  if (scene === 'incoming') receive();
  if (scene === 'expressions') { draft.value = '等你。'; state.draftVersion++; setPanel('expressions'); }
  $('#scenario-caption').textContent = captions[scene];
}));
window.addEventListener('resize', () => { closeMenu(); if (viewer.open) closeViewer(); transaction(resizeDraft, { animated: false }); });
document.addEventListener('visibilitychange', () => { if (document.hidden) lock(); });
window.addEventListener('pagehide', lock);
reset();
