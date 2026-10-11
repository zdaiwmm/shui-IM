/* Standalone, synthetic prototype. No application imports, APIs, storage or SW. */
import { avatarCatalog } from './avatar-catalog.mjs';
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Same Lucide outline vocabulary as the application; no remote icon dependency.
  const paths = {
    spaces: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
    back: '<path d="m15 18-6-6 6-6"/>', arrow: '<path d="m9 18 6-6-6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m18 6-12 12M6 6l12 12"/>',
    settings: '<path d="M20 7h-9M14 17H4M20 17h-2M7 7H4"/><circle cx="9" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
    check: '<path d="m20 6-11 11-5-5"/>', checks: '<path d="m18 6-7 7-3-3M22 10l-7 7-3-3M2 12l5 5 3-3"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    send: '<path d="m5 12 7-7 7 7M12 5v14"/>', mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 22a10 10 0 1 1 10-10c0 2-1.5 3-3 3h-2c-1 0-2 1-2 2 0 .5.2 1 .5 1.5.5 1 .5 3.5-3.5 3.5Z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
    device: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3M18.5 4.5l3 3"/>',
    backup: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    restore: '<path d="M12 4v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    history: '<path d="M3 11a9 9 0 1 1 2 7M3 3v8h8M12 7v5l3 2"/>',
    cover: '<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.6 10.6 0 0 1 12 4c7 0 10 8 10 8a14 14 0 0 1-3.1 4.2M6.5 6.5A16 16 0 0 0 2 12s3 8 10 8a11 11 0 0 0 5.5-1.5"/>',
    offline: '<path d="m2 2 20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 3-2M2 9a16 16 0 0 1 3-2M11 5a16 16 0 0 1 11 4M15 10a10 10 0 0 1 4 3M12 20h.01"/>',
    collapse: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18m7-12-3 3 3 3"/>',
    edit: '<path d="m16 3 5 5M4 16 16.5 3.5a3.5 3.5 0 0 1 5 5L9 21H3v-6Z"/>',
    book: '<path d="M12 7v14M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>',
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1ZM9 21V12h6v9"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  };
  const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.spaces}</svg>`;
  const circuit = '<svg class="presence-circuit" viewBox="0 0 100 24" aria-hidden="true"><g class="presence-wire"><path d="M0 12H15L23 7 31 17 39 12H40M100 12H85L77 7 69 17 61 12H60"/></g><path class="presence-heart" transform="translate(50 11)" d="M0-5C-5-11-11-7-10-1-9 3-3 7 0 10 3 7 9 3 10-1 11-7 5-11 0-5Z"/></svg>';
  const ui = { main: $('#main-pane'), sidebar: $('#space-sidebar'), frame: $('#preview-viewport'), workspace: $('#workspace'), dialog: $('#operation-dialog') };
  const systemScheme = matchMedia('(prefers-color-scheme: dark)');
  const parameters = new URLSearchParams(location.search);
  if (parameters.get('text') === '200') document.documentElement.style.fontSize = '32px';
  $('#preview-credential').value = parameters.get('credential') === 'new' ? 'new' : 'existing';
  if (parameters.get('fullscreen') === '1' || parameters.get('controls') !== '1' && matchMedia('(max-width: 480px)').matches) document.documentElement.dataset.fullscreen = 'true';
  const baseSpaces = () => [
    { id: 'demo-1', name: '晚风', preview: '到家了，今天的晚霞很好看。', unread: 0 },
    { id: 'demo-2', name: '周末计划', preview: '周末去海边走走？', unread: 3 },
    { id: 'demo-3', name: '一起读书', preview: '[图片]', unread: 12, authorization: true },
    { id: 'demo-4', name: '新的约定', waiting: true, deadline: Date.now() + 45 * 60 * 1000 },
    { id: 'demo-5', name: '另一处小天地', access: 'restricted' },
    { id: 'demo-6', name: '旧时光', access: 'unprepared' },
  ];
  const initialView = parameters.get('view');
  let spaces = baseSpaces(), current = 'demo-1', route = ['chat', 'settings', 'appearance', 'presence', 'autolock', 'devices', 'create'].includes(initialView) ? initialView : 'spaces';
  let stack = route === 'settings' ? ['chat'] : ['appearance', 'presence', 'autolock', 'devices'].includes(route) ? ['chat', 'settings'] : [], desktop = false, sidebarHidden = false, scenario = 'normal', presence = 'capsule', scheme = 'system', theme = 'blue', lockSeconds = 30;
  if (['light', 'dark'].includes(parameters.get('scheme'))) scheme = parameters.get('scheme');
  if (['blue', 'green', 'purple', 'apricot'].includes(parameters.get('theme'))) theme = parameters.get('theme');
  let nextId = 7, toastTimer, operationToken = 0, dialogCancel = null, returnFocus = null;
  const blankCreation = () => ({ name: '', avatar: 'spaces', emoji: null, avatarBg: null, photo: null, photoCrop: null, passkeyName: 'Quiet Room · 本机', deviceNote: '', busy: false, message: '', failed: false, photoBusy: false, photoError: '' });
  let creation = blankCreation(), creationAttempt = 0, photoAttempt = 0, avatarEdit = null;
  const photoUrls = new Set();
  const avatarOptions = [['spaces', '默认'], ['heart', '爱心'], ['book', '书本'], ['home', '小屋']];
  const emojiOptions = avatarCatalog.map(({emoji, label}) => [emoji, label]);
  const emojiMarkup = emoji => {
    const item = avatarCatalog.find(entry => entry.emoji === emoji);
    return `<span class="avatar-emoji">${item ? `<span class="emoji-fallback">${escape(emoji)}</span><img class="emoji-motion" data-emoji-motion="${item.codepoint}" alt="" hidden>` : escape(emoji)}</span>`;
  };
  // Color is confined to personal avatar artwork; page chrome keeps P1 tokens.
  const avatarBackgrounds = [
    ['sky', '晴空', '#61c9c7', '#4e8dd3'], ['mint', '薄荷', '#6ed5b2', '#3f9fae'],
    ['leaf', '草木', '#b9cf55', '#55ae70'], ['lilac', '丁香', '#cf80c7', '#8a66cf'],
    ['rose', '玫瑰', '#ed9870', '#db658d'], ['orange', '暖橙', '#efb66a', '#e17a50'],
    ['gold', '日光', '#ecd172', '#dba04c'], ['slate', '雾灰', '#9baab9', '#64798a'],
  ];
  const avatarBackground = id => avatarBackgrounds.find(item => item[0] === id) || avatarBackgrounds[0];
  const backgroundStyle = id => { const [, , from, to] = avatarBackground(id); return `linear-gradient(160deg, ${from}, ${to})`; };
  function photoStyle(crop = {}) {
    const ratio = crop.ratio || 1, zoom = crop.zoom || 1, w = 100 * Math.max(1, ratio) * zoom, h = 100 * Math.max(1, 1 / ratio) * zoom;
    return `width:${w}%;height:${h}%;left:${50 + (crop.x || 0) * (w - 100) / 2}%;top:${50 + (crop.y || 0) * (h - 100) / 2}%;`;
  }
  const avatarMarkup = (space, cls = '') => `<span class="space-avatar ${cls} ${space.photo ? 'has-photo' : ''} ${space.avatarBg && !space.photo ? 'has-artwork' : ''}" ${space.avatarBg && !space.photo ? `style="background:${backgroundStyle(space.avatarBg)}"` : ''} aria-hidden="true">${space.photo ? `<img src="${escape(space.photo)}" style="${photoStyle(space.photoCrop)}" alt="">` : space.emoji ? emojiMarkup(space.emoji) : icon(space.avatar || 'spaces')}</span>`;
  const scrollPositions = new Map(), focusPositions = new Map(), drafts = new Map(), chatPages = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'), animationStills = new Map(), stillPending = new Set(), animationNodes = new Map(), failedAnimations = new Set();
  function updateAnimation(node) {
    const code = node.dataset.emojiMotion, visible = animationNodes.get(node) && !document.hidden && !failedAnimations.has(code);
    const reduce = reducedMotion.matches || parameters.get('motion') === 'reduce';
    const playing = visible && !reduce, preparing = visible && reduce && !animationStills.has(code);
    const source = playing || preparing ? new URL(`avatars/${code}.webp`, import.meta.url).href : animationStills.get(code);
    node.dataset.playback = playing ? 'playing' : preparing ? 'preparing-still' : source ? 'paused' : 'fallback';
    if (source && node.getAttribute('src') !== source) node.src = source;
    if (!source) node.removeAttribute('src');
    node.hidden = !source || preparing;
    $('.emoji-fallback', node.parentElement).hidden = Boolean(source) && !preparing;
  }
  const animationObserver = new IntersectionObserver(entries => {
    entries.forEach(({ target, isIntersecting }) => { const node = $('.emoji-motion', target); if (node && animationNodes.has(node)) { animationNodes.set(node, isIntersecting); updateAnimation(node); } });
  });
  function syncAnimatedEmoji() {
    const nodes = new Set([...document.querySelectorAll('[data-emoji-motion]')].filter(node => !node.closest('dialog') || node.closest('dialog').open));
    animationNodes.forEach((_, node) => { if (!nodes.has(node)) { animationObserver.unobserve(node.parentElement); node.removeAttribute('src'); animationNodes.delete(node); } });
    nodes.forEach(node => {
      if (animationNodes.has(node)) return;
      animationNodes.set(node, false);
      node.onload = () => {
        const code = node.dataset.emojiMotion;
        if (!['playing', 'preparing-still'].includes(node.dataset.playback) || animationStills.has(code) || stillPending.has(code)) return;
        stillPending.add(code);
        // Freeze a decoded local frame in memory; no upload or data-URL payload.
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
        canvas.getContext('2d').drawImage(node, 0, 0, 128, 128);
        canvas.toBlob(blob => {
          stillPending.delete(code);
          if (!blob) return;
          animationStills.set(code, URL.createObjectURL(blob));
          animationNodes.forEach((_, image) => { if (image.dataset.emojiMotion === code && image.dataset.playback !== 'playing') updateAnimation(image); });
        }, 'image/png');
      };
      node.onerror = () => { if (node.getAttribute('src')) { failedAnimations.add(node.dataset.emojiMotion); updateAnimation(node); } };
      updateAnimation(node); animationObserver.observe(node.parentElement);
    });
  }
  document.addEventListener('visibilitychange', () => animationNodes.forEach((_, node) => updateAnimation(node)));
  reducedMotion.addEventListener('change', () => animationNodes.forEach((_, node) => updateAnimation(node)));
  window.addEventListener('pagehide', () => { animationObserver.disconnect(); animationStills.forEach(url => URL.revokeObjectURL(url)); animationStills.clear(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { animationNodes.clear(); syncAnimatedEmoji(); } });
  const spaceById = id => spaces.find(space => space.id === id);
  const selectedSpace = () => spaceById(current);
  const button = (label, name, action, cls = '') => `<button class="icon-button ${cls}" type="button" aria-label="${escape(label)}" title="${escape(label)}" data-action="${action}">${icon(name)}</button>`;
  const safeName = () => escape(selectedSpace()?.name || '私密空间');
  const nowMinutes = () => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  function toast(message) {
    clearTimeout(toastTimer); const node = $('#toast'); node.textContent = message; node.hidden = false;
    toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
  }
  function applyScheme() {
    document.documentElement.dataset.colorScheme = scheme === 'system' ? (systemScheme.matches ? 'dark' : 'light') : scheme;
    document.documentElement.style.colorScheme = document.documentElement.dataset.colorScheme;
    document.documentElement.dataset.theme = theme;
    $('#preview-scheme').value = scheme;
    syncPageEdges();
  }
  function syncPageEdges() {
    const page = $('.page', ui.main); if (!page) return;
    const top = $('.page-header', page), bottom = $('.composer, .access-footer, .creation-footer', page) || page;
    const root = document.documentElement;
    root.style.setProperty('--prototype-edge-top', getComputedStyle(top).backgroundColor);
    root.style.setProperty('--prototype-edge-bottom', getComputedStyle(bottom).backgroundColor);
    const fullPage = new URLSearchParams({ fullscreen: '1', view: ['create-access', 'avatar-editor', 'photo-crop'].includes(route) ? 'create' : route, scheme, theme, credential: $('#preview-credential').value });
    if (parameters.get('text') === '200') fullPage.set('text', '200');
    if (parameters.get('motion') === 'reduce') fullPage.set('motion', 'reduce');
    $('#preview-fullscreen').href = `?${fullPage}`;
  }
  function savePosition() {
    const scroll = $('.page-scroll', ui.main);
    if (scroll) scrollPositions.set(`${current}:${route}`, scroll.scrollTop);
    const active = document.activeElement;
    if (active instanceof HTMLElement && ui.main.contains(active)) {
      const entry = ['setting', 'space', 'action'].find(key => active.dataset[key]);
      if (entry) focusPositions.set(`${current}:${route}`, `[data-${entry}="${active.dataset[entry]}"]`);
    }
  }
  function navigate(next, { replace = false, pop = false, source } = {}) {
    if (route === 'create-access' && next !== route && creation.busy) { creationAttempt++; creation.busy = false; }
    if (['avatar-editor', 'photo-crop'].includes(route) && next !== route) discardAvatarEdit();
    savePosition();
    if (source && ui.main.contains(source)) {
      const entry = ['setting', 'space', 'action'].find(key => source.dataset[key]);
      if (entry) focusPositions.set(`${current}:${route}`, `[data-${entry}="${source.dataset[entry]}"]`);
    }
    if (!replace && next !== route) stack.push(route);
    route = next; renderMain(pop);
  }
  function goBack() {
    if (route === 'create-access') { creationAttempt++; creation.busy = false; }
    if (route === 'create') { photoAttempt++; creation.photoBusy = false; }
    const next = stack.pop() || (desktop ? 'chat' : route === 'spaces' ? 'chat' : 'spaces');
    navigate(next, { replace: true, pop: true });
  }
  function header(title, options = {}) {
    return `<header class="page-header"><div class="header-leading">${desktop ? button('显示或收起空间侧栏', 'spaces', 'spaces') : ''}${button('返回', 'back', 'back', 'back-control')}</div><h1>${escape(title)}</h1><div class="header-actions">${options.actions || ''}</div></header>`;
  }
  function countdown(deadline) {
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    return seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '已到期';
  }
  function rowsMarkup() {
    return spaces.map(space => {
      const isCurrent = space.id === current;
      const text = space.access === 'restricted' ? '待对方授权' : space.access === 'unprepared' ? '请先在原设备打开此空间' : space.waiting ? `等待对方加入 · 剩余 <span data-countdown="${space.id}">${countdown(space.deadline)}</span>` : `<span class="snapshot-prefix">上次访问 · </span>${escape(space.preview || '暂无本机消息预览')}`;
      const badge = space.unread > 0 ? `<span class="unread-badge" aria-label="${space.unread} 条未读">${space.unread > 99 ? '99+' : space.unread}</span>` : '';
      return `<div class="space-item ${isCurrent ? 'is-selected' : ''}"><button class="space-main" data-space="${space.id}" aria-current="${isCurrent ? 'true' : 'false'}" aria-label="${escape(space.name)}${isCurrent ? '，当前空间' : ''}${space.access ? '，尚未授权' : ''}">${avatarMarkup(space)}<span class="space-copy"><strong class="space-name">${escape(space.name)}</strong><span class="space-preview ${space.waiting ? 'is-waiting' : ''}">${text}</span></span><span class="space-trailing">${isCurrent ? `<span class="current-mark">${icon('check')}<span>当前</span></span>` : badge || icon('arrow').replace('<svg ', '<svg class="space-chevron" ')}</span></button>${space.authorization ? `<button class="authorization-button" data-authorization="${space.id}" aria-label="查看${escape(space.name)}的浏览器授权请求"><span>授权</span></button>` : ''}</div>`;
    }).join('');
  }
  function listBody() {
    if (scenario === 'loading') return `<div class="page-scroll" aria-busy="true" aria-label="空间列表加载中"><div aria-hidden="true">${Array.from({ length: 5 }, () => '<div class="loading-row"><i></i><i></i></div>').join('')}</div><p class="list-footnote">正在读取本机空间列表…</p><button class="secondary-button" style="margin: 12px 24px" data-action="finish-load">完成模拟加载</button></div>`;
    if (!spaces.length) return `<div class="page-scroll"><div class="empty-state">${icon('spaces')}<h2>还没有私密空间</h2><p>创建一个空间，把邀请发给想聊天的人。</p><button class="primary-button" data-action="create">创建私密空间</button></div></div>`;
    return `<div class="page-scroll">${scenario === 'offline' ? `<div class="connection-note">${icon('offline')}<span>当前离线，预览与未读数保留上次确认结果。</span></div>` : ''}<div class="space-list">${rowsMarkup()}</div><p class="list-footnote">消息预览来自本机上次访问记录。切换空间仍需完成原有验证。</p></div>`;
  }
  function listPage(isSidebar = false) {
    return `<section class="page spaces-page"><header class="page-header ${isSidebar ? 'sidebar-header' : ''}">${isSidebar ? '' : button('返回聊天', 'back', 'back', 'back-control')}<${isSidebar ? 'h2' : 'h1'}>私密空间</${isSidebar ? 'h2' : 'h1'}><div class="header-actions">${button('创建私密空间', 'plus', 'create')}${isSidebar ? button('收起空间侧栏', 'collapse', 'collapse-sidebar') : button('设置', 'settings', 'settings', 'settings-control')}</div></header>${listBody()}${isSidebar ? `<footer class="sidebar-footer"><span>${spaces.length} 个空间</span>${button('设置', 'settings', 'settings')}</footer>` : ''}</section>`;
  }
  function renderSidebar() {
    const previous = $('.page-scroll', ui.sidebar)?.scrollTop || 0;
    ui.sidebar.innerHTML = listPage(true);
    $('.page-scroll', ui.sidebar).scrollTop = previous;
    bindList(ui.sidebar);
    syncAnimatedEmoji();
  }
  function sampleMessages(id) {
    if (id === 'demo-2') return [
      ['我看了天气，周六是晴天。', false], ['那就去海边吧，想走一走。', true], ['好，带上相机。', false], ['下午出发，刚好能看到日落。', true],
    ];
    if (id === 'demo-3') return [['这本书读到一半了。', false], ['喜欢哪一段？', true], ['写夜晚和城市的那一章。', false]];
    return [
      ['今天下班比平时早一点。', false], ['那可以慢慢走回去。', true], ['路过河边，风很舒服。', false], ['我刚好也准备出门。', true], ['等会儿想吃什么？', false], ['简单煮个面吧。', true], ['好，我买一点青菜。', false], ['到家了，今天的晚霞很好看。', false], ['等你发给我看。', true],
    ];
  }
  function chatHeader() {
    const connection = scenario === 'offline' ? 'offline' : 'online', status = connection === 'offline' ? '连接已断开' : '双方在线';
    return `<header class="page-header chat-header" data-presence="${presence}" data-connection="${connection}"><button class="space-switch" type="button" data-action="spaces" aria-label="私密空间列表，当前${safeName()}" title="私密空间列表">${icon('spaces')}<span>${safeName()}</span></button>${presence === 'capsule' ? `<button class="presence-control" data-action="safe-preview" aria-label="${status}，打开保险箱"><span class="presence-heading"><span>TA</span>${circuit}<span>我</span></span><span class="presence-status">${status}</span></button>` : ''}<div class="header-actions">${presence === 'heart' ? button(`${status}，打开保险箱`, 'heart', 'safe-preview', 'heart-control') : ''}${button('设置', 'settings', 'settings')}</div></header>`;
  }
  function makeChat() {
    const page = document.createElement('section'); page.className = 'page chat-page'; page.dataset.room = current;
    page.innerHTML = `${chatHeader()}<div class="page-scroll chat-body" aria-label="示例聊天记录"><div class="date-marker">今天</div>${sampleMessages(current).map(([copy, outgoing], i) => `<article class="message ${outgoing ? 'is-outgoing' : ''}"><p>${escape(copy)}</p><span class="message-meta">18:${String(20 + i).padStart(2, '0')}${outgoing ? icon('checks') : ''}</span></article>`).join('')}</div><form class="composer"><button class="icon-button" type="button" data-action="tools-preview" aria-label="聊天工具">${icon('plus')}</button><div class="composer-field"><label class="sr-only" for="draft-${current}">输入消息</label><textarea id="draft-${current}" rows="1" placeholder="输入消息" spellcheck="false"></textarea><button class="icon-button" type="button" data-action="tools-preview" aria-label="表情">${icon('smile')}</button></div><button class="icon-button" type="button" data-action="tools-preview" aria-label="语音留言">${icon('mic')}</button><button class="icon-button send-control" type="submit" aria-label="发送演示消息" hidden>${icon('send')}</button></form>`;
    const roomId = current, textarea = $('textarea', page), voice = $('[aria-label="语音留言"]', page), send = $('.send-control', page);
    textarea.value = drafts.get(roomId) || '';
    const updateComposer = () => {
      drafts.set(roomId, textarea.value); voice.hidden = Boolean(textarea.value.trim()); send.hidden = !voice.hidden;
      textarea.style.height = '44px'; textarea.style.height = `${Math.min(88, textarea.scrollHeight)}px`;
    };
    textarea.addEventListener('input', updateComposer);
    $('form', page).addEventListener('submit', event => {
      event.preventDefault(); const copy = textarea.value.trim(); if (!copy) return;
      const message = document.createElement('article'); message.className = 'message is-outgoing';
      message.innerHTML = `<p>${escape(copy)}</p><span class="message-meta">${nowMinutes()}${icon('check')}</span>`;
      $('.chat-body', page).append(message); textarea.value = ''; updateComposer();
      $('.chat-body', page).scrollTop = $('.chat-body', page).scrollHeight;
    });
    updateComposer(); return page;
  }
  function chatPage() {
    const space = selectedSpace();
    if (!space) return `<section class="page">${header('私密空间', { actions: button('设置', 'settings', 'settings') })}<div class="empty-state">${icon('spaces')}<h2>从一个空间开始</h2><p>在左侧创建私密空间，或选择已有空间。</p><button class="primary-button" data-action="create">创建私密空间</button></div></section>`;
    if (space.access || space.waiting) return accessPage(space);
    if (!chatPages.has(current)) chatPages.set(current, makeChat());
    const page = chatPages.get(current); $('.chat-header', page).outerHTML = chatHeader(); return page;
  }
  function accessPage(space) {
    const waiting = space.waiting, restricted = space.access === 'restricted';
    return `<section class="page">${header(space.name, { actions: button('设置', 'settings', 'settings') })}<div class="access-body">${icon(waiting ? 'spaces' : 'lock')}<h2>${waiting ? '等待对方加入' : restricted ? '此空间尚未授权' : '请先在原设备打开此空间'}</h2><p>${waiting ? '把邀请发给对方后，即可开始聊天。' : restricted ? '获得对方授权后，即可在此浏览器聊天。' : '在原设备打开并解锁此空间，完成一次接入准备。'}</p>${waiting ? `<p>剩余 <span data-countdown="${space.id}">${countdown(space.deadline)}</span></p>` : '<p>加入前的历史记录不会同步。</p>'}</div><div class="access-footer">${waiting ? '<button class="primary-button" data-action="invitation">查看邀请</button>' : restricted ? `<button class="primary-button" data-action="request-authorization">${space.requested ? '等待对方授权' : '申请对方授权'}</button>${space.requested ? '<button class="secondary-button" data-action="cancel-request">取消申请</button>' : ''}` : '<button class="secondary-button" data-action="spaces">返回空间列表</button>'}</div></section>`;
  }
  const settingGroups = [
    [['appearance', '主题外观', 'palette', '#617fca'], ['presence', '在线状态样式', 'heart', '#c45271'], ['notifications', '通知管理', 'bell', '#bf5b48'], ['app', '在应用中打开', 'desktop', '#617fca']],
    [['autolock', '自动锁定', 'lock', '#527e70'], ['devices', '设备管理', 'device', '#527e70'], ['passkey', '通行密钥管理', 'key', '#527e70'], ['cover', '遮罩练习', 'cover', '#a06f33']],
    [['backup', '备份与恢复', 'backup', '#8766af'], ['export', '导出聊天备份', 'backup', '#8766af'], ['restore', '恢复历史记录', 'restore', '#8766af'], ['recover', '恢复其他空间', 'history', '#8766af']],
    [['releases', '版本记录', 'history', '#697b8b']],
  ];
  function settingsPage() {
    const value = id => id === 'presence' ? (presence === 'heart' ? '心动按钮' : '在线胶囊') : id === 'autolock' ? (lockSeconds === 0 ? '永不' : lockSeconds < 60 ? `${lockSeconds} 秒` : `${lockSeconds / 60} 分钟`) : '';
    const unavailable = !selectedSpace() || selectedSpace().access;
    return `<section class="page settings-page">${header('设置')}<div class="page-scroll"><div class="content-width"><div class="settings-groups">${settingGroups.map(group => `<div class="settings-card">${group.map(([id, label, glyph, color]) => `<button class="setting-row" data-setting="${id}" ${unavailable && ['devices', 'backup', 'export', 'restore'].includes(id) ? 'disabled title="需先打开已授权空间"' : ''}><span class="setting-icon" style="--setting-color:${color}">${icon(glyph)}</span><span class="setting-label">${label}</span>${value(id) ? `<span class="setting-value">${value(id)}</span>` : ''}${icon('arrow')}</button>`).join('')}</div>`).join('')}</div><p class="settings-context">${!selectedSpace() ? '当前没有已选空间，相关空间操作暂不可用。' : selectedSpace().access ? '此空间尚未授权，相关空间操作暂不可用。' : `空间相关操作作用于「${safeName()}」。`}</p></div></div></section>`;
  }
  function appearancePage() {
    return `<section class="page">${header('主题外观')}<div class="page-scroll"><div class="content-width"><div class="appearance-sample"><header>聊天效果</header><div><span class="message">今天想换一种颜色。</span><span class="message is-outgoing">就用喜欢的这一种。</span></div></div><h2 class="section-label">明暗模式</h2><fieldset class="choices" aria-label="明暗模式">${[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([id, label]) => `<label class="choice"><span>${label}</span><input type="radio" name="scheme" value="${id}" ${scheme === id ? 'checked' : ''}></label>`).join('')}</fieldset><h2 class="section-label">配色</h2><fieldset class="choices" aria-label="配色">${[['blue', '经典', '#a7ca9e'], ['green', '松绿', '#73a895'], ['purple', '雾紫', '#b2a0c7'], ['apricot', '暖杏', '#cfb392']].map(([id, label, swatch]) => `<label class="choice"><i class="palette-dot" style="--swatch:${swatch}" aria-hidden="true"></i><span>${label}</span><input type="radio" name="theme" value="${id}" ${theme === id ? 'checked' : ''}></label>`).join('')}</fieldset><p class="field-hint">当前展示为示例聊天。原型中的选择只在本次演示内生效。</p></div></div></section>`;
  }
  function presencePage() {
    return `<section class="page">${header('在线状态样式')}<div class="page-scroll"><div class="content-width"><p class="body-copy presence-intro">选择聊天页顶部的显示方式。</p><fieldset class="presence-options"><legend class="sr-only">在线状态样式</legend>${[['capsule', '在线胶囊', '居中显示双方状态 · 默认样式'], ['heart', '心动按钮', '红色爱心，显示在聊天页右上角']].map(([id, title, description]) => `<label class="presence-option"><input class="sr-only" type="radio" name="presence" value="${id}" aria-labelledby="presence-title-${id}" aria-describedby="presence-description-${id}" ${presence === id ? 'checked' : ''}><span class="presence-preview ${id}" aria-hidden="true">${id === 'capsule' ? `<span>TA</span>${icon('heart')}<span>我</span>` : icon('heart')}</span><span class="presence-copy"><strong id="presence-title-${id}">${title}</strong><small id="presence-description-${id}">${description}</small></span><i class="presence-radio" aria-hidden="true">${icon('check')}</i></label>`).join('')}</fieldset><div class="presence-note"><p>左半颗代表对方，右半颗代表你。</p><p>在线状态不代表消息已读。</p></div><button class="primary-button full-width" data-action="preview-chat">查看聊天效果</button></div></div></section>`;
  }
  function autolockPage() {
    return `<section class="page">${header('自动锁定')}<div class="page-scroll"><div class="content-width"><p class="body-copy">连续未操作达到所选时长后锁定。</p><fieldset class="choices" aria-label="自动锁定时长">${[20, 30, 40, 50, 60, 120, 180, 240, 300, 0].map(seconds => `<label class="choice"><span>${seconds === 0 ? '永不' : seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分钟`}</span><input type="radio" name="autolock" value="${seconds}" ${seconds === lockSeconds ? 'checked' : ''}></label>`).join('')}</fieldset><p class="field-hint">此处仅演示选择与页面返回，不启动锁定计时。</p></div></div></section>`;
  }
  function devicesPage() {
    return `<section class="page">${header('设备管理')}<div class="page-scroll"><div class="content-width"><p class="body-copy">${safeName()}</p><div class="settings-card"><div class="device-row">${icon('device')}<p>iPhone · Safari<small>当前设备 · 示例</small></p></div><div class="device-row">${icon('desktop')}<p>Mac · Safari<small>另一台已授权设备 · 示例</small></p></div></div><p class="field-hint">每人每个空间最多三台独立密钥设备。新增设备不能取得加入前历史。</p></div></div></section>`;
  }
  function createPage() {
    return `<section class="page creation-page">${header('创建私密空间')}<div class="page-scroll"><form class="content-width creation-form" id="create-form"><div class="profile-avatar-row"><button type="button" class="avatar-edit-button" data-action="choose-avatar" aria-label="更改头像" ${creation.photoBusy ? 'disabled' : ''}>${avatarMarkup(creation, 'avatar-large')}<span class="avatar-change-label">更改头像</span></button></div><div class="profile-name"><label for="new-space-name">空间名称</label><input id="new-space-name" name="name" value="${escape(creation.name)}" placeholder="输入空间名称" maxlength="160" autocomplete="off" enterkeyhint="next" required aria-describedby="space-private-hint create-error"></div><p class="field-hint" id="space-private-hint">头像和名称仅自己这一侧可见。</p><p class="field-error" id="avatar-error" role="alert" ${creation.photoError ? '' : 'hidden'}>${escape(creation.photoError)}</p><p class="field-error" id="create-error" role="alert" hidden></p></form></div><footer class="creation-footer"><div><button class="primary-button full-width" type="submit" form="create-form" ${creation.photoBusy ? 'disabled' : ''}>${creation.photoBusy ? '正在读取图片…' : '下一步'}</button></div></footer></section>`;
  }
  function avatarEditorHeader(title) {
    return `<header class="page-header"><div class="header-leading">${button('取消头像编辑', 'close', 'back')}</div><h1>${title}</h1><div class="header-actions"></div></header>`;
  }
  function avatarEditorPage() {
    if (!avatarEdit) return createPage();
    return `<section class="page avatar-editor-page">${avatarEditorHeader('设置头像')}<div class="page-scroll"><div class="content-width avatar-editor-content"><div class="avatar-art-preview" id="avatar-art-preview">${avatarMarkup(avatarEdit, 'avatar-preview')}</div><h2 class="section-label">背景</h2><div class="avatar-backgrounds" role="group" aria-label="头像背景色">${avatarBackgrounds.map(([id, label]) => `<button class="avatar-background" type="button" data-background="${id}" aria-label="${label}背景" aria-pressed="${avatarEdit.avatarBg === id}"><span style="background:${backgroundStyle(id)}">${icon('check')}</span></button>`).join('')}</div><div class="avatar-section-heading"><h2 class="section-label">表情与图案</h2></div><div class="avatar-art-options" role="group" aria-label="头像表情和图案">${emojiOptions.map(([emoji, label]) => `<button type="button" class="avatar-art-choice" data-emoji="${emoji}" aria-label="${label}头像" aria-pressed="${avatarEdit.emoji === emoji}">${emojiMarkup(emoji)}</button>`).join('')}${avatarOptions.map(([id, label]) => `<button type="button" class="avatar-art-choice is-icon" data-art="${id}" aria-label="${label}图案头像" aria-pressed="${!avatarEdit.emoji && avatarEdit.avatar === id}">${icon(id)}</button>`).join('')}</div><p class="avatar-credit">动画：Google Noto Emoji · CC BY 4.0</p></div></div><footer class="creation-footer"><div><button class="primary-button full-width" data-action="apply-avatar">设置为头像</button></div></footer></section>`;
  }
  function photoCropPage() {
    if (!avatarEdit?.photo) return createPage();
    return `<section class="page avatar-editor-page">${avatarEditorHeader('裁剪图片')}<div class="page-scroll"><div class="content-width photo-crop-content"><div class="photo-crop-stage" id="photo-crop-stage" role="group" tabindex="0" aria-label="图片裁剪预览，可拖动或用方向键移动图片" aria-describedby="crop-hint"><img src="${escape(avatarEdit.photo)}" style="${photoStyle(avatarEdit)}" alt="待裁剪的头像图片" draggable="false"></div><p class="field-hint" id="crop-hint">拖动调整位置，缩放后截取圆形头像。</p><div class="crop-zoom-row"><label for="crop-zoom">缩放</label><input id="crop-zoom" type="range" min="1" max="3" step=".05" value="${avatarEdit.zoom}" aria-label="头像图片缩放"><output for="crop-zoom" id="crop-zoom-value">${Math.round(avatarEdit.zoom * 100)}%</output></div><button class="text-action" type="button" data-action="reset-crop">重置位置</button></div></div><footer class="creation-footer"><div><button class="primary-button full-width" data-action="apply-avatar">设置为头像</button></div></footer></section>`;
  }
  function createAccessPage() {
    const existing = $('#preview-credential').value === 'existing';
    return `<section class="page creation-page">${header('设置通行密钥')}<div class="page-scroll"><form class="content-width creation-form" id="create-access-form" aria-busy="${creation.busy}"><div class="creation-summary">${avatarMarkup(creation)}<div><strong>${escape(creation.name)}</strong><p>新空间</p></div></div>${existing ? `<div class="credential-summary">${icon('key')}<div><strong>使用这台设备已有的通行密钥</strong><p>Quiet Room · 本机</p></div>${icon('check')}</div><p class="field-hint">以后用这把密钥解锁，无需重复创建。</p>` : `<p class="body-copy">用通行密钥保护空间，以后由系统验证身份并解锁。</p><div class="grouped-fields"><div class="grouped-field"><label for="new-passkey-name">密钥名称</label><input id="new-passkey-name" value="${escape(creation.passkeyName)}" maxlength="64" autocomplete="off" required ${creation.busy ? 'disabled' : ''}></div><div class="grouped-field"><label for="new-device-note">设备备注</label><input id="new-device-note" value="${escape(creation.deviceNote)}" placeholder="选填" maxlength="24" autocomplete="off" ${creation.busy ? 'disabled' : ''}></div></div><p class="field-hint">密钥名称会显示在系统中，请勿填写聊天隐私。</p>`}<p class="${creation.failed ? 'field-error' : 'field-hint'}" id="creation-message" role="status" ${creation.message ? '' : 'hidden'}>${escape(creation.message)}</p></form></div><footer class="creation-footer"><div><button class="primary-button full-width" type="submit" form="create-access-form" ${creation.busy ? 'disabled' : ''}>${creation.busy ? '正在模拟创建…' : creation.failed ? '重试创建' : existing ? '确认创建' : '设置通行密钥并创建'}</button></div></footer></section>`;
  }
  function positionAvatarSheet() {
    const rect = ui.main.getBoundingClientRect(), width = Math.min(rect.width, 420);
    ui.dialog.classList.toggle('is-desktop-sheet', desktop);
    const height = Math.min(rect.height - 24, Math.max(300, Math.min(440, rect.height * .52)));
    Object.assign(ui.dialog.style, { width: `${width}px`, height: `${height}px`, maxHeight: `${height}px`, left: `${rect.left + (rect.width - width) / 2}px` });
    ui.dialog.style.top = `${desktop ? rect.top + (rect.height - height) / 2 : rect.bottom - height}px`;
  }
  function avatarSheet() {
    openDialog(`<button class="sheet-handle" type="button" data-dialog="cancel" aria-label="下拉或点按关闭头像面板"><span></span></button><div class="sheet-heading"><h2 id="dialog-title">更改头像</h2><button class="icon-button" type="button" data-dialog="cancel" aria-label="关闭头像面板">${icon('close')}</button></div><div class="sheet-avatar-preview">${avatarMarkup(creation, 'avatar-large')}</div><div class="avatar-source-options"><button type="button" class="photo-library-row" id="choose-art">${icon('smile')}<span>使用头像<small>选择表情、图案和背景色</small></span>${icon('arrow')}</button><button type="button" class="photo-library-row" id="choose-photo">${icon('image')}<span>使用图片<small>从相册选取并裁剪</small></span>${icon('arrow')}</button></div><input type="file" id="avatar-file" class="sr-only" accept="image/jpeg,image/png,image/webp" tabindex="-1" aria-label="选择空间头像图片">`);
    ui.dialog.classList.remove('is-simple'); ui.dialog.classList.add('is-avatar-sheet'); positionAvatarSheet();
    syncAnimatedEmoji();
    $('#choose-art', ui.dialog).onclick = () => { closeDialog(false); avatarEdit = { avatar: creation.avatar, emoji: creation.avatarBg ? creation.emoji : '😊', avatarBg: creation.avatarBg || 'sky' }; navigate('avatar-editor', { source: $('[data-action="choose-avatar"]') }); };
    $('#choose-photo', ui.dialog).onclick = () => $('#avatar-file', ui.dialog).click();
    $('#avatar-file', ui.dialog).onchange = event => { if (event.target.files?.length) { closeDialog(false); choosePhoto(event); } };
    const handle = $('.sheet-handle', ui.dialog); let startY = null, distance = 0;
    handle.onpointerdown = event => { startY = event.clientY; distance = 0; handle.setPointerCapture(event.pointerId); };
    handle.onpointermove = event => { if (startY === null || desktop) return; distance = Math.max(0, event.clientY - startY); ui.dialog.style.transform = `translateY(${distance}px)`; };
    handle.onpointerup = () => { startY = null; if (distance > 60) closeDialog(); else ui.dialog.style.transform = ''; };
    handle.onpointercancel = () => { startY = null; ui.dialog.style.transform = ''; };
  }
  function renderMain(pop = false) {
    const pages = { spaces: () => listPage(), chat: chatPage, settings: settingsPage, appearance: appearancePage, presence: presencePage, autolock: autolockPage, devices: devicesPage, create: createPage, 'create-access': createAccessPage, 'avatar-editor': avatarEditorPage, 'photo-crop': photoCropPage };
    if (desktop && route === 'spaces') route = 'chat';
    const body = (pages[route] || pages.chat)();
    if (typeof body === 'string') ui.main.innerHTML = body; else ui.main.replaceChildren(body);
    const page = $('.page', ui.main); page.classList.remove('page-enter', 'is-popping');
    if (route !== 'chat') page.classList.add('page-enter', ...(pop ? ['is-popping'] : []));
    const scroll = $('.page-scroll', ui.main);
    if (scroll) scroll.scrollTop = scrollPositions.get(`${current}:${route}`) ?? (route === 'chat' ? scroll.scrollHeight : 0);
    if (route === 'spaces') bindList(ui.main);
    if (route === 'create') {
      $('#create-form').addEventListener('submit', createSpace);
      $('#new-space-name').addEventListener('input', event => { creation.name = event.target.value; $('#create-error').hidden = true; event.target.removeAttribute('aria-invalid'); });
    }
    if (route === 'create-access') {
      $('#create-access-form').addEventListener('submit', confirmCreation);
      $('#new-passkey-name')?.addEventListener('input', event => { creation.passkeyName = event.target.value; });
      $('#new-device-note')?.addEventListener('input', event => { creation.deviceNote = event.target.value; });
    }
    if (route === 'photo-crop') bindCrop();
    ui.main.setAttribute('aria-label', { spaces: '私密空间', chat: '聊天', settings: '设置', appearance: '主题外观', presence: '在线状态样式', autolock: '自动锁定', devices: '设备管理', create: '创建私密空间', 'create-access': '设置通行密钥', 'avatar-editor': '设置头像', 'photo-crop': '裁剪图片' }[route]);
    syncPageEdges();
    syncAnimatedEmoji();
    const focus = pop ? $(focusPositions.get(`${current}:${route}`) || 'h1', ui.main) : $('h1', ui.main);
    if (focus) { if (focus.matches('h1')) focus.tabIndex = -1; focus.focus({ preventScroll: true }); }
    requestAnimationFrame(() => {
      if (page !== ui.main.firstElementChild) return;
      if (route === 'chat' && typeof body !== 'string') $('textarea', body).dispatchEvent(new Event('input'));
    });
  }
  function bindList(root) {
    root.querySelectorAll('[data-space]').forEach(row => {
      let timer, didLongPress = false, start;
      const clear = () => clearTimeout(timer);
      row.addEventListener('pointerdown', event => {
        if (event.button !== 0) return; didLongPress = false; start = [event.clientX, event.clientY];
        timer = setTimeout(() => { didLongPress = true; openSpaceMenu(spaceById(row.dataset.space), row); }, 500);
      });
      row.addEventListener('pointermove', event => { if (start && Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 12) clear(); });
      row.addEventListener('pointerup', clear); row.addEventListener('pointercancel', clear); row.addEventListener('pointerleave', clear);
      row.addEventListener('click', () => { clear(); if (didLongPress) { didLongPress = false; return; } selectSpace(spaceById(row.dataset.space)); });
      row.addEventListener('contextmenu', event => { event.preventDefault(); clear(); openSpaceMenu(spaceById(row.dataset.space), row); });
      row.addEventListener('keydown', event => { if (event.key === 'F2' || event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openSpaceMenu(spaceById(row.dataset.space), row); } });
    });
    root.querySelectorAll('[data-authorization]').forEach(row => row.addEventListener('click', () => approvalDialog(spaceById(row.dataset.authorization))));
  }
  function selectSpace(space) {
    if (!space) return;
    if (space.id === current) { navigate('chat', { replace: true }); stack = []; return; }
    if (space.access) { commitSpace(space); return; }
    verifyDialog(space, () => commitSpace(space));
  }
  function commitSpace(space) {
    savePosition(); current = space.id; stack = []; route = 'chat'; renderSidebar(); renderMain();
  }
  function openDialog(content, onCancel) {
    if (ui.dialog.open) closeDialog(false);
    returnFocus = document.activeElement; operationToken++; dialogCancel = onCancel;
    ui.dialog.className = 'operation-dialog'; ui.dialog.removeAttribute('style'); ui.dialog.innerHTML = content;
    ui.dialog.classList.toggle('is-simple', !ui.dialog.querySelector('.text-input, .dialog-action-list'));
    ui.dialog.showModal(); return operationToken;
  }
  function closeDialog(cancel = true) {
    const callback = dialogCancel; dialogCancel = null; operationToken++;
    if (ui.dialog.open) ui.dialog.close();
    syncAnimatedEmoji();
    if (cancel) callback?.();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  ui.dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  ui.dialog.addEventListener('click', event => { if (event.target === ui.dialog) { const r = ui.dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); } });
  function verifyDialog(space, onSuccess, purpose = '打开空间') {
    const token = openDialog(`<h2 id="dialog-title">${purpose === '创建空间' ? '创建空间' : `解锁「${escape(space.name)}」`}</h2><p>此处模拟空间原有验证，不会调用系统通行密钥，也不会读取真实数据。</p><p class="field-error" id="verify-error" role="alert" hidden></p><div class="dialog-actions"><button class="secondary-button" data-dialog="cancel">取消</button><button class="primary-button" id="verify-confirm">模拟验证</button></div>`, () => {});
    const confirm = $('#verify-confirm');
    const run = outcome => {
      confirm.disabled = true; confirm.textContent = '验证中…';
      setTimeout(() => {
        if (token !== operationToken || !ui.dialog.open) return;
        if (outcome === 'cancel') { closeDialog(); toast('已取消验证，当前空间未改变'); return; }
        if (outcome === 'error') {
          $('#verify-error').hidden = false; $('#verify-error').textContent = '模拟验证未完成。当前空间、草稿与阅读位置已保留。';
          confirm.disabled = false; confirm.textContent = '重试（模拟成功）'; confirm.onclick = () => run('success'); return;
        }
        closeDialog(false); onSuccess();
      }, 500);
    };
    confirm.onclick = () => run($('#preview-result').value);
  }
  function validName(value) {
    const name = value.trim(), length = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(name)].length : [...name].length;
    return name && length <= 40 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
  }
  function createSpace(event) {
    event.preventDefault(); const name = validName($('#new-space-name').value);
    if (!name) { $('#create-error').hidden = false; $('#create-error').textContent = '请输入 1–40 个字符的名称，不含控制字符。'; $('#new-space-name').setAttribute('aria-invalid', 'true'); $('#new-space-name').focus(); return; }
    if (creation.photoBusy) return;
    creation.name = name; creation.message = ''; creation.failed = false;
    navigate('create-access');
  }
  function discardPhoto() {
    photoAttempt++; creation.photoBusy = false;
    if (creation.photo) { URL.revokeObjectURL(creation.photo); photoUrls.delete(creation.photo); creation.photo = null; creation.photoCrop = null; }
  }
  function discardAvatarEdit() {
    if (avatarEdit?.photo && avatarEdit.photo !== creation.photo) { URL.revokeObjectURL(avatarEdit.photo); photoUrls.delete(avatarEdit.photo); }
    avatarEdit = null;
  }
  function applyAvatar() {
    if (!avatarEdit) return;
    if (avatarEdit.photo) {
      discardPhoto(); creation.photo = avatarEdit.photo;
      creation.photoCrop = { ratio: avatarEdit.ratio, zoom: avatarEdit.zoom, x: avatarEdit.x, y: avatarEdit.y };
    } else {
      discardPhoto(); creation.avatar = avatarEdit.avatar; creation.emoji = avatarEdit.emoji; creation.avatarBg = avatarEdit.avatarBg;
    }
    creation.photoError = ''; goBack();
  }
  function updateAvatarArt() {
    $('#avatar-art-preview').innerHTML = avatarMarkup(avatarEdit, 'avatar-preview');
    document.querySelectorAll('[data-background]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.background === avatarEdit.avatarBg)));
    document.querySelectorAll('[data-emoji]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.emoji === avatarEdit.emoji)));
    document.querySelectorAll('[data-art]').forEach(control => control.setAttribute('aria-pressed', String(!avatarEdit.emoji && control.dataset.art === avatarEdit.avatar)));
    syncAnimatedEmoji();
  }
  function updateCrop() {
    if (!avatarEdit?.photo) return;
    const img = $('#photo-crop-stage img'); if (img) img.style.cssText = photoStyle(avatarEdit);
    $('#crop-zoom').value = avatarEdit.zoom; $('#crop-zoom-value').textContent = `${Math.round(avatarEdit.zoom * 100)}%`;
  }
  function bindCrop() {
    const stage = $('#photo-crop-stage'); let origin = null;
    const clamp = value => Math.max(-1, Math.min(1, value));
    stage.onpointerdown = event => {
      if (event.button !== 0) return; stage.focus({ preventScroll: true }); stage.setPointerCapture(event.pointerId);
      origin = { x: event.clientX, y: event.clientY, cropX: avatarEdit.x, cropY: avatarEdit.y };
    };
    stage.onpointermove = event => {
      if (!origin || !avatarEdit) return;
      const size = stage.clientWidth, overflowX = size * (Math.max(1, avatarEdit.ratio) * avatarEdit.zoom - 1) / 2, overflowY = size * (Math.max(1, 1 / avatarEdit.ratio) * avatarEdit.zoom - 1) / 2;
      avatarEdit.x = overflowX > 0 ? clamp(origin.cropX + (event.clientX - origin.x) / overflowX) : 0;
      avatarEdit.y = overflowY > 0 ? clamp(origin.cropY + (event.clientY - origin.y) / overflowY) : 0; updateCrop();
    };
    stage.onpointerup = stage.onpointercancel = () => { origin = null; };
    stage.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') avatarEdit.x = clamp(avatarEdit.x - .1);
      if (event.key === 'ArrowRight') avatarEdit.x = clamp(avatarEdit.x + .1);
      if (event.key === 'ArrowUp') avatarEdit.y = clamp(avatarEdit.y - .1);
      if (event.key === 'ArrowDown') avatarEdit.y = clamp(avatarEdit.y + .1);
      updateCrop();
    };
    $('#crop-zoom').oninput = event => { avatarEdit.zoom = Number(event.target.value); updateCrop(); };
  }
  async function choosePhoto(event) {
    const file = event.target.files?.[0]; if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      creation.photoError = '请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片。'; renderMain(); return;
    }
    const token = ++photoAttempt, owner = creation, url = URL.createObjectURL(file); photoUrls.add(url);
    creation.photoBusy = true; creation.photoError = ''; renderMain();
    try {
      const image = new Image(); image.src = url; await image.decode();
      if (token !== photoAttempt || creation !== owner) { URL.revokeObjectURL(url); photoUrls.delete(url); return; }
      avatarEdit = { photo: url, ratio: image.naturalWidth / image.naturalHeight, zoom: 1, x: 0, y: 0 };
    } catch {
      URL.revokeObjectURL(url); photoUrls.delete(url);
      if (token !== photoAttempt || creation !== owner) return;
      creation.photoError = '无法读取这张图片，请换一张重试。';
    }
    if (token !== photoAttempt || creation !== owner) return;
    creation.photoBusy = false;
    if (route === 'create') {
      if (avatarEdit?.photo === url) navigate('photo-crop', { source: $('[data-action="choose-avatar"]') });
      else { renderMain(); $('[data-action="choose-avatar"]')?.focus({ preventScroll: true }); }
    }
  }
  function confirmCreation(event) {
    event.preventDefault(); if (creation.busy || !validName(creation.name)) return;
    if ($('#preview-credential').value === 'new' && !creation.passkeyName.trim()) {
      creation.message = '请填写便于在系统中辨认的通行密钥名称。'; renderMain(); return;
    }
    const token = ++creationAttempt, outcome = creation.failed ? 'success' : $('#preview-result').value;
    creation.busy = true; creation.message = ''; renderMain();
    setTimeout(() => {
      if (token !== creationAttempt || route !== 'create-access') return;
      creation.busy = false;
      if (outcome === 'cancel' || outcome === 'error') {
        creation.failed = outcome === 'error';
        creation.message = outcome === 'cancel' ? '已取消，空间资料已保留。可以返回修改或重新尝试。' : '模拟验证未完成，空间资料已保留。请重试。';
        renderMain(); return;
      }
      const space = { id: `demo-${nextId++}`, name: creation.name, avatar: creation.avatar, emoji: creation.emoji, avatarBg: creation.avatarBg, photo: creation.photo, photoCrop: creation.photoCrop, waiting: true, deadline: Date.now() + 60 * 60 * 1000, unread: 0 };
      spaces.push(space); creation = blankCreation(); $('#preview-credential').value = 'existing';
      stack = []; route = desktop ? 'chat' : 'spaces'; renderSidebar(); renderMain(); invitationDialog(space);
    }, 500);
  }
  function invitationDialog(space = selectedSpace()) {
    if (!space) return;
    openDialog(`<h2 id="dialog-title">邀请对方加入</h2><p>${escape(space.name)}</p><div class="invitation-code">DEMO · ONLY</div><p>这是演示邀请，不能用于真实接入。关闭后，待加入空间会保留在列表中。</p><div class="dialog-actions"><button class="secondary-button" data-dialog="cancel">返回空间列表</button><button class="primary-button" id="copy-demo">复制演示邀请</button></div>`, () => { route = desktop ? 'chat' : 'spaces'; stack = []; renderSidebar(); renderMain(); });
    ui.dialog.classList.remove('is-simple'); ui.dialog.classList.add('is-invitation');
    positionInvitation();
    $('#copy-demo').onclick = async () => {
      try { await navigator.clipboard.writeText('Quiet Room 原型演示，不可用于接入：DEMO-ONLY'); toast('已复制演示文字'); }
      catch { toast('此浏览器未允许复制，演示邀请仍保留'); }
    };
  }
  function openSpaceMenu(space) {
    if (!space || space.access) return;
    openDialog(`<h2 id="dialog-title">${escape(space.name)}</h2><div class="dialog-action-list"><button id="rename-space">编辑空间名称</button>${space.waiting ? '<button class="is-danger" id="remove-space">删除待加入空间</button>' : ''}<button data-dialog="cancel">取消</button></div>`);
    $('#rename-space').onclick = () => {
      openDialog(`<h2 id="dialog-title">编辑空间名称</h2><label class="sr-only" for="rename-input">空间名称</label><input class="text-input" id="rename-input" value="${escape(space.name)}" maxlength="160" autocomplete="off"><p class="field-hint">仅修改你这边的名称，对方的名称不变。</p><p class="field-error" id="rename-error" role="alert" hidden></p><div class="dialog-actions"><button class="secondary-button" data-dialog="cancel">取消</button><button class="primary-button" id="save-name">保存</button></div>`);
      const input = $('#rename-input'); input.focus(); input.select();
      $('#save-name').onclick = () => {
        const name = validName(input.value);
        if (!name) { $('#rename-error').hidden = false; $('#rename-error').textContent = '请输入 1–40 个字符的名称。'; return; }
        space.name = name; closeDialog(false); savePosition(); renderSidebar(); renderMain(); toast('名称已更新，仅在本次演示内生效');
      };
      input.addEventListener('keydown', event => { if (event.key === 'Enter') $('#save-name').click(); });
    };
    $('#remove-space')?.addEventListener('click', () => {
      spaces = spaces.filter(item => item !== space); if (current === space.id) current = spaces[0]?.id || null;
      closeDialog(false); renderSidebar(); renderMain(); toast('已删除演示中的待加入空间');
    });
  }
  function approvalDialog(space) {
    if (!space?.authorization) return;
    openDialog(`<h2 id="dialog-title">新的浏览器申请</h2><p>空间：${escape(space.name)}<br>申请设备：Mac · Chrome（示例）</p><p>批准后只开放此空间，不包含加入前的历史记录。</p><div class="dialog-actions"><button class="secondary-button" id="reject-approval">拒绝</button><button class="primary-button" id="approve-access">批准（模拟）</button></div>`);
    const finish = message => { space.authorization = false; closeDialog(false); savePosition(); renderSidebar(); renderMain(); toast(message); };
    $('#approve-access').onclick = () => finish('已模拟批准此空间的新浏览器接入');
    $('#reject-approval').onclick = () => finish('已模拟拒绝本次申请');
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.dialog === 'cancel') { closeDialog(); return; }
    if (route === 'avatar-editor' && avatarEdit) {
      if (target.dataset.background) { avatarEdit.avatarBg = target.dataset.background; updateAvatarArt(); return; }
      if (target.dataset.emoji) { avatarEdit.emoji = target.dataset.emoji; updateAvatarArt(); return; }
      if (target.dataset.art) { avatarEdit.avatar = target.dataset.art; avatarEdit.emoji = null; updateAvatarArt(); return; }
    }
    const setting = target.dataset.setting;
    if (setting) {
      if (['appearance', 'presence', 'autolock', 'devices'].includes(setting)) navigate(setting, { source: target });
      else toast('本原型只展示此设置入口，功能沿用当前产品');
      return;
    }
    switch (target.dataset.action) {
      case 'back': goBack(); break;
      case 'spaces': if (desktop) { sidebarHidden = !sidebarHidden; ui.workspace.classList.toggle('is-sidebar-hidden', sidebarHidden); } else navigate('spaces', { source: target }); break;
      case 'settings': navigate('settings', { source: target }); break;
      case 'create': navigate('create', { source: target }); break;
      case 'choose-avatar': avatarSheet(); break;
      case 'apply-avatar': applyAvatar(); break;
      case 'reset-crop': if (avatarEdit?.photo) { avatarEdit.zoom = 1; avatarEdit.x = 0; avatarEdit.y = 0; updateCrop(); } break;
      case 'preview-chat': navigate('chat', { source: target }); break;
      case 'safe-preview': toast('保险箱入口保留，本原型不展示私密内容'); break;
      case 'tools-preview': toast('聊天工具不在本次导航原型范围内'); break;
      case 'collapse-sidebar': sidebarHidden = true; ui.workspace.classList.add('is-sidebar-hidden'); break;
      case 'finish-load': scenario = 'normal'; $('#preview-scenario').value = scenario; renderSidebar(); renderMain(); break;
      case 'invitation': invitationDialog(); break;
      case 'request-authorization': {
        const space = selectedSpace(); if (space.requested) break;
        verifyDialog(space, () => { space.requested = true; renderMain(); toast('已模拟发出申请，等待对方授权'); }); break;
      }
      case 'cancel-request': selectedSpace().requested = false; renderMain(); toast('已取消演示申请'); break;
    }
  });
  document.addEventListener('change', event => {
    const input = event.target;
    if (input.name === 'scheme') { scheme = input.value; applyScheme(); }
    if (input.name === 'theme') { theme = input.value; applyScheme(); }
    if (input.name === 'presence') { presence = input.value; }
    if (input.name === 'autolock') { lockSeconds = Number(input.value); }
  });
  $('#preview-credential').addEventListener('change', () => {
    creationAttempt++; creation.busy = false; creation.message = ''; creation.failed = false;
    if (route === 'create-access') renderMain();
  });
  $('#preview-scheme').addEventListener('change', event => { scheme = event.target.value; applyScheme(); if (route === 'appearance') { savePosition(); renderMain(); } });
  systemScheme.addEventListener('change', applyScheme);
  function refreshSize() {
    const next = ui.frame.clientWidth >= 1024;
    if (next !== desktop) { savePosition(); desktop = next; renderSidebar(); renderMain(); }
    $('#preview-caption').textContent = desktop ? '桌面 · 280px 可收起侧栏 + 独立设置内容区' : '手机 · 独立空间列表页';
    if (ui.dialog.open && ui.dialog.classList.contains('is-invitation')) positionInvitation();
    if (ui.dialog.open && ui.dialog.classList.contains('is-avatar-sheet')) positionAvatarSheet();
  }
  function positionInvitation() {
    const rect = ui.frame.getBoundingClientRect(), width = Math.min(rect.width - 2, 520), height = Math.min(rect.height - 24, Math.max(300, rect.height * .52));
    Object.assign(ui.dialog.style, { width: `${width}px`, height: `${height}px`, maxHeight: `${height}px`, left: `${rect.left + (rect.width - width) / 2}px`, top: `${Math.max(12, rect.bottom - height - 1)}px` });
  }
  $('#preview-size').addEventListener('change', event => { ui.frame.dataset.size = event.target.value; refreshSize(); });
  new ResizeObserver(refreshSize).observe(ui.frame);
  // Match the P1 prototype's visible viewport ownership for the mobile keyboard.
  let viewportFrame = 0;
  function syncVisibleViewport() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      document.documentElement.style.setProperty('--prototype-visible-height', `${viewport?.height || innerHeight}px`);
      document.documentElement.style.setProperty('--prototype-visible-top', `${viewport?.offsetTop || 0}px`);
      if (ui.dialog.open && ui.dialog.classList.contains('is-avatar-sheet')) positionAvatarSheet();
    });
  }
  window.visualViewport?.addEventListener('resize', syncVisibleViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncVisibleViewport, { passive: true });
  window.addEventListener('resize', syncVisibleViewport, { passive: true });
  syncVisibleViewport();
  function setScenario(value) {
    refreshSize();
    creationAttempt++; photoAttempt++; photoUrls.forEach(url => URL.revokeObjectURL(url)); photoUrls.clear(); creation = blankCreation(); avatarEdit = null;
    closeDialog(false); scenario = value; spaces = baseSpaces(); current = 'demo-1'; stack = []; chatPages.clear(); scrollPositions.clear(); focusPositions.clear();
    if (value === 'single') spaces = spaces.slice(0, 1);
    $('#preview-credential').value = value === 'empty' ? 'new' : 'existing';
    if (value === 'empty') { spaces = []; current = null; }
    if (value === 'long') { spaces[0].name = '一个用来测试长名称在窄屏上如何显示的私密空间'; spaces[1].name = '关于下一个假期的所有小小计划和临时想法'; spaces[1].unread = 136; }
    if (value === 'expired') spaces.forEach(space => { space.authorization = false; });
    route = desktop ? 'chat' : 'spaces'; renderSidebar(); renderMain();
  }
  $('#preview-scenario').addEventListener('change', event => setScenario(event.target.value));
  $('#preview-reset').addEventListener('click', () => {
    presence = 'capsule'; scheme = 'system'; theme = 'blue'; lockSeconds = 30; sidebarHidden = false; drafts.clear(); nextId = 7;
    $('#preview-scenario').value = 'normal'; $('#preview-result').value = 'success'; ui.workspace.classList.remove('is-sidebar-hidden');
    applyScheme(); setScenario('normal'); toast('演示已重置');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !ui.dialog.open && route !== 'chat') { event.preventDefault(); goBack(); }
  });
  setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach(node => { const space = spaceById(node.dataset.countdown); if (space?.deadline) node.textContent = countdown(space.deadline); });
  }, 1000);
  applyScheme(); refreshSize(); renderSidebar(); renderMain();
})();
