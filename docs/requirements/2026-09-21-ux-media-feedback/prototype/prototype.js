// Standalone design simulation. No app imports, network requests or persistent storage.
const sceneNode = document.querySelector('#scene');
const toastNode = document.querySelector('#toast');
const captionNode = document.querySelector('#scene-caption');
const picker = document.querySelector('.scene-picker');
const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

const icon = {
  people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-2a5.5 5.5 0 0 1 11 0v2M17 5.5a3 3 0 0 1 0 5.8M17.5 14a5 5 0 0 1 3 4.6"/></svg>',
  key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="14" r="4"/><path d="m11 11 8-8 2 2-2.5 2.5 1.5 1.5-2.5 2.5-1.5-1.5-3.5 3.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 20 6v5.2c0 5.1-3.3 8.8-8 10-4.7-1.2-8-4.9-8-10V6l8-3.2Z"/><path d="m9 11.8 2.1 2.1L15.5 9"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.7"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M9.4 6.4A11.3 11.3 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-3.2 3.7M6.2 8.1C3.5 9.8 2 12 2 12s3.5 6 10 6c1.3 0 2.5-.3 3.5-.7"/></svg>',
};

const galleryItems = [
  { id: 'p1', name: '晨光.jpg', kind: 'photo' }, { id: 'v1', name: '海边.mp4', kind: 'video' },
  { id: 'p2', name: '窗边.png', kind: 'photo' }, { id: 'p3', name: '傍晚.jpg', kind: 'photo' },
  { id: 'v2', name: '旅行.mov', kind: 'video' }, { id: 'p4', name: '街角.jpg', kind: 'photo' },
  { id: 'p5', name: '草地.jpg', kind: 'photo' }, { id: 'v3', name: '日落.mp4', kind: 'video' },
  { id: 'p6', name: '咖啡.jpg', kind: 'photo' }, { id: 'p7', name: '书桌.jpg', kind: 'photo' },
  { id: 'p8', name: '天空.jpg', kind: 'photo' }, { id: 'v4', name: '雨声.mp4', kind: 'video' },
];
const fileItems = [
  { id: 'f1', name: '见面计划.pdf', kind: 'file', format: 'PDF' },
  { id: 'f2', name: '共同清单.txt', kind: 'file', format: 'TXT' },
  { id: 'f3', name: '照片原件.zip', kind: 'file', format: 'ZIP' },
];
const state = {
  scene: 'welcome', offline: false, draft: '', messages: [
    { id: 'seed1', kind: 'text', text: '到家了和我说一声。', side: 'incoming', status: '' },
    { id: 'seed2', kind: 'text', text: '好，晚一点见。', side: 'outgoing', status: '已发送' },
  ],
  galleryTab: 'images', galleryLoaded: 6, revealAll: false, revealedIds: new Set(),
  selectedItem: null, menuError: '', videoItem: galleryItems[1], videoPlaying: false,
  videoControls: true, coverSuccess: false, moreOpen: false, shieldGone: false,
  callStatus: '等待发起', nativeComposition: false, compositionEndedAt: 0,
};

const titles = {
  welcome: '创建私密空间', setup: '设置访问密钥', invite: '邀请重要的人', join: '受邀加入',
  cover: '遮蔽演示', recovery: '恢复码说明', code: '本设备恢复码', chat: '聊天与输入',
  vault: '保险箱', viewer: '保险箱视频', call: '实时语音状态',
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const button = (label, action, kind = 'primary') => `<button class="app-button ${kind}" type="button" data-action="${action}">${label}</button>`;
const mark = kind => `<div class="page-mark">${icon[kind]}</div>`;
const back = scene => `<button class="top-back" type="button" data-go="${scene}" aria-label="返回">${icon.back}</button>`;

function toast(message) {
  toastNode.textContent = message;
  toastNode.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => { toastNode.hidden = true; }, 2500);
}

function pageWelcome() {
  return `<section class="page intro-page">
    <div class="intro-main">${mark('people')}<h1>有些话，<br>只留给彼此。</h1>
      <p>一个只属于两个人的私密空间。</p>
      <div class="welcome-copy"><p>无需手机号或邮箱。</p><p>聊天内容只对你和对方可读，平台无法读取。</p></div>
    </div><div class="intro-actions">${button('创建私密空间', 'create')}${button('恢复私密空间', 'restore', 'text')}</div>
  </section>`;
}
function pageSetup() {
  return `<section class="page intro-page"><div class="intro-main">${mark('people')}
    <h1>设置访问密钥</h1><p>以后用它解锁私密空间，防止别人直接打开你的聊天。无需注册，也不用另外记一个账号密码。</p>
    <p class="setup-hint">跟随设备提示完成即可，不用再记一个新密码。</p></div>
    <div class="intro-actions">${button('设置访问密钥', 'setup-complete')}${button('返回', 'setup-back', 'text')}</div></section>`;
}
function pageInvite() {
  return `<section class="page invite-page"><header class="invite-head"><h1>邀请重要的那个人</h1></header>
    <div class="invite-body"><p class="invite-instruction">让对方扫码，或把邀请链接发给对方。</p>
      <div class="qr-demo" role="img" aria-label="模拟二维码"></div>
      <div class="invite-status"><div class="invite-row"><span><strong>你</strong><small>访问密钥已设置，等待对方加入</small></span><em class="ready">已就绪</em></div>
      <div class="invite-row"><span><strong>对方</strong><small>等待对方打开邀请</small></span><em>待打开</em></div></div>
    </div><footer class="invite-footer">${button('复制邀请链接', 'copy-invite')}${button('返回', 'invite-back', 'text')}</footer></section>`;
}
function pageJoin() {
  return `<section class="page intro-page"><div class="intro-main">${mark('people')}
    <h1>有人为你留了一个私密空间</h1>
    <p>加入后，这个私密空间只属于你们两个人。先设置访问密钥，以后用它解锁聊天。</p>
    <p class="setup-hint">跟随设备提示完成即可，不用再记一个新密码。</p></div>
    <div class="intro-actions">${button('设置访问密钥并加入', 'join-complete')}${button('暂不加入', 'join-back', 'text')}</div></section>`;
}
function pageCover() {
  return `<section class="page cover-page"><div class="cover-top">${back('chat')}</div>
    <div class="cover-center"><div><span aria-hidden="true"></span><p>内容已遮蔽</p></div></div>
    <div class="cover-bottom"><p class="cover-notice">离开私密空间后，浏览器进入后台或设备锁屏时，会自动显示遮蔽层。</p>
      <button class="hold-zone" id="hold-zone" type="button" aria-label="长按一秒练习返回">长按</button></div>
    ${state.coverSuccess ? `<div class="cover-success"><div class="success-card" role="dialog" aria-modal="true"><h2>恭喜，你已经会用了</h2><p>长按热区 1 秒，就能揭开遮蔽层。</p>${button('开启自动遮蔽', 'cover-finish')}${button('暂不开启', 'cover-finish', 'text')}</div></div>` : ''}
  </section>`;
}
function pageRecovery() {
  return `<section class="page intro-page recovery-page"><div class="intro-main recovery-main">${mark('people')}
    <h1>留好双方恢复码，找回空间需要一起使用恢复码</h1>
    <p>双方各自保管，恢复时共同确认。不要互相发送恢复码。</p>
    <ul class="recovery-list"><li>清除浏览器数据</li><li>更换其他浏览器进入</li><li>使用浏览器无痕模式</li><li>更换设备或访问密钥失效</li></ul>
    <div class="recovery-note"><strong>哪些情况无法找回？</strong>任一方缺少恢复码，就不能完成共同恢复。</div></div>
    <div class="intro-actions">${button('查看我的恢复码', 'view-code')}${button('返回', 'recovery-back', 'text')}</div></section>`;
}
function pageCode() {
  return `<section class="page intro-page"><div class="intro-main">${mark('key')}<h1>本设备恢复码</h1>
    <p>请单独保存。恢复码不会发送到服务器，此页面将在一分钟后锁定。</p>
    <div class="code-box" aria-label="演示恢复码，非真实数据">•••• •••• ••••</div>
    <p class="code-note">此处仅为演示占位，原型不会读取或保存真实恢复材料。</p></div>
    <div class="intro-actions">${button('复制恢复码', 'copy-code')}${button('我已保存，回到聊天页', 'code-finish', 'text')}</div></section>`;
}
function messageMarkup(message) {
  const content = message.kind === 'attachment' ? `▣ ${escapeHtml(message.text)}` : escapeHtml(message.text);
  const retry = message.status === '失败' ? `<button type="button" data-action="upload-retry" data-id="${message.id}">重试上传</button>` : '';
  return `<article class="bubble ${message.side}${message.status === '上传中' ? ' uploading' : ''}${message.status === '失败' ? ' failed' : ''}">
    <span>${content}</span><small>${escapeHtml(message.status)}</small>${retry}</article>`;
}
function pageChat() {
  return `<section class="page chat-page"><header class="chat-header">
    <button class="presence" type="button" data-go="vault" aria-label="打开保险箱">TA　·　在线　·　我<small>点按状态进入保险箱</small></button>
    <div class="chat-actions"><button class="round-button shield-button${state.shieldGone ? ' is-source-hidden' : ''}" id="shield-button" type="button" data-action="shield-flight" aria-label="演示盾牌飞向更多菜单">${icon.shield}</button>
      <button class="round-button" id="more-button" type="button" data-action="more" aria-label="更多">${icon.more}</button>
      ${state.moreOpen ? `<div class="chat-more"><button type="button" data-go="recovery">我的恢复码</button><button type="button" data-go="cover">遮蔽演示</button><button type="button" data-go="vault">保险箱</button></div>` : ''}
    </div></header><div class="chat-list" id="chat-list">${state.messages.map(messageMarkup).join('')}</div>
    <div class="chat-demo-actions"><button type="button" data-action="simulate-upload">模拟图片上传</button><button type="button" data-go="call">实时语音</button><button type="button" data-go="vault">保险箱</button></div>
    <div class="ime-simulator"><label for="ime-raw">原型模拟输入法，输入字母后按空格或回车</label>
      <input id="ime-raw" type="text" value="nihao" autocomplete="off" spellcheck="false" aria-describedby="ime-help">
      <p id="ime-help">候选：<span class="ime-candidate">你好</span>。空格使候选词上屏；回车使原始字母上屏，两者都不发送。</p></div>
    <div class="chat-composer"><label class="sr-only" for="chat-input">输入消息</label><textarea id="chat-input" rows="1" placeholder="输入消息，回车发送" aria-label="输入消息">${escapeHtml(state.draft)}</textarea>
      <p class="composer-help">组合输入完成后，再单独按回车发送；Shift + Enter 换行。</p></div>
  </section>`;
}
function galleryItemMarkup(item) {
  const revealed = state.revealAll || state.revealedIds.has(item.id);
  return `<button class="vault-tile" type="button" data-id="${item.id}" data-revealed="${revealed}" aria-label="${revealed ? item.kind === 'video' ? '播放' : '查看' : '显示'}${escapeHtml(item.name)}，长按打开操作">
    <span class="tile-art" aria-hidden="true"></span>${item.kind === 'video' ? '<span class="play-mark" aria-hidden="true">▶</span>' : ''}</button>`;
}
function pageVault() {
  const images = state.galleryTab === 'images';
  const body = images ? `<div class="vault-grid">${galleryItems.slice(0, state.galleryLoaded).map(galleryItemMarkup).join('')}</div>
      ${state.galleryLoaded < galleryItems.length ? '<p class="vault-pull-hint" role="status">上拉继续加载</p>' : ''}`
    : fileItems.map(item => `<button class="vault-file" type="button" data-id="${item.id}" aria-label="${escapeHtml(item.name)}，长按打开操作"><span class="file-icon">${item.format}</span><span>${escapeHtml(item.name)}<small>长按查看操作</small></span></button>`).join('');
  return `<section class="page vault-page"><header class="vault-header">${back('chat')}
    <div class="vault-tabs" role="tablist" aria-label="保险箱分类"><button type="button" role="tab" data-action="tab-images" aria-selected="${images}">相册 <small>12</small></button><button type="button" role="tab" data-action="tab-files" aria-selected="${!images}">文件 <small>3</small></button></div>
    <button class="round-button" type="button" data-action="vault-upload" aria-label="上传到保险箱">＋</button></header>
    <div class="vault-body"><div class="vault-note">${images ? '点按一次显示内容，再点按查看。长按项目可发送至聊天。' : '长按文件可发送至聊天。'}</div>${body}</div>
    ${images ? `<button class="round-button visibility-button" type="button" data-action="toggle-all" aria-label="${state.revealAll ? '隐藏全部' : '显示全部'}" title="${state.revealAll ? '隐藏全部' : '显示全部'}">${state.revealAll ? icon.eyeOff : icon.eye}</button>` : ''}
    ${state.selectedItem ? `<div class="action-backdrop" data-action="menu-close"></div><div class="action-menu" role="dialog" aria-modal="true" aria-label="项目操作"><h2>${escapeHtml(state.selectedItem.name)}</h2>
      ${state.menuError ? `<p role="alert">${escapeHtml(state.menuError)}</p>` : ''}
      <button type="button" data-action="send-from-vault">发送至聊天</button><button type="button" data-action="menu-pin">置顶</button><button type="button" data-action="menu-delete">删除</button><button type="button" data-action="menu-close">取消</button></div>` : ''}
  </section>`;
}
function pageViewer() {
  return `<section class="page viewer-page${state.videoPlaying ? ' playing' : ''}" data-controls="${state.videoControls ? 'shown' : 'hidden'}">
    <div class="viewer-stage" data-action="viewer-stage" role="button" tabindex="0" aria-label="点按空白处显示或隐藏视频工具"><div class="viewer-art" aria-hidden="true"></div>
      <p class="viewer-instruction">点按空白处切换工具</p></div>
    <div class="viewer-tools"><div class="viewer-top"><button class="round-button" type="button" data-action="viewer-close" aria-label="返回保险箱">${icon.back}</button><button class="round-button" type="button" data-action="viewer-mute" aria-label="切换声音">♫</button></div>
      <div class="viewer-middle"><button type="button" data-action="video-play" aria-label="${state.videoPlaying ? '暂停视频' : '播放视频'}">${state.videoPlaying ? 'Ⅱ' : '▶'}</button></div>
      <div class="viewer-controls"><div class="control-row"><button type="button" data-action="viewer-speed" aria-label="播放速度">1×</button><button type="button" data-action="viewer-delete" aria-label="删除视频">⌫</button></div><div class="viewer-progress"><span></span></div></div>
    </div></section>`;
}
function pageCall() {
  return `<section class="page call-page"><div class="cover-top">${back('chat')}</div>
    <div class="call-avatar" aria-hidden="true">TA</div><h1>实时语音</h1><p>${escapeHtml(state.callStatus)}</p>
    <div class="call-actions"><div class="call-diagnostic">本页仅演示状态。正式验收须在两台设备上确认麦克风采集、连接、远端音轨与实际听到声音。</div>
      ${button('模拟发起通话', 'call-start')}${button('模拟已连接但无声', 'call-no-audio', 'secondary')}${button('返回聊天', 'call-back', 'text')}</div></section>`;
}

const views = { welcome: pageWelcome, setup: pageSetup, invite: pageInvite, join: pageJoin,
  cover: pageCover, recovery: pageRecovery, code: pageCode, chat: pageChat, vault: pageVault,
  viewer: pageViewer, call: pageCall };

function render() {
  sceneNode.innerHTML = views[state.scene]();
  captionNode.textContent = titles[state.scene];
  document.querySelectorAll('[data-scene]').forEach(node => {
    if (node.dataset.scene === state.scene) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  if (state.scene === 'chat') {
    const list = sceneNode.querySelector('#chat-list');
    list.scrollTop = list.scrollHeight;
  }
  if (state.scene === 'cover' && !state.coverSuccess) wireCoverHold();
  if (state.scene === 'vault') wireVaultHold();
}
function go(scene) {
  if (!(scene in views)) return;
  state.scene = scene;
  state.moreOpen = false;
  state.selectedItem = null;
  state.menuError = '';
  if (scene === 'vault') { state.galleryTab = 'images'; state.galleryLoaded = 6; state.revealAll = false; state.revealedIds.clear(); }
  if (scene === 'viewer') { state.videoPlaying = false; state.videoControls = true; }
  render();
  if (window.innerWidth <= 700) picker.open = false;
}
function updateImeCandidate() {
  const raw = sceneNode.querySelector('#ime-raw');
  const display = sceneNode.querySelector('.ime-candidate');
  if (!raw || !display) return;
  display.textContent = ({ nihao: '你好', woaini: '我爱你', zaoshang: '早上' })[raw.value.toLowerCase()] || '候选词';
}
function imeCommit(mode) {
  const raw = sceneNode.querySelector('#ime-raw');
  const input = sceneNode.querySelector('#chat-input');
  if (!raw || !input || !raw.value.trim()) return;
  const candidate = sceneNode.querySelector('.ime-candidate').textContent;
  const inserted = mode === 'candidate' ? candidate : raw.value;
  input.value += inserted;
  state.draft = input.value;
  input.focus();
  toast(mode === 'candidate' ? '空格：候选词已上屏，没有发送' : '回车：原始内容已上屏，没有发送');
}
function sendText() {
  const input = sceneNode.querySelector('#chat-input');
  if (!input || !input.value.trim()) return;
  state.messages.push({ id: crypto.randomUUID(), kind: 'text', text: input.value.trim(), side: 'outgoing', status: state.offline ? '等待网络' : '已发送' });
  state.draft = '';
  render();
}
function simulateUpload(existingId) {
  const message = existingId ? state.messages.find(item => item.id === existingId) : null;
  if (existingId && !message) return;
  const item = message || { id: crypto.randomUUID(), kind: 'attachment', text: '照片.jpg', side: 'outgoing', status: '准备中' };
  if (!message) state.messages.push(item);
  item.status = '准备中';
  render();
  window.setTimeout(() => {
    if (!state.messages.includes(item)) return;
    item.status = '上传中';
    if (state.scene === 'chat') render();
  }, 420);
  window.setTimeout(() => {
    if (!state.messages.includes(item)) return;
    item.status = state.offline ? '失败' : '已发送';
    if (state.scene === 'chat') render();
    if (state.offline) toast('上传失败。恢复网络后可重试同一条消息。');
  }, 1700);
}
function wireCoverHold() {
  const hold = sceneNode.querySelector('#hold-zone');
  if (!hold) return;
  let timer;
  const cancel = () => { window.clearTimeout(timer); hold.classList.remove('holding'); };
  const start = () => {
    cancel();
    hold.classList.add('holding');
    timer = window.setTimeout(() => { state.coverSuccess = true; render(); }, 1000);
  };
  hold.addEventListener('pointerdown', event => { if (event.button === 0) start(); });
  hold.addEventListener('pointerup', cancel);
  hold.addEventListener('pointerleave', cancel);
  hold.addEventListener('pointercancel', cancel);
  hold.addEventListener('contextmenu', event => event.preventDefault());
  hold.addEventListener('keydown', event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); start(); } });
  hold.addEventListener('keyup', cancel);
}
function openItemMenu(item) {
  state.selectedItem = item;
  state.menuError = '';
  render();
}
function wireVaultHold() {
  const body = sceneNode.querySelector('.vault-body');
  if (body && state.galleryTab === 'images' && state.galleryLoaded < galleryItems.length) {
    let touchStartY = null;
    const atEnd = () => body.scrollTop + body.clientHeight >= body.scrollHeight - 48;
    const loadOlder = () => {
      if (state.galleryLoaded >= galleryItems.length) return;
      state.galleryLoaded = galleryItems.length;
      render();
      toast('更早项目已载入，显示状态保持一致');
    };
    body.addEventListener('touchstart', event => { touchStartY = event.touches[0]?.clientY ?? null; }, { passive: true });
    body.addEventListener('touchend', event => {
      const endY = event.changedTouches[0]?.clientY;
      if (touchStartY !== null && endY !== undefined && touchStartY - endY > 40 && atEnd()) loadOlder();
      touchStartY = null;
    }, { passive: true });
    body.addEventListener('wheel', event => { if (event.deltaY > 0 && atEnd()) loadOlder(); }, { passive: true });
    body.addEventListener('scroll', () => {
      if (atEnd()) loadOlder();
    }, { passive: true });
    body.addEventListener('keydown', event => {
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key) && atEnd()) loadOlder();
    });
  }
  for (const tile of sceneNode.querySelectorAll('.vault-tile, .vault-file')) {
    const item = [...galleryItems, ...fileItems].find(value => value.id === tile.dataset.id);
    if (!item) continue;
    let timer;
    let held = false;
    tile.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' || event.button !== 0) return;
      held = false;
      timer = window.setTimeout(() => { held = true; openItemMenu(item); }, 500);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) tile.addEventListener(type, () => window.clearTimeout(timer));
    tile.addEventListener('contextmenu', event => { event.preventDefault(); window.clearTimeout(timer); openItemMenu(item); });
    tile.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openItemMenu(item); }
    });
    tile.addEventListener('click', event => {
      if (held || state.selectedItem) { event.preventDefault(); return; }
      if (item.kind === 'file') { toast('长按文件可发送至聊天'); return; }
      if (!state.revealAll && !state.revealedIds.has(item.id)) {
        state.revealedIds.add(item.id);
        render();
      } else if (item.kind === 'video') { state.videoItem = item; go('viewer'); }
      else toast('原图查看器在正式产品中保持原有行为');
    });
  }
}
function flyShield() {
  const shield = sceneNode.querySelector('#shield-button');
  const more = sceneNode.querySelector('#more-button');
  if (!shield || !more || state.shieldGone) { go('recovery'); return; }
  if (mediaQuery.matches) { state.shieldGone = true; render(); toast('恢复入口已收起至更多菜单'); return; }
  const from = shield.getBoundingClientRect();
  const to = more.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const clone = shield.cloneNode(true);
  clone.classList.add('shield-flyer');
  clone.removeAttribute('id');
  clone.style.left = `${from.left}px`;
  clone.style.top = `${from.top}px`;
  document.body.append(clone);
  shield.classList.add('is-source-hidden');
  const animation = clone.animate([
    { transform: 'translate(0, 0)', offset: 0, easing: 'ease-out' },
    { transform: `translate(${dx * .18}px, ${dy * .18 + 22}px)`, offset: .3, easing: 'cubic-bezier(.55, 0, .9, .25)' },
    { transform: `translate(${dx * .42}px, ${dy * .42 + 27}px)`, offset: .52, easing: 'cubic-bezier(.55, 0, .9, .25)' },
    { transform: `translate(${dx}px, ${dy}px) scale(.48)`, offset: 1 },
  ], { duration: 880, fill: 'forwards' });
  animation.finished.then(() => {
    clone.remove();
    state.shieldGone = true;
    if (state.scene === 'chat') render();
    toast('恢复入口已收起至更多菜单');
  }).catch(() => clone.remove());
}

document.querySelectorAll('[data-scene]').forEach(node => node.addEventListener('click', () => go(node.dataset.scene)));
document.querySelector('#theme-toggle').addEventListener('change', event => document.body.classList.toggle('force-dark', event.target.checked));
document.querySelector('#offline-toggle').addEventListener('change', event => { state.offline = event.target.checked; toast(state.offline ? '网络中断演示已开启' : '网络已恢复'); });
sceneNode.addEventListener('click', event => {
  const goTarget = event.target.closest('[data-go]');
  if (goTarget) { go(goTarget.dataset.go); return; }
  const actionNode = event.target.closest('[data-action]');
  if (!actionNode) return;
  const action = actionNode.dataset.action;
  switch (action) {
    case 'create': go('setup'); break;
    case 'restore': go('recovery'); break;
    case 'setup-back': go('welcome'); break;
    case 'setup-complete': go('invite'); break;
    case 'copy-invite': toast('演示链接已复制。点击“受邀加入”场景可继续。'); break;
    case 'invite-back': go('setup'); break;
    case 'join-complete': go('chat'); break;
    case 'join-back': go('welcome'); break;
    case 'cover-finish': state.coverSuccess = false; go('chat'); break;
    case 'view-code': go('code'); break;
    case 'recovery-back': go('chat'); break;
    case 'copy-code': toast('这是占位码，原型不会复制真实恢复材料'); break;
    case 'code-finish': go('chat'); break;
    case 'shield-flight': flyShield(); break;
    case 'more': state.moreOpen = !state.moreOpen; render(); break;
    case 'simulate-upload': simulateUpload(); break;
    case 'upload-retry': simulateUpload(actionNode.dataset.id); break;
    case 'tab-images': state.galleryTab = 'images'; render(); break;
    case 'tab-files': state.galleryTab = 'files'; render(); break;
    case 'toggle-all': state.revealAll = !(state.revealAll || galleryItems.every(item => state.revealedIds.has(item.id))); state.revealedIds.clear(); render(); break;
    case 'vault-upload': toast('上传流程在聊天页的演示按钮中查看'); break;
    case 'menu-close': state.selectedItem = null; state.menuError = ''; render(); break;
    case 'menu-pin': toast('置顶状态仅作演示'); state.selectedItem = null; render(); break;
    case 'menu-delete': toast('原型不会删除任何数据'); state.selectedItem = null; render(); break;
    case 'send-from-vault': {
      if (state.offline) { state.menuError = '网络中断，项目仍在保险箱。恢复后可重试。'; render(); break; }
      const item = state.selectedItem;
      if (!item) break;
      state.messages.push({ id: crypto.randomUUID(), kind: 'attachment', text: item.name, side: 'outgoing', status: '已发送' });
      state.selectedItem = null;
      go('chat');
      toast('已发送至聊天，保险箱原项目仍保留');
      break;
    }
    case 'viewer-stage': state.videoControls = !state.videoControls; render(); break;
    case 'viewer-close': go('vault'); break;
    case 'video-play': state.videoPlaying = !state.videoPlaying; state.videoControls = !state.videoPlaying; render(); break;
    case 'viewer-mute': toast('声音状态演示'); break;
    case 'viewer-speed': toast('播放速度演示'); break;
    case 'viewer-delete': toast('原型不会删除视频'); break;
    case 'call-start':
      state.callStatus = '正在连接（模拟）'; render();
      window.setTimeout(() => { if (state.scene !== 'call') return; state.callStatus = state.offline ? '连接失败，检查网络后重试（模拟）' : '通话中（模拟，未播放真实声音）'; render(); }, 1100);
      break;
    case 'call-no-audio': state.callStatus = '已连接但未听到声音：检查远端音轨、播放权限与设备输出'; render(); break;
    case 'call-back': go('chat'); break;
  }
});
sceneNode.addEventListener('input', event => {
  if (event.target.id === 'chat-input') state.draft = event.target.value;
  if (event.target.id === 'ime-raw') updateImeCandidate();
});
sceneNode.addEventListener('compositionstart', event => { if (event.target.id === 'chat-input') state.nativeComposition = true; });
sceneNode.addEventListener('compositionend', event => { if (event.target.id === 'chat-input') { state.nativeComposition = false; state.compositionEndedAt = Date.now(); } });
sceneNode.addEventListener('keydown', event => {
  if (event.target.id === 'ime-raw') {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); imeCommit(event.key === ' ' ? 'candidate' : 'raw'); }
    return;
  }
  if (event.target.id === 'chat-input' && event.key === 'Enter' && !event.shiftKey) {
    if (event.isComposing || state.nativeComposition || event.keyCode === 229 || Date.now() - state.compositionEndedAt < 100) return;
    event.preventDefault();
    sendText();
  }
  if (event.target.classList.contains('viewer-stage') && (event.key === ' ' || event.key === 'Enter')) {
    event.preventDefault(); state.videoControls = !state.videoControls; render();
  }
});
if (window.innerWidth <= 700) picker.open = false;
render();
