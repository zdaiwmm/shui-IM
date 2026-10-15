const $ = (selector, root = document) => root.querySelector(selector);
const root = $('#app');
const status = $('#status');
const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1 3 4 3 4-3 4-3M8 8h.01M16 8h.01"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 15h10"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  settings: '<path d="m9 3 1-1h4l1 3 3 1 3 3-2 3 1 3-3 3-3-1-3 2-3-2-1-3-3-1v-4l3-1 1-3Z"/><circle cx="12" cy="12" r="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  camera: '<path d="M8 5 9 3h6l1 2h4v15H4V5Z"/><circle cx="12" cy="12" r="4"/>',
  video: '<rect x="2" y="5" width="13" height="14" rx="2"/><path d="m15 10 7-4v12l-7-4"/>',
  phone: '<path d="M5 3 2 5c0 9 8 17 17 17l3-4-6-4-2 3c-4-2-6-4-7-7l3-2-5-5Z"/>',
  file: '<path d="M5 2h9l5 5v15H5ZM14 2v6h5M8 12h8M8 16h8"/>',
  star: '<path d="m12 2 3 6 7 1-5 5 1 8-6-4-6 4 1-8-5-5 7-1Z"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
const art = '<div class="entry-art entry-art-lock" aria-hidden="true"><span class="entry-orbit"></span><span class="entry-ground"></span><div class="entry-fold entry-fold-one"><span class="entry-message"><i></i><i></i></span></div><div class="entry-fold entry-fold-two"><span class="entry-message"><i></i><i></i></span></div><span class="entry-spark"></span></div>';
const emojis = ['😀','🥰','😂','😊','😎','🥳','😌','😍','🤔','🙃','😴','🥹','🤗','😋','😮','😭','🌿','🌻','☀️','🌙','❤️','💛','🍒','🍉','☕','🎈','✨','🎉','🐱','🐶','🐼','🦊','👍','👏','🙌','🫶'];
let page = 'chat', mode = 'expression', frame = 0, sequenceTimers = [], resizeTimer;
let lastKeyboardHeight = null, geometry = { keyboard:350, expression:320, tools:230 };
let values = { occupancy:34, listY:0, ey:320, ea:0, ty:230, ta:0, ky:350 };
let draft = '', name = '我的 iPhone', lifetime = 0, entryResize;
const reduced = () => $('#reduce').checked || matchMedia('(prefers-reduced-motion: reduce)').matches;
const say = text => { status.textContent = text; };
const clearTimers = () => { sequenceTimers.forEach(clearTimeout); sequenceTimers = []; delete root.dataset.sequence; };
function sizeGeometry() {
  const h = root.clientHeight;
  geometry = { keyboard:Math.min(370, Math.round(h * .44) + 34),
    expression:lastKeyboardHeight ?? Math.min(354, Math.round(h * .4) + 34), tools:230 };
  $('#expression', root).style.height = `${geometry.expression}px`;
  $('#tools', root).style.height = `${geometry.tools}px`;
  $('#keyboard', root).style.height = `${geometry.keyboard}px`;
  $('#bottom-paint', root).style.height = `${Math.max(...Object.values(geometry))}px`;
}
function paint() {
  if (page !== 'chat' || !$('#composer-row', root)) return;
  $('#composer-row', root).style.transform = `translate3d(0,${34-values.occupancy}px,0)`;
  $('#messages', root).style.transform = `translate3d(0,${values.listY}px,0)`;
  $('#expression', root).style.transform = `translate3d(0,${values.ey}px,0)`;
  $('#expression', root).style.opacity = values.ea;
  $('#tools', root).style.transform = `translate3d(0,${values.ty}px,0)`;
  $('#tools', root).style.opacity = values.ta;
  $('#keyboard', root).style.transform = `translate3d(0,${values.ky}px,0)`;
  const max = Math.max(...Object.values(geometry));
  $('#bottom-paint', root).style.transform = `translate3d(0,${max-values.occupancy}px,0)`;
}
function setMode(next, instant = false) {
  if (page !== 'chat') renderPage('chat');
  if (!instant && mode === next && root.dataset.target === next) return;
  cancelAnimationFrame(frame);
  const previous = mode; mode = next;
  root.dataset.target = next;
  if (next === 'keyboard') lastKeyboardHeight = geometry.keyboard;
  if (next === 'expression') {
    const previousHeight=geometry.expression;
    geometry.expression = lastKeyboardHeight ?? previousHeight;
    $('#expression', root).style.height = `${geometry.expression}px`;
    if(values.ea < .001) { values.ey = geometry.expression; values.ea = 1; }
    else values.ey += geometry.expression-previousHeight;
  }
  if (next === 'tools' && values.ta < .001) { values.ty = geometry.tools; values.ta = 1; }
  const occupancy = next === 'keyboard' ? geometry.keyboard : next === 'expression' ? geometry.expression : next === 'tools' ? geometry.tools : 34;
  const goal = { occupancy, listY:$('#reading').value === 'latest' ? 34-occupancy : 0,
    ey:next === 'expression' ? 0 : next === 'keyboard' ? values.ey : geometry.expression,
    ea:next === 'expression' ? 1 : 0, ty:next === 'tools' ? 0 : next === 'keyboard' ? values.ty : geometry.tools,
    ta:next === 'tools' ? 1 : 0, ky:next === 'keyboard' ? 0 : geometry.keyboard };
  const start = {...values}, began = performance.now();
  const samples=[];
  const duration = [previous,next].includes('keyboard') ? 360 : 240;
  const labels = { keyboard:'键盘', expression:'表情', tools:'工具', closed:'收起' };
  $('#expression', root).inert = next !== 'expression';
  $('#tools', root).inert = next !== 'tools';
  $('#keyboard', root).inert = next !== 'keyboard';
  for (const [id, target] of [['expression','expression'],['tools','tools'],['keyboard','keyboard']]) $('#'+id, root).setAttribute('aria-hidden', String(next !== target));
  $('#emoji-toggle', root).innerHTML = svg(next === 'expression' ? 'keyboard' : 'smile');
  $('#emoji-toggle', root).setAttribute('aria-label', next === 'expression' ? '切回键盘' : '打开表情');
  $('#emoji-toggle', root).setAttribute('aria-expanded',String(next === 'expression'));
  $('#tools-toggle', root).innerHTML = svg(next === 'tools' ? 'close' : 'plus');
  $('#tools-toggle', root).setAttribute('aria-expanded',String(next === 'tools'));
  $('#bottom-paint', root).style.background = next === 'expression' || next === 'tools' ? 'var(--composer-panel-surface)' : 'var(--composer-surface)';
  const step = now => {
    const p = instant || reduced() ? 1 : Math.max(0,Math.min(1,(now-began)/duration));
    const q = 1-Math.pow(1-p,3);
    for (const key of Object.keys(values)) values[key] = start[key]+(goal[key]-start[key])*q;
    paint();
    const row=$('#composer-row',root).getBoundingClientRect(), header=$('.chat-header',root).getBoundingClientRect();
    const last=$('.message:last-child',root).getBoundingClientRect(), expression=$('#expression',root).getBoundingClientRect();
    const tool=$('#tools',root).getBoundingClientRect(), underlay=$('#bottom-paint',root).getBoundingClientRect();
    samples.push({row:row.top,header:header.top,gap:row.top-last.bottom,expression:expression.top,tool:tool.top,
      opacity:values.ea,seam:Math.abs(row.bottom-underlay.top)});
    if (p < 1) frame = requestAnimationFrame(step);
    else {
      root.dataset.settled = next; frame = 0;
      if(root.dataset.sequence==='settling')root.dataset.sequence='done';
      const first=samples[0],last=samples.at(-1),direction=Math.sign(last.row-first.row);
      const wrong=samples.slice(1).filter((sample,i)=>direction*(sample.row-samples[i].row)<-.2).length;
      $('#motion-report').textContent=JSON.stringify({transition:`${previous}→${next}`,frames:samples.length,
        rowReversals:wrong,headerShift:+(Math.max(...samples.map(s=>s.header))-Math.min(...samples.map(s=>s.header))).toFixed(2),
        latestGap:$('#reading').value==='latest'?+last.gap.toFixed(2):null,
        maxSeamGap:+Math.max(...samples.map(s=>s.seam)).toFixed(2),
        outgoingPanelTravel:next==='keyboard'?+(previous==='expression'?last.expression-first.expression:previous==='tools'?last.tool-first.tool:0).toFixed(2):null,
        expressionOvershoot:next==='expression'?+Math.max(0,last.expression-Math.min(...samples.map(s=>s.expression))).toFixed(2):null,
        expressionEndOpacity:+last.opacity.toFixed(3)},null,2);
    }
  };
  root.dataset.settled = '';
  // rAF timestamps may precede performance.now() within the same frame.
  // Paint exactly the captured start before accepting compositor samples.
  step(began);
  say(`${labels[previous]} → ${labels[next]}。${next === 'keyboard' ? '原面板原位渐隐，输入栏直接移向键盘上方。' : next === 'expression' ? '表情滑入与键盘收起同时进行，不叠加占位。' : next === 'tools' ? '工具背景连续覆盖底部安全区。' : '回到收起状态。'}`);
}
function renderChat() {
  root.innerHTML = `<header class="chat-header"><button class="icon chat-avatar" aria-label="空间列表（模拟）">🌱</button><div class="presence">TA · <i></i> 我<small>双方在线</small></div><button class="icon" aria-label="设置（模拟）">${svg('settings')}</button></header>
  <section class="timeline" aria-label="模拟聊天记录"><span class="reading-marker" hidden>正在阅读历史，切换时保留位置</span><div class="messages" id="messages"></div></section>
  <div class="bottom-paint" id="bottom-paint"></div>
  <section class="panel expression-panel" id="expression" aria-label="表情面板"><div class="expression-rail"><button class="icon" aria-label="添加表情合集（模拟）">＋</button><button class="icon" aria-label="Emoji" aria-pressed="true">${svg('smile')}</button><button class="icon" aria-label="收藏（模拟）">${svg('star')}</button><button class="icon" aria-label="本地合集（模拟）">🌿</button></div><div class="emoji-content"><p>Emoji</p><div class="emoji-grid">${emojis.map(e=>`<button type="button" aria-label="输入 ${e}">${e}</button>`).join('')}</div></div></section>
  <section class="panel tools-panel" id="tools" aria-label="聊天工具"><div class="tool-grid">${[['image','图片'],['camera','拍摄'],['video','视频通话'],['phone','实时语音'],['file','文件'],['star','收藏']].map(([icon,label])=>`<button type="button"><span>${svg(icon)}</span><span>${label}</span></button>`).join('')}</div></section>
  <section class="keyboard" id="keyboard" aria-label="模拟键盘"><div class="keyboard-accessory"><span class="keyboard-notice">键盘为原型模拟</span><button id="keyboard-done" type="button">完成</button></div><div class="keyboard-keys">${['QWERTYUIOP','ASDFGHJKL','ZXCVBNM'].map(line=>`<div class="keyboard-line">${[...line].map(k=>`<button type="button" class="key">${k}</button>`).join('')}</div>`).join('')}<div class="keyboard-line"><button class="key wide" type="button" data-key="123">123</button><button class="key space" type="button" data-key=" ">空格</button><button class="key wide" type="button" data-key="delete">删除</button></div></div></section>
  <form class="composer-row" id="composer-row"><button type="button" class="icon" id="tools-toggle" aria-label="更多功能" aria-expanded="false">${svg('plus')}</button><div class="draft-field"><label for="draft" hidden>输入消息</label><textarea id="draft" rows="1" placeholder="输入消息" enterkeyhint="send"></textarea><button type="button" class="icon" id="emoji-toggle" aria-label="打开表情" aria-expanded="false">${svg('smile')}</button></div><button class="icon" type="button" aria-label="录音（模拟）">${svg('mic')}</button></form><span class="home-indicator" aria-hidden="true"></span>`;
  $('#draft',root).value = draft;
  const history = $('#reading').value === 'history';
  $('.reading-marker',root).hidden = !history;
  $('#messages',root).innerHTML = `<p class="date">${history ? '昨天' : '今天'}</p>` + (history ? ['上次路过的那条小路，还记得吗？','记得，路边有一整排树。','下次也可以从那里走。'] : ['周末去河边走走？','好呀，等太阳快下山的时候。','那就五点见 🌿']).map((text,i)=>`<div class="message ${i === 1 ? 'out' : ''}"><div class="bubble">${text}<small>17:${42+i}${i === 1 ? ' ✓✓' : ''}</small></div></div>`).join('');
  if (history) $('#messages',root).style.bottom = '360px';
  const focusKeyboard=()=>{
    // Preserve the existing direct-focus rule: history focus goes to latest.
    // Panel-only replacement keeps the selected reading anchor.
    if($('#reading').value==='history') {
      $('#reading').value='latest';$('.reading-marker',root).hidden=true;
      $('#messages',root).style.removeProperty('bottom');
    }
    setMode('keyboard');
  };
  $('#draft',root).addEventListener('focus',focusKeyboard);
  $('#draft',root).addEventListener('click',focusKeyboard);
  $('#draft',root).addEventListener('input',event=>{ draft=event.target.value; });
  $('#draft',root).addEventListener('keydown',event=>{ if(event.key==='Escape') { event.target.blur(); setMode('closed'); } });
  $('#composer-row',root).addEventListener('submit',event=>event.preventDefault());
  $('#emoji-toggle',root).addEventListener('pointerdown',event=>event.preventDefault());
  $('#emoji-toggle',root).addEventListener('click',()=>{ $('#draft',root).blur(); setMode(mode === 'expression' ? 'keyboard' : 'expression'); });
  $('#tools-toggle',root).addEventListener('pointerdown',event=>event.preventDefault());
  $('#tools-toggle',root).addEventListener('click',()=>{ $('#draft',root).blur(); setMode(mode === 'tools' ? 'closed' : 'tools'); });
  $('#keyboard-done',root).addEventListener('click',()=>{ $('#draft',root).blur(); setMode('closed'); });
  $('.emoji-grid',root).addEventListener('click',event=>{ const button=event.target.closest('button'); if(button) { draft+=button.textContent; $('#draft',root).value=draft; say('表情已插入草稿，面板保持展开。'); } });
  $('.tool-grid',root).addEventListener('click',event=>{ if(event.target.closest('button')) say('此原型只演示工具入口与切换，未调用系统选择器、通话或收藏。'); });
  $('#keyboard',root).addEventListener('click',event=>{ const button=event.target.closest('.key'); if(!button)return; const k=button.dataset.key ?? button.textContent.toLowerCase(); if(k==='123')return; draft=k==='delete' ? [...draft].slice(0,-1).join('') : draft+k; $('#draft',root).value=draft; });
  sizeGeometry();
  values = { occupancy:34,listY:0,ey:geometry.expression,ea:0,ty:geometry.tools,ta:0,ky:geometry.keyboard };
  mode = 'closed'; setMode('expression',true);
}
function fitEntry() {
  const section=$('.entry-page',root), content=$('.entry-content',root);
  if(!section || !content)return;
  for(const hero of ['large','small','none']) { section.dataset.hero=hero; if(content.scrollHeight<=content.clientHeight+1)break; }
}
function closeOverlay() {
  $('.system-overlay',root)?.remove();
  const entry=$('.entry-page',root); if(entry)entry.inert=false;
  $('#setup',root)?.focus({preventScroll:true});
}
function trap(overlay) {
  overlay.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();closeOverlay();return;}
    if(event.key!=='Tab')return;
    const controls=[...overlay.querySelectorAll('button:not(:disabled),input')];
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
  });
}
function editName() {
  const entry=$('.entry-page',root); entry.inert=true;
  const overlay=document.createElement('div'); overlay.className='system-overlay';
  overlay.innerHTML='<form class="form-editor" role="dialog" aria-modal="true" aria-labelledby="editor-title"><label id="editor-title" for="edited-name">设置通行密钥名称</label><div><input id="edited-name" autocomplete="off" spellcheck="false"><button class="icon" type="submit" aria-label="完成名称编辑">完成</button></div></form>';
  root.append(overlay); const input=$('input',overlay); input.value=name;
  overlay.addEventListener('click',event=>{if(event.target===overlay)closeOverlay();});
  $('form',overlay).addEventListener('submit',event=>{event.preventDefault();name=input.value;$('#passkey-name',root).value=name;closeOverlay();});
  trap(overlay);input.focus({preventScroll:true});
}
function setup() {
  const error=$('.entry-error',root);
  const count=typeof Intl.Segmenter==='function' ? [...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(name.trim())].length : Array.from(name.trim()).length;
  if(!count || count>40 || /[\u0000-\u001f\u007f]/.test(name)) { error.textContent='请输入1–40个字符的通行密钥名称。';error.hidden=false;fitEntry();return; }
  error.hidden=true;
  const section=$('.entry-page',root);section.inert=true;
  const overlay=document.createElement('div');overlay.className='system-overlay';
  overlay.innerHTML='<section class="system-dialog" role="dialog" aria-modal="true" aria-labelledby="system-title"><h2 id="system-title">系统通行密钥（模拟）</h2><p>此处只演示认证结果返回后的页面状态，不创建真实凭据。</p><button class="primary" data-result="success">模拟成功</button><button class="secondary" data-result="cancel">取消</button><button class="secondary" data-result="error">模拟失败</button></section>';
  root.append(overlay);trap(overlay);$('[data-result="cancel"]',overlay).focus();
  overlay.addEventListener('click',event=>{
    if(event.target===overlay) {closeOverlay();return;}
    const result=event.target.closest('[data-result]')?.dataset.result;
    if(!result)return;
    closeOverlay();
    if(result==='cancel') {say('系统操作取消，保留名称与当前页面，不显示失败错误。');return;}
    if(result==='error') {error.textContent='暂时无法完成设置，请重试。';error.hidden=false;fitEntry();say('失败后保留名称，仍可重试或返回。');return;}
    root.innerHTML=`<section class="locked"><h2>${page==='create'?'空间已创建':'已加入空间'}</h2><p>这是成功结果的模拟。正式产品继续原有创建／加入后的聊天流程。</p><button class="primary" id="enter-chat">进入模拟聊天</button><button class="secondary" id="again">返回密钥页</button></section>`;
    $('#enter-chat',root).addEventListener('click',()=>renderPage('chat'));
    $('#again',root).addEventListener('click',()=>renderPage(page));
    say('模拟成功，不创建空间、不保存凭据或发送真实请求。');
  });
}
function renderEntry() {
  const join=page==='join';
  root.innerHTML=`<section class="entry-page" data-hero="large"><div class="entry-content"><div class="hero">${art}</div><div class="entry-heading"><h1>${join?'加入私密空间':'每次打开，先确认是你'}</h1><p>${join?'加入后，这个私密空间只属于你们两个人。<br>先设置访问密钥，以后用它解锁聊天。':'使用通行密钥保护您的空间隐私，暂时离开后会自动锁定空间，再次进入空间须验证通行密钥。'}</p></div><label class="name-field" for="passkey-name">设置通行密钥名称<input id="passkey-name" readonly aria-haspopup="dialog"></label></div><footer class="entry-actions"><p class="entry-error" role="alert" hidden></p><button class="primary" id="setup">${join?'设置访问密钥并加入':'设置密钥并创建空间'}</button><button class="secondary" id="back">${join?'暂不加入':'返回'}</button></footer></section><span class="home-indicator" aria-hidden="true"></span>`;
  $('#passkey-name',root).value=name;
  $('#passkey-name',root).addEventListener('click',editName);
  $('#passkey-name',root).addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();editName();}});
  $('#setup',root).addEventListener('click',setup);
  $('#back',root).addEventListener('click',()=>{
    root.innerHTML=`<section class="locked"><h2>${join?'暂不加入':'返回创建空间'}</h2><p>已回到原入口（模拟）。未设置任何真实密钥。</p><button class="primary" id="return-entry">重新进入密钥页</button></section>`;
    $('#return-entry',root).addEventListener('click',()=>renderPage(page));
    say('返回／暂不加入按原业务路径离开，本原型不访问邀请或凭据。');
  });
  entryResize=new ResizeObserver(fitEntry);entryResize.observe($('.entry-content',root));
  fitEntry();
  say(`${join?'受邀加入':'首次创建'}：共用主题色锁插图和排版，底部动作稳定；短屏先收缩插图。`);
}
function renderPage(next) {
  lifetime++;clearTimers();cancelAnimationFrame(frame);entryResize?.disconnect();
  page=next;delete root.dataset.target;delete root.dataset.settled;
  document.querySelectorAll('[data-page]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.page===page)));
  $('.chat-controls').hidden=page!=='chat';
  if(page==='chat')renderChat();else renderEntry();
}
document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>renderPage(button.dataset.page)));
$('#palette').addEventListener('change',event=>document.documentElement.dataset.theme=event.target.value);
$('#scheme').addEventListener('change',event=>document.documentElement.dataset.colorScheme=event.target.value);
$('#host').addEventListener('change',event=>$('.host-caption').textContent=event.target.value==='wechat'?'微信 WebView · 网页可绘制区域':'Safari · 网页可绘制区域');
$('#size').addEventListener('change',event=>{const [w,h]=event.target.value.split(',').map(Number);root.style.width=w+'px';root.style.maxWidth=w>430?'none':'100%';root.style.height=h+'px';lastKeyboardHeight=null;renderPage(page);});
$('#text-size').addEventListener('change',event=>{root.style.fontSize=event.target.value==='200'?'2rem':'1rem';fitEntry();});
$('#reading').addEventListener('change',()=>{if(page==='chat')renderChat();});
$('#reduce').addEventListener('change',()=>{document.documentElement.dataset.reduce=String($('#reduce').checked);if(page==='chat')setMode(mode,true);});
document.querySelectorAll('[data-sequence]').forEach(button=>button.addEventListener('click',()=>{
  clearTimers();if(page!=='chat')renderPage('chat');
  const [from,to]=button.dataset.sequence.split(',');setMode(from,true);
  root.dataset.sequence='running';
  sequenceTimers.push(setTimeout(()=>{root.dataset.sequence='settling';setMode(to);},600));
}));
$('#reverse').addEventListener('click',()=>{clearTimers();if(page!=='chat')renderPage('chat');setMode('expression',true);root.dataset.sequence='running';const targets=['keyboard','expression','keyboard','tools','keyboard','expression'];targets.forEach((target,i)=>sequenceTimers.push(setTimeout(()=>{if(i===targets.length-1)root.dataset.sequence='settling';setMode(target);},600+i*130)));});
$('#reset-height').addEventListener('click',()=>{lastKeyboardHeight=null;renderPage('chat');say('已重置测量：首次表情采用有界回退，键盘返回实际模拟高度后复用。');});
$('#privacy').addEventListener('click',()=>{
  lifetime++;clearTimers();cancelAnimationFrame(frame);entryResize?.disconnect();draft='';name='我的 iPhone';
  root.innerHTML='<section class="locked"><h2>已清除本次模拟内容</h2><p>隐私清理立即移除输入、面板与待处理画面，不等待退场动画。</p><button class="primary" id="restart">重新打开原型</button></section>';
  $('#restart',root).addEventListener('click',()=>renderPage('chat'));say('隐私清理完成，所有原型交接已取消。');
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimers();cancelAnimationFrame(frame);if(page==='chat'&&$('#composer-row',root))setMode(mode,true);$('.system-overlay',root)?.remove();const entry=$('.entry-page',root);if(entry)entry.inert=false;}});
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{fitEntry();},100);});
// Inspection exposes only simulated presentation, with no application state.
globalThis.handoffPrototype={ setMode, get state(){return {page,mode,values:{...values},geometry:{...geometry},settled:root.dataset.settled,draft,lifetime};} };
renderPage('chat');
