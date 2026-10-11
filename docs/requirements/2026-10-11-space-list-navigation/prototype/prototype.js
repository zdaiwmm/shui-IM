/* Standalone, synthetic prototype. No application imports, APIs, storage or SW. */
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
  };
  const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.spaces}</svg>`;
  const circuit = '<svg class="presence-circuit" viewBox="0 0 100 24" aria-hidden="true"><g class="presence-wire"><path d="M0 12H15L23 7 31 17 39 12H40M100 12H85L77 7 69 17 61 12H60"/></g><path class="presence-heart" transform="translate(50 11)" d="M0-5C-5-11-11-7-10-1-9 3-3 7 0 10 3 7 9 3 10-1 11-7 5-11 0-5Z"/></svg>';
  const ui = { main: $('#main-pane'), sidebar: $('#space-sidebar'), frame: $('#preview-viewport'), workspace: $('#workspace'), dialog: $('#operation-dialog') };
  const systemScheme = matchMedia('(prefers-color-scheme: dark)');
  const parameters = new URLSearchParams(location.search);
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
  let nextId = 7, toastTimer, operationToken = 0, dialogCancel = null, returnFocus = null;
  const scrollPositions = new Map(), focusPositions = new Map(), drafts = new Map(), chatPages = new Map();
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
    const top = $('.page-header', page), bottom = $('.composer, .access-footer', page) || page;
    const root = document.documentElement;
    root.style.setProperty('--prototype-edge-top', getComputedStyle(top).backgroundColor);
    root.style.setProperty('--prototype-edge-bottom', getComputedStyle(bottom).backgroundColor);
    $('#preview-fullscreen').href = `?fullscreen=1&view=${route}`;
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
    savePosition();
    if (source && ui.main.contains(source)) {
      const entry = ['setting', 'space', 'action'].find(key => source.dataset[key]);
      if (entry) focusPositions.set(`${current}:${route}`, `[data-${entry}="${source.dataset[entry]}"]`);
    }
    if (!replace && next !== route) stack.push(route);
    route = next; renderMain(pop);
  }
  function goBack() {
    const next = stack.pop() || (desktop ? 'chat' : route === 'spaces' ? 'chat' : 'spaces');
    navigate(next, { replace: true, pop: true });
  }
  function header(title, options = {}) {
    return `<header class="page-header">${desktop ? button('显示或收起空间侧栏', 'spaces', 'spaces') : ''}${button('返回', 'back', 'back', 'back-control')}<h1>${escape(title)}</h1><div class="header-actions">${options.actions || ''}</div></header>`;
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
      return `<div class="space-item ${isCurrent ? 'is-selected' : ''}"><button class="space-main" data-space="${space.id}" aria-current="${isCurrent ? 'true' : 'false'}" aria-label="${escape(space.name)}${isCurrent ? '，当前空间' : ''}${space.access ? '，尚未授权' : ''}"><span class="space-copy"><strong class="space-name">${escape(space.name)}</strong><span class="space-preview ${space.waiting ? 'is-waiting' : ''}">${text}</span></span><span class="space-trailing">${isCurrent ? `<span class="current-mark">${icon('check')}<span>当前</span></span>` : badge || icon('arrow').replace('<svg ', '<svg class="space-chevron" ')}</span></button>${space.authorization ? `<button class="authorization-button" data-authorization="${space.id}" aria-label="查看${escape(space.name)}的浏览器授权请求">授权</button>` : ''}</div>`;
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
    [['appearance', '主题外观', 'palette', '#8070b4'], ['presence', '在线状态样式', 'heart', '#c66078'], ['notifications', '通知管理', 'bell', '#d19a42'], ['app', '在应用中打开', 'desktop', '#588eb4']],
    [['autolock', '自动锁定', 'lock', '#698b76'], ['devices', '设备管理', 'device', '#658ec3'], ['passkey', '通行密钥管理', 'key', '#7a82b2'], ['cover', '遮罩练习', 'cover', '#798593']],
    [['backup', '备份与恢复', 'backup', '#66928d'], ['export', '导出聊天备份', 'backup', '#699488'], ['restore', '恢复历史记录', 'restore', '#7193a7'], ['recover', '恢复其他空间', 'history', '#9b83a8']],
    [['releases', '版本记录', 'history', '#87909a']],
  ];
  function settingsPage() {
    const value = id => id === 'presence' ? (presence === 'heart' ? '心动按钮' : '在线胶囊') : id === 'autolock' ? (lockSeconds === 0 ? '永不' : lockSeconds < 60 ? `${lockSeconds} 秒` : `${lockSeconds / 60} 分钟`) : '';
    const unavailable = !selectedSpace() || selectedSpace().access;
    return `<section class="page">${header('设置')}<div class="page-scroll"><div class="content-width"><div class="settings-groups">${settingGroups.map(group => `<div class="settings-card">${group.map(([id, label, glyph, color]) => `<button class="setting-row" data-setting="${id}" ${unavailable && ['devices', 'backup', 'export', 'restore'].includes(id) ? 'disabled title="需先打开已授权空间"' : ''}><span class="setting-icon" style="--setting-color:${color}">${icon(glyph)}</span><span class="setting-label">${label}</span>${value(id) ? `<span class="setting-value">${value(id)}</span>` : ''}${icon('arrow')}</button>`).join('')}</div>`).join('')}</div><p class="settings-context">${!selectedSpace() ? '当前没有已选空间，相关空间操作暂不可用。' : selectedSpace().access ? '此空间尚未授权，相关空间操作暂不可用。' : `空间相关操作作用于「${safeName()}」。`}</p></div></div></section>`;
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
    return `<section class="page">${header('创建私密空间')}<div class="page-scroll"><form class="content-width" id="create-form"><p class="body-copy">给这个空间起个名字，再把邀请发给对方。</p><label class="form-label" for="new-space-name">空间名称</label><input class="text-input" id="new-space-name" name="name" placeholder="例如：周末计划" maxlength="160" autocomplete="off" required><p class="field-hint">名称只对你可见，对方可以使用自己的名称。</p><p class="field-error" id="create-error" role="alert" hidden></p><div class="form-actions"><button class="primary-button" type="submit">创建空间</button></div></form></div></section>`;
  }
  function renderMain(pop = false) {
    const pages = { spaces: () => listPage(), chat: chatPage, settings: settingsPage, appearance: appearancePage, presence: presencePage, autolock: autolockPage, devices: devicesPage, create: createPage };
    if (desktop && route === 'spaces') route = 'chat';
    const body = (pages[route] || pages.chat)();
    if (typeof body === 'string') ui.main.innerHTML = body; else ui.main.replaceChildren(body);
    const page = $('.page', ui.main); page.classList.remove('page-enter', 'is-popping');
    if (route !== 'chat') page.classList.add('page-enter', ...(pop ? ['is-popping'] : []));
    const scroll = $('.page-scroll', ui.main);
    if (scroll) scroll.scrollTop = scrollPositions.get(`${current}:${route}`) ?? (route === 'chat' ? scroll.scrollHeight : 0);
    if (route === 'spaces') bindList(ui.main);
    if (route === 'create') $('#create-form').addEventListener('submit', createSpace);
    ui.main.setAttribute('aria-label', { spaces: '私密空间', chat: '聊天', settings: '设置', appearance: '主题外观', presence: '在线状态样式', autolock: '自动锁定', devices: '设备管理', create: '创建私密空间' }[route]);
    syncPageEdges();
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
    ui.dialog.showModal(); return operationToken;
  }
  function closeDialog(cancel = true) {
    const callback = dialogCancel; dialogCancel = null; operationToken++;
    if (ui.dialog.open) ui.dialog.close();
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
    if (!name) { $('#create-error').hidden = false; $('#create-error').textContent = '请输入 1–40 个字符的名称，不含控制字符。'; return; }
    verifyDialog({ name }, () => {
      const space = { id: `demo-${nextId++}`, name, waiting: true, deadline: Date.now() + 60 * 60 * 1000, unread: 0 };
      spaces.push(space); stack = []; route = desktop ? 'chat' : 'spaces'; renderSidebar(); renderMain(); invitationDialog(space);
    }, '创建空间');
  }
  function invitationDialog(space = selectedSpace()) {
    if (!space) return;
    openDialog(`<h2 id="dialog-title">邀请对方加入</h2><p>${escape(space.name)}</p><div class="invitation-code">DEMO · ONLY</div><p>这是演示邀请，不能用于真实接入。关闭后，待加入空间会保留在列表中。</p><div class="dialog-actions"><button class="secondary-button" data-dialog="cancel">返回空间列表</button><button class="primary-button" id="copy-demo">复制演示邀请</button></div>`, () => { route = desktop ? 'chat' : 'spaces'; stack = []; renderSidebar(); renderMain(); });
    ui.dialog.classList.add('is-invitation');
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
  $('#preview-scheme').addEventListener('change', event => { scheme = event.target.value; applyScheme(); if (route === 'appearance') { savePosition(); renderMain(); } });
  systemScheme.addEventListener('change', applyScheme);
  function refreshSize() {
    const next = ui.frame.clientWidth >= 1024;
    if (next !== desktop) { savePosition(); desktop = next; renderSidebar(); renderMain(); }
    $('#preview-caption').textContent = desktop ? '桌面 · 280px 可收起侧栏 + 独立设置内容区' : '手机 · 独立空间列表页';
    if (ui.dialog.open && ui.dialog.classList.contains('is-invitation')) positionInvitation();
  }
  function positionInvitation() {
    const rect = ui.frame.getBoundingClientRect(), width = Math.min(rect.width - 2, 520), height = Math.min(rect.height - 24, Math.max(300, rect.height * .52));
    Object.assign(ui.dialog.style, { width: `${width}px`, height: `${height}px`, maxHeight: `${height}px`, left: `${rect.left + (rect.width - width) / 2}px`, top: `${Math.max(12, rect.bottom - height - 1)}px` });
  }
  $('#preview-size').addEventListener('change', event => { ui.frame.dataset.size = event.target.value; refreshSize(); });
  new ResizeObserver(refreshSize).observe(ui.frame);
  function setScenario(value) {
    refreshSize();
    closeDialog(false); scenario = value; spaces = baseSpaces(); current = 'demo-1'; stack = []; chatPages.clear(); scrollPositions.clear(); focusPositions.clear();
    if (value === 'single') spaces = spaces.slice(0, 1);
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
