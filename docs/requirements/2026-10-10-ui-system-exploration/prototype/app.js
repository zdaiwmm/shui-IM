import { icons } from './icons.js';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = value => { const span = document.createElement('span'); span.textContent = String(value); return span.innerHTML; };
const icon = name => '<i data-icon="' + name + '"></i>';
function paintIcons(root = document) {
  $$('[data-icon]', root).forEach(node => {
    const data = icons[node.dataset.icon];
    if (!data) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('class','icon'); svg.setAttribute('aria-hidden','true');
    data.forEach(([tag,attrs]) => { const shape = document.createElementNS(svg.namespaceURI,tag); Object.entries(attrs).forEach(([key,value]) => shape.setAttribute(key,String(value))); svg.append(shape); });
    node.replaceWith(svg);
  });
}
const seed = [
  { id:'m1',text:'周六下午见？',side:'in',time:'14:32',group:'start' },
  { id:'m2',text:'还是上次那家咖啡店。',side:'in',time:'14:32',group:'end tail' },
  { id:'m3',text:'好呀，靠窗的位置 😊',side:'out',time:'14:33',group:'tail group-gap' },
  { id:'m4',text:'我把时间空出来了。',side:'in',time:'14:34',group:'start group-gap' },
  { id:'m5',text:'慢慢聊，不着急。',side:'in',time:'14:34',group:'end tail' },
  { id:'m6',text:'我大概三点到。',side:'out',time:'14:35',group:'start group-gap' },
  { id:'m7',text:'要不要帮你点杯拿铁？',side:'out',time:'14:35',group:'end tail' },
  { id:'m8',text:'好，少冰就行。',side:'in',time:'14:36',group:'tail group-gap' },
  { id:'m9',text:'那一会儿见 ☕',side:'out',time:'14:37',group:'tail group-gap' },
];
const state = { theme:'light',screen:'chat',keyboard:'closed',messages:structuredClone(seed),draft:'',reply:null,follow:true,newCount:0,offline:false,nextFailure:false,loading:false,lock:30,history:false };
const list = $('#message-list'), input = $('#message-input'), device = $('#device'), views = $('#app-views');
let sequence = 20, currentOverlay = null, lastTrigger = null, toastTimer = null, voiceTimer = null, nativeKeyboard = false, restoring = false, loadingSequence = 0, geometryVersion = 0;
const timers = new Set(), localUrls = new Set();
const later = (fn,ms) => { const id = setTimeout(() => { timers.delete(id); fn(); },ms); timers.add(id); return id; };
const mobile = () => matchMedia('(max-width:760px)').matches;
const reduced = () => document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion:reduce)').matches;
const isLatest = () => list.scrollHeight - list.scrollTop - list.clientHeight < 18;
function anchor() {
  const box = list.getBoundingClientRect();
  const first = $$('.bubble',list).find(node => node.getBoundingClientRect().bottom > box.top + 1);
  return { bottom:state.follow, id:first?.dataset.id, offset:first ? first.getBoundingClientRect().top - box.top : 0, scroll:list.scrollTop };
}
function restore(mark,forceBottom = false) {
  restoring = true;
  if (forceBottom || mark.bottom) list.scrollTop = list.scrollHeight;
  else {
    const target = mark.id ? $('[data-id="' + mark.id + '"]',list) : null;
    if (target) list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - mark.offset;
    else list.scrollTop = mark.scroll;
  }
  requestAnimationFrame(() => { restoring = false; updateLatest(); });
}
function geometryChange(change,forceBottom = false) {
  const mark = anchor(), version = ++geometryVersion; change();
  requestAnimationFrame(() => { if(version!==geometryVersion)return;restore(mark,forceBottom);alignGradient();updateMetric(); });
}
function alignGradient() {
  const outgoing = $$('.bubble.out',list);
  if (outgoing.length) {
    const top = outgoing[0].getBoundingClientRect().top, bottom = outgoing.at(-1).getBoundingClientRect().bottom, span = Math.max(1,bottom-top);
    const stops = [[0,[148,76,213]],[.45,[147,73,244]],[1,[55,104,255]]];
    outgoing.forEach(node => {
      const rect = node.getBoundingClientRect(), t = Math.min(1,Math.max(0,(rect.bottom-top)/span)), pair = t <= .45 ? [stops[0],stops[1]] : [stops[1],stops[2]], f = (t-pair[0][0])/(pair[1][0]-pair[0][0]);
      node.style.setProperty('--gradient-span',span+'px'); node.style.setProperty('--gradient-offset',-(rect.top-top)+'px');
      node.style.setProperty('--tail-color','rgb('+pair[0][1].map((v,i)=>Math.round(v+(pair[1][1][i]-v)*f)).join(',')+')');
    });
  }
  list.style.setProperty('--wallpaper-height',Math.max(list.clientHeight,($('.message-content',list)?.getBoundingClientRect().height || 0)+32)+'px');
}
function metadata(message) {
  const status = message.status || 'read';
  return '<span class="meta" aria-label="'+escape(message.time)+(message.side === 'out' ? '，'+({pending:'等待发送（演示）',sent:'服务器已保存（演示）',read:'已读（演示）',failed:'发送失败（演示）'}[status]) : '')+'">'+escape(message.time)+(message.side === 'out' ? icon(status === 'pending' ? 'Clock3' : status === 'read' ? 'CheckCheck' : status === 'failed' ? 'CircleAlert' : 'Check') : '')+'</span>';
}
function messageNode(message,animate = false) {
  const node = document.createElement('article'); node.className = 'bubble '+(message.side === 'out' ? 'out ' : '')+(message.group || 'tail group-gap')+(animate ? ' enter' : ''); node.dataset.id = message.id; node.setAttribute('aria-label',(message.side === 'out' ? '我：' : '晚风：')+(message.text || message.name || '语音消息')); node.tabIndex = 0;
  let content = message.reply ? '<button class="bubble-quote" data-action="quote" data-id="'+escape(message.reply.id)+'"><strong>'+escape(message.reply.side === 'in' ? '晚风' : '我')+'</strong>'+escape(message.reply.text || message.reply.name || '附件')+'</button>' : '';
  if (message.type === 'photo') content += '<img class="message-photo" src="'+escape(message.url)+'" alt="'+escape(message.name)+'">';
  else if (message.type === 'file') content += '<span class="message-file">'+icon('File')+'<span>'+escape(message.name)+'<small>'+escape(message.size || '本地附件')+'</small></span></span>';
  else if (message.type === 'voice') content += '<span class="voice-wave">'+icon('Headphones')+[8,16,11,23,14,20,9,24,15,21,12,18,9,23,16,11,20,8].map(h=>'<i style="--h:'+h+'px"></i>').join('')+'<small>'+message.duration+'″</small></span>';
  else content += '<span class="message-copy">'+escape(message.text)+'</span>';
  node.innerHTML = content + metadata(message)+(message.status === 'failed' ? '<button class="retry-button" data-action="retry" data-id="'+message.id+'">'+icon('RotateCcw')+'发送失败，重试</button>' : '');
  paintIcons(node);
  if (message.type === 'photo') $('img',node).addEventListener('load',()=>{ alignGradient(); if (state.follow) toLatest(false); });
  return node;
}
function renderMessages() {
  list.setAttribute('aria-busy',String(state.loading));input.disabled=state.loading;$('#send-button').disabled=state.loading;$('#voice-button').disabled=state.loading;
  list.replaceChildren();
  const content = document.createElement('div'); content.className = 'message-content';
  if (state.loading) content.innerHTML = '<span class="date">正在加载</span>'+Array.from({length:5},()=>'<div class="loading-message"></div>').join('');
  else if (!state.messages.length) content.innerHTML = '<div class="empty-state">'+icon('MessageSquare')+'<strong>从一句问候开始</strong><span>发一条消息，让对话继续。</span><br><button data-action="focus-input">发条消息</button></div>';
  else {
    const date = document.createElement('span'); date.className = 'date'; date.textContent = state.history ? '更早的对话' : '10月10日'; content.append(date);
    state.messages.forEach(message => content.append(messageNode(message)));
  }
  list.append(content); paintIcons(list); alignGradient(); updateLatest();
}
function appendMessage(message,own = false) {
  geometryVersion++;
  const mark = anchor();
  if (state.loading || !state.messages.length) { state.loading=false; loadingSequence++; state.messages.push(message); renderMessages(); }
  else { state.messages.push(message); $('.message-content',list).append(messageNode(message,true)); }
  if (own) { state.follow=true; state.newCount=0; restore(mark,true); }
  else if (mark.bottom) restore(mark,true);
  else { state.newCount++; restore(mark); }
  alignGradient(); updateLatest();
}
function updateMetadata(message) {
  const old = $('[data-id="'+message.id+'"] .meta',list);
  if (old) { const holder = document.createElement('span'); holder.innerHTML = metadata(message); const next = holder.firstElementChild; paintIcons(next); old.replaceWith(next); }
  if (message.status === 'failed' && !$('[data-id="'+message.id+'"] .retry-button',list)) {
    const mark=anchor(), node=$('[data-id="'+message.id+'"]',list);
    const button=document.createElement('button');button.className='retry-button';button.dataset.action='retry';button.dataset.id=message.id;button.innerHTML=icon('RotateCcw')+'发送失败，重试';paintIcons(button);node?.append(button);restore(mark);alignGradient();
  }
}
function deliver(message,fail = false) {
  later(()=>{ if (!state.messages.includes(message) || state.offline) return; message.status = fail ? 'failed' : 'sent'; updateMetadata(message); if (!fail) later(()=>{ if (state.messages.includes(message) && !state.offline) { message.status='read';updateMetadata(message); } },1000); },450);
}
function send(text = input.value) {
  if (!text.trim() || state.loading) return;
  const message={id:'m'+(++sequence),text:text.trim(),side:'out',time:'14:38',status:'pending',reply:state.reply ? {...state.reply} : null};
  const fail=state.nextFailure;state.nextFailure=false; appendMessage(message,true); state.draft='';input.value='';setReply(null,false);resizeInput();deliver(message,fail);
}
function resizeInput() {
  const mark=anchor(),version=++geometryVersion; input.style.height='33px';const inputHeight=Math.min(88,Math.max(33,input.scrollHeight));input.style.height=inputHeight+'px';$('.composer-line').style.setProperty('--composer-line-height',Math.max(43,inputHeight+7)+'px');
  $('#send-button').hidden=!input.value.trim();$('#voice-button').hidden=!!input.value.trim();
  requestAnimationFrame(()=>{if(version===geometryVersion)restore(mark);updateMetric()});
}
function toLatest(smooth = true) {
  state.follow=true;state.newCount=0;
  list.scrollTo({top:list.scrollHeight,behavior:smooth && !reduced() ? 'smooth' : 'instant'});updateLatest();
}
function updateLatest() {
  const atBottom=isLatest();$('#jump-latest').hidden=atBottom || !state.messages.length || state.screen!=='chat';
  if (atBottom) state.newCount=0;
  $('#new-count').hidden=!state.newCount;$('#new-count').textContent=state.newCount;
}
function updateMetric() {
  $('#viewport-metric').textContent=state.screen==='settings' ? (state.theme==='light'?'浅色':'深色')+' · 设置' : '聊天区 '+$('#app-viewport').clientHeight+'px · 消息区 '+list.clientHeight+'px';
}
function updateCompact() { device.classList.toggle('compact',state.keyboard!=='closed' || nativeKeyboard || document.activeElement===input); }
function keyboard(mode,focus = true) {
  if (mode!=='closed' && state.screen!=='chat') navigate('chat');
  geometryChange(()=>{
    state.keyboard=mode;
    $('#keyboard-stack').hidden=mode==='closed' || mobile();$('#browser-bar').hidden=mode!=='closed' || mobile();
    device.style.setProperty('--keyboard-height',Math.min(mode==='tall'?474:390,device.clientHeight*(mode==='tall'?.635:.52))+'px');
    $$('[data-action="keyboard"]').forEach(button=>{if(button.hasAttribute('aria-pressed'))button.setAttribute('aria-pressed',String(button.dataset.value===mode))});
    if (mode==='closed' && document.activeElement===input) input.blur();
    updateCompact();
  });
  if (mode!=='closed' && focus) input.focus({preventScroll:true});
}
function theme(value,announce = false) {
  state.theme=value;document.documentElement.dataset.theme=value;
  $('meta[name="theme-color"]').content=value==='dark'?'#252525':'#BEEAA1';
  $$('[data-action="theme"],[data-action="choose-theme"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.value===value)));
  $('#appearance-value').textContent=value==='dark'?'深色':'浅色';alignGradient();updateMetric();
  if (announce) toast('已切换为'+(value==='dark'?'深色':'浅色')+'模式');
}
function navigate(screen) {
  closeOverlay(true,false); if (screen==='settings') keyboard('closed',false);
  state.screen=screen;$('#chat-screen').hidden=screen!=='chat';$('#settings-screen').hidden=screen!=='settings';
  const node=screen==='chat'?$('#chat-screen'):$('#settings-screen');node.classList.remove('reveal');void node.offsetWidth;node.classList.add('reveal');
  $$('.scene').forEach(button=>button.classList.toggle('active',button.dataset.action===screen));
  if (screen==='chat') requestAnimationFrame(()=>{alignGradient();if(state.follow)toLatest(false);updateLatest()});
  updateMetric();
}
function setReply(message,focus = true) {
  geometryChange(()=>{
    state.reply=message;$('#reply-preview').hidden=!message;
    if (message) { $('#reply-name').textContent=message.side==='in'?'晚风':'我';$('#reply-text').textContent=message.text || message.name || '语音消息'; }
  });
  if (message && focus) input.focus({preventScroll:true});
}
function toast(text,action = null,error = false) {
  clearTimeout(toastTimer);const region=$('#toast-region');region.replaceChildren();
  const node=document.createElement('div');node.className='toast';if(error)node.setAttribute('role','alert');
  node.innerHTML=icon(error?'CircleAlert':'Check')+'<span>'+escape(text)+'</span>';
  if (action) {const button=document.createElement('button');button.textContent=action.label;button.onclick=()=>{action.run();region.replaceChildren()};node.append(button)}
  region.append(node);paintIcons(node);toastTimer=setTimeout(()=>region.replaceChildren(),action?7000:2600);
}
function closeOverlay(immediate = false,restoreFocus = true) {
  const overlay=currentOverlay;if(!overlay)return;currentOverlay=null;clearInterval(voiceTimer);voiceTimer=null;views.inert=false;
  const finish=()=>{overlay.layer.remove();if(restoreFocus && !currentOverlay && overlay.returnTo?.isConnected && overlay.returnTo!==input)overlay.returnTo.focus({preventScroll:true})};
  if(immediate || reduced())finish();else {overlay.layer.classList.add('closing');overlay.panel.classList.add('closing');later(finish,170)}
}
function overlay(html,{sheet=false,menu=false,label='面板'}={}) {
  const returnTo=lastTrigger || document.activeElement;closeOverlay(true,false);keyboard('closed',false);
  const layer=document.createElement('div');layer.className='overlay-layer'+(sheet?' sheet-layer':'');
  layer.innerHTML='<section class="panel '+(sheet?'sheet-panel':menu?'menu-panel':'dialog-panel')+'" role="dialog" aria-modal="true" aria-label="'+escape(label)+'" tabindex="-1">'+(sheet?'<button class="sheet-grab" aria-label="向下拖动或点击关闭面板" data-action="close-overlay"></button>':'')+html+'</section>';
  $('#overlay-root').append(layer);const panel=$('.panel',layer);views.inert=true;currentOverlay={layer,panel,returnTo};paintIcons(layer);
  layer.addEventListener('click',event=>{if(event.target===layer)closeOverlay()});
  requestAnimationFrame(()=>panel.focus({preventScroll:true}));
  if(sheet)bindSheetDrag($('.sheet-grab',panel),panel);
  return panel;
}
function sheet(title,body) { return overlay('<header class="sheet-header"><h3>'+escape(title)+'</h3><button class="icon-button" data-action="close-overlay" aria-label="关闭面板">'+icon('X')+'</button></header>'+body,{sheet:true,label:title}); }
function confirm(title,description,onConfirm,{label='确认',danger=false}={}) {
  const panel=overlay('<div class="dialog-copy"><h3>'+escape(title)+'</h3><p>'+escape(description)+'</p></div><div class="dialog-buttons"><button data-action="close-overlay">取消</button><button class="'+(danger?'danger':'emphasis')+'" id="dialog-confirm">'+escape(label)+'</button></div>',{label:title});
  $('#dialog-confirm',panel).onclick=()=>{closeOverlay();onConfirm()};
}
function bindSheetDrag(handle,panel) {
  let start=0,time=0,dy=0,drag=false;
  handle.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();start=event.clientY;time=performance.now();dy=0;drag=true;handle.setPointerCapture(event.pointerId);panel.classList.add('dragging')});
  handle.addEventListener('pointermove',event=>{if(!drag)return;dy=Math.max(0,event.clientY-start);panel.style.transform='translateY('+dy+'px)'});
  const finish=()=>{if(!drag)return;drag=false;panel.classList.remove('dragging');if(dy>Math.min(90,panel.clientHeight*.28) || dy>24 && dy/Math.max(1,performance.now()-time)>.6){closeOverlay()}else{panel.style.transition='transform 160ms var(--ease)';panel.style.transform='';later(()=>panel.style.transition='',170)}};
  handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',()=>{dy=0;finish()});
}
function tools() {
  navigate('chat');
  const items=[['Image','图片','photo'],['Camera','拍摄','camera'],['Video','视频通话','video-call'],['Headphones','实时语音','call'],['File','文件','file'],['Star','收藏','favorites']];
  sheet('发送内容','<div class="tool-grid">'+items.map(([glyph,label,action])=>'<button data-action="'+action+'">'+icon(glyph)+'<span>'+label+'</span></button>').join('')+'</div>');
}
function appearance() { sheet('主题外观','<div class="appearance-options">'+['light','dark'].map(value=>'<button class="appearance-option" data-action="choose-theme" data-value="'+value+'" aria-pressed="'+(state.theme===value)+'"><span class="theme-miniature '+(value==='dark'?'dark-mini':'')+'" aria-hidden="true"><i></i><i></i></span>'+(value==='light'?'浅色':'深色')+'</button>').join('')+'</div><p class="sheet-note">浅色柔绿壁纸，深色黑底紫蓝。选择立即应用。</p>'); }
function autoLock() { const durations=[20,30,40,50,60,120,180,240,300,0];sheet('自动锁定','<fieldset class="radio-options"><legend class="sr-only">自动锁定时间</legend>'+durations.map(value=>'<label class="radio-choice"><span>'+(value===0?'永不':value<60?value+' 秒':value/60+' 分钟')+'</span><input type="radio" name="auto-lock" value="'+value+'" '+(state.lock===value?'checked':'')+'></label>').join('')+'</fieldset><p class="sheet-note">仅适用于本机。“永不”仅关闭无操作锁定，离开页面和安全验证仍按原规则处理。</p>'); }
function messageMenu(id) {
  const message=state.messages.find(item=>item.id===id);if(!message)return;
  const panel=overlay('<p class="menu-preview">'+escape(message.text||message.name||'语音消息')+'</p><button class="menu-row" data-action="reply-message" data-id="'+id+'">'+icon('Reply')+'回复</button><button class="menu-row" data-action="copy-message" data-id="'+id+'">'+icon('Copy')+'复制</button>'+(message.side==='out'?'<button class="menu-row danger" data-action="delete-message" data-id="'+id+'">'+icon('Trash2')+'删除消息</button>':''),{menu:true,label:'消息操作'});
  return panel;
}
function deleteMessage(id) {
  const message=state.messages.find(item=>item.id===id);if(!message)return;
  confirm('删除这条消息？','删除后，这条消息将从当前对话中移除。',()=>{
    const mark=anchor(),index=state.messages.indexOf(message);state.messages.splice(index,1);if(state.reply?.id===id)setReply(null,false);renderMessages();restore(mark);
    toast('已删除消息',{label:'撤销',run:()=>{const before=anchor();state.messages.splice(Math.min(index,state.messages.length),0,message);renderMessages();restore(before);toast('已恢复消息')}});
  },{label:'删除',danger:true});
}
function voice() {
  let seconds=0;
  const panel=sheet('语音效果预览','<div class="voice-demo"><div class="record-time" id="record-time">00:00</div><div class="record-wave">'+[12,20,30,18,27,35,21,14,31,24,17,29,13,22,33,19].map((h,i)=>'<i style="--h:'+h+'px;--delay:'+(-i*45)+'ms"></i>').join('')+'</div><div class="button-pair"><button data-action="close-overlay">取消</button><button class="filled" id="send-voice">发送</button></div><p class="sheet-note">只演示录音状态，不调用麦克风。</p></div>');
  voiceTimer=setInterval(()=>{seconds++;const timer=$('#record-time',panel);if(timer)timer.textContent='00:'+String(seconds).padStart(2,'0')},1000);
  $('#send-voice',panel).onclick=()=>{closeOverlay();const message={id:'m'+(++sequence),type:'voice',duration:Math.max(1,Math.min(59,seconds)),side:'out',time:'14:38',status:'pending'};appendMessage(message,true);deliver(message);toast('已发送语音示例')};
}
function incoming() { navigate('chat');appendMessage({id:'m'+(++sequence),side:'in',text:sequence%2?'我到了，坐在靠窗这边。':'别着急，路上慢一点 😊',time:'14:38'}); }
function history() {
  navigate('chat');
  if(!state.history){state.history=true;const old=Array.from({length:14},(_,index)=>({id:'h'+index,text:['刚刚看到那家店又出了新品。','下次一起去试试吧。','好，周末应该有空。','那就这么说定了。'][index%4],side:index%3===0?'out':'in',time:'13:'+String(10+index).padStart(2,'0'),group:'tail group-gap'}));const mark=anchor();state.messages.unshift(...old);renderMessages();restore(mark)}
  state.follow=false;list.scrollTop=Math.max(0,list.scrollHeight-list.clientHeight-360);updateLatest();toast('已翻到更早的对话');
}
function offline(value) { state.offline=value;$('#connection-banner').hidden=!value;$('#peer-status').textContent=value?'连接已断开':'在线';$('#offline-control').innerHTML=icon(value?'RotateCcw':'WifiOff')+(value?'重新连接':'断线与重连');paintIcons($('#offline-control'));if(!value)state.messages.filter(message=>message.status==='pending').forEach(message=>deliver(message)); }
function reset() {
  closeOverlay(true,false);timers.forEach(clearTimeout);timers.clear();loadingSequence++;clearTimeout(toastTimer);$('#toast-region').replaceChildren();localUrls.forEach(URL.revokeObjectURL);localUrls.clear();
  Object.assign(state,{screen:'chat',keyboard:'closed',messages:structuredClone(seed),draft:'',reply:null,follow:true,newCount:0,offline:false,nextFailure:false,loading:false,lock:30,history:false});input.value='';input.style.height='33px';$('#reply-preview').hidden=true;$('#lock-value').textContent='30 秒';$('#notifications').checked=true;$('#sound').checked=true;offline(false);navigate('chat');keyboard('closed',false);renderMessages();resizeInput();toLatest(false);toast('已恢复初始对话');
}

const actions = {
  chat:()=>navigate('chat'),back:()=>navigate('chat'),settings:()=>navigate('settings'),
  theme:b=>theme(b.dataset.value),'choose-theme':b=>theme(b.dataset.value,true),
  keyboard:b=>keyboard(b.dataset.value),tools,appearance,'auto-lock':autoLock,
  'close-overlay':()=>closeOverlay(),latest:()=>toLatest(),'focus-input':()=>input.focus({preventScroll:true}),
  'cancel-reply':()=>setReply(null),'send-key':()=>send(),
  'quick-text':b=>{input.setRangeText(b.dataset.value,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}))},
  'chat-menu':()=>overlay('<button class="menu-row" data-action="settings">'+icon('Settings2')+'设置</button><button class="menu-row" data-action="history">'+icon('History')+'翻看历史消息</button><button class="menu-row" data-action="appearance">'+icon('SunMoon')+'主题外观</button>',{menu:true,label:'聊天菜单'}),
  'reply-message':b=>{const m=state.messages.find(x=>x.id===b.dataset.id);closeOverlay(true,false);if(m)setReply(m)},
  'copy-message':async b=>{const m=state.messages.find(x=>x.id===b.dataset.id);closeOverlay();try{await navigator.clipboard.writeText(m?.text||m?.name||'语音消息');toast('已复制')}catch{toast('复制受限，可长按选择文字',null,true)}},
  'delete-message':b=>deleteMessage(b.dataset.id),
  'demo-dialog':()=>{navigate('chat');const m=state.messages.findLast(x=>x.side==='out');if(m)deleteMessage(m.id);else confirm('清空草稿？','当前输入内容将被清空。',()=>{input.value='';state.draft='';resizeInput();toast('已清空草稿')},{label:'清空',danger:true})},
  'clear-draft':()=>confirm('清空草稿？','当前输入内容将被清空，已发送消息不受影响。',()=>{input.value='';state.draft='';setReply(null,false);resizeInput();toast('已清空草稿')},{label:'清空',danger:true}),
  retry:b=>{const m=state.messages.find(x=>x.id===b.dataset.id);if(!m)return;const mark=anchor();m.status='pending';b.remove();updateMetadata(m);restore(mark);alignGradient();deliver(m);toast('正在重试')},
  quote:b=>{const node=$('[data-id="'+b.dataset.id+'"]',list);if(!node){toast('原消息已不可用');return}state.follow=false;node.scrollIntoView({block:'center',behavior:reduced()?'instant':'smooth'});node.classList.add('highlight');later(()=>node.classList.remove('highlight'),1200)},
  incoming,history,
  failure:()=>{navigate('chat');state.nextFailure=true;send('我快到了，帮我留个位子。')},
  offline:()=>{navigate('chat');const mark=anchor();offline(!state.offline);restore(mark);toast(state.offline?'已进入断线演示':'已重新连接')},
  reconnect:()=>{const mark=anchor();offline(false);restore(mark);toast('已重新连接')},
  empty:()=>{navigate('chat');state.messages=[];state.loading=false;loadingSequence++;state.history=false;state.newCount=0;state.follow=true;setReply(null,false);renderMessages();toast('空对话状态，重置可恢复示例')},
  loading:()=>{navigate('chat');state.loading=true;const token=++loadingSequence;renderMessages();later(()=>{if(token!==loadingSequence)return;state.loading=false;renderMessages();toLatest(false)},1800)},
  reset:()=>reset(),
  expressions:()=>sheet('表情','<div class="expression-grid">'+['😊','😄','🥰','😎','🤔','🥳','👍','❤️','✨','🎉','☕','👋','😂','👏','🌿','🙌','💙','💜'].map(e=>'<button data-action="emoji" data-value="'+e+'" aria-label="插入表情 '+e+'">'+e+'</button>').join('')+'</div>'),
  emoji:b=>{input.value+=b.dataset.value;state.draft=input.value;resizeInput();toast('已添加表情')},
  voice,photo:()=>$('#photo-picker').click(),camera:()=>$('#camera-picker').click(),file:()=>$('#file-picker').click(),
  favorites:()=>sheet('收藏','<div class="empty-state">'+icon('Star')+'<strong>暂无收藏</strong><span>收藏过的图片和文件会出现在这里。</span></div>'),
  call:()=>confirm('语音通话','开始与晚风的语音通话效果预览？',()=>toast('语音通话演示已连接',{label:'结束',run:()=>toast('演示通话已结束')}),{label:'开始体验'}),
  'video-call':()=>confirm('视频通话','开始与晚风的视频通话效果预览？',()=>toast('视频通话演示已连接',{label:'结束',run:()=>toast('演示通话已结束')}),{label:'开始体验'}),
  about:()=>overlay('<div class="dialog-copy"><h3>Quiet Room · P1</h3><p>本地交互原型，使用模拟对话。<br>不会接入正式聊天或上传附件。<br>键盘、通话与回执为演示。</p></div><div class="dialog-buttons"><button data-action="close-overlay">知道了</button><button data-action="reset">重置演示</button></div>',{label:'关于此原型'}),
};
document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b||b.disabled)return;lastTrigger=b;const action=actions[b.dataset.action];if(action){e.preventDefault();void action(b)}});
$('#composer').addEventListener('submit',e=>{e.preventDefault();send()});
input.addEventListener('input',()=>{state.draft=input.value;resizeInput()});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}});
input.addEventListener('focus',()=>{if(!mobile()&&state.keyboard==='closed')keyboard('standard',false);else geometryChange(updateCompact)});
input.addEventListener('blur',()=>requestAnimationFrame(()=>geometryChange(updateCompact)));
$('#keyboard-stack').addEventListener('pointerdown',e=>{if(e.target.closest('button'))e.preventDefault()});
$('#reduce-motion').addEventListener('change',e=>{document.documentElement.dataset.motion=e.target.checked?'off':'on';toast(e.target.checked?'已减弱动效':'已恢复标准动效')});
$('#notifications').addEventListener('change',e=>toast(e.target.checked?'消息通知已开启（演示）':'消息通知已关闭（演示）'));
$('#sound').addEventListener('change',e=>toast(e.target.checked?'声音与反馈已开启（演示）':'声音与反馈已关闭（演示）'));
document.addEventListener('change',e=>{if(e.target.matches('[name="auto-lock"]')){state.lock=Number(e.target.value);$('#lock-value').textContent=state.lock===0?'永不':state.lock<60?state.lock+' 秒':state.lock/60+' 分钟';toast('已生效（演示）')}});
for(const selector of ['#photo-picker','#camera-picker','#file-picker']){
  $(selector).addEventListener('change',e=>{
    const files=[...e.target.files];if(!files.length)return;closeOverlay(true,false);
    for(const file of files.slice(0,6)){const photo=file.type.startsWith('image/'),url=photo?URL.createObjectURL(file):null;if(url)localUrls.add(url);const m={id:'m'+(++sequence),side:'out',type:photo?'photo':'file',url,name:file.name,size:file.size>=1048576?(file.size/1048576).toFixed(1)+' MB':Math.max(1,Math.round(file.size/1024))+' KB',time:'14:38',status:'pending'};appendMessage(m,true);deliver(m)}
    e.target.value='';toast('已添加本地附件预览');
  });
}
list.addEventListener('contextmenu',e=>{const node=e.target.closest('.bubble');if(node){e.preventDefault();messageMenu(node.dataset.id)}});
let gesture=null;
list.addEventListener('pointerdown',e=>{const node=e.target.closest('.bubble');if(!node||e.target.closest('button')||e.button!==0)return;gesture={node,startX:e.clientX,startY:e.clientY,dx:0,swiping:false,pointer:e.pointerType,timer:later(()=>{if(gesture&&!gesture.swiping){messageMenu(node.dataset.id);gesture=null}},480)}});
list.addEventListener('pointermove',e=>{if(!gesture)return;const dx=e.clientX-gesture.startX,dy=e.clientY-gesture.startY;if(Math.abs(dx)>7||Math.abs(dy)>7){clearTimeout(gesture.timer);timers.delete(gesture.timer)}if(gesture.pointer!=='mouse'&&dx>18&&Math.abs(dy)<12)gesture.swiping=true;if(gesture.swiping){gesture.dx=Math.min(70,Math.max(0,dx));gesture.node.classList.add('dragging');gesture.node.style.transform='translateX('+gesture.dx+'px)'}});
function endGesture(cancel=false){if(!gesture)return;const g=gesture;gesture=null;clearTimeout(g.timer);timers.delete(g.timer);g.node.classList.remove('dragging');g.node.style.transition='transform 160ms var(--ease)';g.node.style.transform='';later(()=>g.node.style.transition='',170);if(!cancel&&g.swiping&&g.dx>46){const m=state.messages.find(x=>x.id===g.node.dataset.id);if(m)setReply(m)}}
list.addEventListener('pointerup',()=>endGesture());list.addEventListener('pointercancel',()=>endGesture(true));
list.addEventListener('wheel',e=>{if(e.deltaY<0)state.follow=false},{passive:true});
let touchY=0;
list.addEventListener('touchstart',e=>{touchY=e.touches[0]?.clientY||0},{passive:true});list.addEventListener('touchmove',e=>{if((e.touches[0]?.clientY||0)>touchY+4)state.follow=false},{passive:true});
list.addEventListener('scroll',()=>{if(!restoring)state.follow=isLatest();updateLatest()},{passive:true});
list.addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='PageUp')state.follow=false;if((e.key==='Enter'||e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey)&&e.target.matches('.bubble')){e.preventDefault();messageMenu(e.target.dataset.id)}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){if(currentOverlay)closeOverlay();else if(state.keyboard!=='closed'||document.activeElement===input)keyboard('closed');else if(state.screen==='settings')navigate('chat');return}
  if(e.key==='Tab'&&currentOverlay){const nodes=$$('button:not(:disabled),input:not(:disabled),[tabindex="0"]',currentOverlay.panel).filter(n=>n.getClientRects().length);if(!nodes.length){e.preventDefault();currentOverlay.panel.focus();return}const index=nodes.indexOf(document.activeElement);if(e.shiftKey&&index<=0){e.preventDefault();nodes.at(-1).focus()}else if(!e.shiftKey&&(index<0||index===nodes.length-1)){e.preventDefault();nodes[0].focus()}}
});
$('#keyboard-keys').innerHTML=['qwertyuiop','asdfghjkl','zxcvbnm'].map(row=>'<div class="key-row">'+[...row].map(c=>'<button data-action="quick-text" data-value="'+c+'">'+c+'</button>').join('')+'</div>').join('');
let nativeBaseline=window.visualViewport?.height||window.innerHeight;
let nativeMark=null;
function nativeViewport(){const vv=window.visualViewport;if(mobile()){const h=vv?.height||window.innerHeight;nativeBaseline=Math.max(nativeBaseline,h);if(!nativeMark){nativeMark=anchor();restoring=true;requestAnimationFrame(()=>{const mark=nativeMark;nativeMark=null;restore(mark,state.follow);alignGradient();updateMetric()})}nativeKeyboard=document.activeElement===input&&nativeBaseline-h>100;document.documentElement.style.setProperty('--native-height',h+'px');document.documentElement.style.setProperty('--native-offset',(vv?.offsetTop||0)+'px');updateCompact()}else if(state.keyboard!=='closed')keyboard(state.keyboard,false)}
window.visualViewport?.addEventListener('resize',nativeViewport,{passive:true});window.visualViewport?.addEventListener('scroll',nativeViewport,{passive:true});window.addEventListener('resize',nativeViewport,{passive:true});
new ResizeObserver(()=>{alignGradient();updateMetric()}).observe($('#app-viewport'));
const compare=new URLSearchParams(location.search).get('compare');
if(compare){document.documentElement.dataset.compare=compare;state.theme=compare==='dark'?'dark':'light'}
$('#reduce-motion').checked=matchMedia('(prefers-reduced-motion:reduce)').matches;if($('#reduce-motion').checked)document.documentElement.dataset.motion='off';
paintIcons();theme(state.theme);renderMessages();resizeInput();nativeViewport();document.fonts.ready.then(()=>{alignGradient();toLatest(false);updateMetric()});
