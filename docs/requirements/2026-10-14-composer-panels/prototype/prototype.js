import { icons, fluent, samples } from './resources.js';
import { sampleTrajectory,EXPRESSION_MS,PANEL_MS } from './motion.js';

const $ = selector => document.querySelector(selector);
const screen = $('.screen'), draft = $('#draft'), panel = $('#expression-panel'), tools = $('#tools-panel');
const content = $('#expression-content'), catalog = $('#catalog-page'), catalogContent = $('#catalog-content');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const prefersReduced=()=>reduced.matches||$('#motion-mode').value==='reduce';
document.documentElement.dataset.inputMode='pointer';
document.addEventListener('pointerdown',()=>document.documentElement.dataset.inputMode='pointer',true);
document.addEventListener('keydown',event=>{if(event.key==='Tab')document.documentElement.dataset.inputMode='keyboard';},true);
const packs = [
  { id:'walk', title:'散步日常', description:'12 张 · 示例合集', items:samples.slice(0,12) },
  { id:'animals', title:'小小动物', description:'12 张 · 示例合集', items:samples.slice(12,24) },
  { id:'mood', title:'今天的心情', description:'12 张 · 示例合集', items:samples.slice(24,36) },
  { id:'hello', title:'见面再说', description:'12 张 · 示例合集', items:samples.slice(36,48) },
];
let installed = ['walk','animals'], active = 'emoji', scenario = 'normal', expanded = false;
let catalogDetail = null, favoritesView = false, catalogMore = false, uploadTimers = new Map();
let selectedTool = '', toastTimer, pickerFocus, selection = {start:0,end:0};
let activePanel='emoji',motionFrame=0,motionStarted=0,motionKind='expression';
const moving=new Map();
const favoriteIds = new Set();

function svg(name) {
  const source = icons[name] ?? icons.Smile;
  function node([tag, attrs = {}, children = []]) {
    const element = document.createElementNS('http://www.w3.org/2000/svg',tag);
    for (const [key,value] of Object.entries(attrs)) element.setAttribute(key,value);
    children.forEach(child=>element.append(node(child)));
    return element;
  }
  const element = node(source); element.setAttribute('aria-hidden','true'); return element;
}
function hydrate(root=document) {
  root.querySelectorAll('[data-icon]').forEach(element=>element.replaceChildren(svg(element.dataset.icon)));
}
hydrate();
function asset(item, still=false) { return `../../../../public/space-avatars/${item.id}${still?'-still':''}.webp`; }
const playback = new IntersectionObserver(entries=>{
  for(const entry of entries) {
    const image=entry.target;
    image.src=asset({id:image.dataset.asset},!(entry.isIntersecting&&!document.hidden&&!prefersReduced()));
  }
},{root:content,threshold:.05});
const messagePlayback=new IntersectionObserver(entries=>{
  for(const {target,isIntersecting} of entries)target.src=asset({id:target.dataset.asset},!(isIntersecting&&!document.hidden&&!prefersReduced()));
},{root:$('.timeline'),threshold:.05});
function picture(item,animated=true) {
  const image=document.createElement('img'); image.alt=''; image.draggable=false;
  image.dataset.asset=item.id; image.src=asset(item,true);
  if(animated) playback.observe(image);
  return image;
}
function notify(message) {
  clearTimeout(toastTimer); $('#toast').textContent=message; $('#toast').hidden=false;
  toastTimer=setTimeout(()=>$('#toast').hidden=true,2600);
}
function pauseImages() {
  for(const image of document.querySelectorAll('img[data-asset]')) image.src=asset({id:image.dataset.asset},true);
}
function restoreImages() {
  for(const image of content.querySelectorAll('img[data-asset]')) { playback.unobserve(image); playback.observe(image); }
  for(const image of $('.timeline').querySelectorAll('img[data-asset]')) { messagePlayback.unobserve(image);messagePlayback.observe(image); }
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){finishMotion();pauseImages();}else restoreImages();});
reduced.addEventListener('change',()=>{finishMotion();pauseImages();restoreImages();});
$('#motion-mode').addEventListener('change',()=>{finishMotion();pauseImages();restoreImages();});
window.addEventListener('pagehide',finishMotion);
window.addEventListener('resize',finishMotion);

function clearDockStyles(element) {
  for(const key of ['position','top','bottom','left','right','width','height','transform'])element.style.removeProperty(key);
}
function finishMotion() {
  cancelAnimationFrame(motionFrame);motionFrame=0;
  for(const element of moving.keys()){element.style.removeProperty('transform');delete element.dataset.motionState;delete element.dataset.motionDuration;}
  moving.clear();
  for(const [element,kind] of [[panel,'emoji'],[tools,'tools']]){
    element.hidden=activePanel!==kind;clearDockStyles(element);
    element.inert=activePanel!==kind;
    if(element.inert)element.setAttribute('aria-hidden','true');else element.removeAttribute('aria-hidden');
  }
}
function layoutMotion(change,kind='expression') {
  const timeline=$('.timeline'),composer=$('.composer');
  const following=timeline.scrollHeight-timeline.clientHeight-timeline.scrollTop<4;
  const tracked=[composer,panel,tools,...timeline.querySelectorAll('.message,.date')];
  const previous=new Map(tracked.filter(e=>!e.hidden).map(e=>[e,{rect:e.getBoundingClientRect(),velocity:moving.get(e)?.velocity??0}]));
  cancelAnimationFrame(motionFrame);motionFrame=0;moving.clear();
  for(const element of tracked)element.style.removeProperty('transform');
  change(previous);
  if(following)timeline.scrollTop=timeline.scrollHeight;
  const bounds=screen.getBoundingClientRect();motionKind=kind;
  const duration=kind==='expression'?EXPRESSION_MS:PANEL_MS;
  for(const element of tracked) {
    if(element.hidden)continue;
    const current=element.getBoundingClientRect(),old=previous.get(element);
    const isPanel=element===panel||element===tools;
    const outgoing=isPanel&&((element===panel?'emoji':'tools')!==activePanel);
    let from=old?old.rect.top-current.top:0;
    if(isPanel&&!old)from=screen.dataset.mode==='desktop'?16:previous.get(composer).rect.bottom-current.top;
    const target=outgoing?bounds.bottom-current.top+1:0;
    if(Math.abs(from-target)<.1&&Math.abs(old?.velocity??0)<3)continue;
    moving.set(element,{from,target,velocity:old?.velocity??0,initialVelocity:old?.velocity??0});
    element.dataset.motionState=outgoing?'closing':'opening';element.dataset.motionDuration=String(duration);
    element.style.transform=`translateY(${from}px)`;
  }
  if(prefersReduced()||document.hidden||!moving.size){finishMotion();return;}
  motionStarted=performance.now();
  const tick=now=>{
    const elapsed=now-motionStarted;
    for(const [element,state] of moving){const sample=sampleTrajectory(state.from,state.target,state.initialVelocity,elapsed,motionKind);state.velocity=sample.velocity;element.style.transform=`translateY(${sample.value}px)`;}
    if(elapsed>=duration)finishMotion();else motionFrame=requestAnimationFrame(tick);
  };
  motionFrame=requestAnimationFrame(tick);
}

function expandedState(value) {
  expanded=value;panel.classList.toggle('is-expanded',value);
  panel.setAttribute('role',value?'dialog':'region');
  if(value)panel.setAttribute('aria-modal','true');else panel.removeAttribute('aria-modal');
  $('#expand').replaceChildren(svg(value?'Minimize2':'Maximize2'));
  $('#expand').setAttribute('aria-label',value?'恢复半屏表情':'展开表情');
  $('.chat-header').inert=value;$('.timeline').inert=value;$('.composer').inert=value;
}
function setExpanded(value) {
  if(activePanel!=='emoji'||expanded===value)return;
  layoutMotion(()=>expandedState(value),'expression');
  if(value)$('#expand').focus({preventScroll:true});
}
function setPanel(kind) {
  kind=kind??null;if(activePanel===kind)return;
  const previousKind=activePanel;
  const wasExpanded=expanded;
  layoutMotion(previous=>{
    activePanel=kind;if(kind!=='emoji'&&expanded)expandedState(false);
    for(const [element,type] of [[panel,'emoji'],[tools,'tools']]){
      const old=previous.get(element);clearDockStyles(element);
      element.hidden=kind!==type&&!old;element.inert=kind!==type;
      if(element.inert)element.setAttribute('aria-hidden','true');else element.removeAttribute('aria-hidden');
      if(kind!==type&&old){
        const desktop=screen.dataset.mode==='desktop';
        Object.assign(element.style,{position:'absolute',top:'auto',bottom:desktop?'68px':'0',left:desktop?'16px':'0',right:'auto',width:`${old.rect.width}px`,height:`${old.rect.height}px`});
      }
    }
  },kind==='emoji'||previousKind==='emoji'?'expression':'panel');
  $('#tools-toggle').setAttribute('aria-expanded',String(kind==='tools'));
  $('#emoji-toggle').setAttribute('aria-expanded',String(kind==='emoji'));
  $('#emoji-toggle').setAttribute('aria-label',kind==='emoji'?'切换到键盘':'打开表情');
  $('#emoji-toggle').replaceChildren(svg(kind==='emoji'?'Keyboard':'Smile'));
  if(kind==='emoji') {draft.blur();restoreImages();}
  else pauseImages();
  if(wasExpanded&&kind!=='emoji')$('#emoji-toggle').focus({preventScroll:true});
}
$('#tools-toggle').addEventListener('click',()=>{draft.blur();setPanel(activePanel==='tools'?null:'tools');});
$('#emoji-toggle').addEventListener('pointerdown',event=>event.preventDefault());
$('#emoji-toggle').addEventListener('click',()=>{
  if(activePanel!=='emoji')setPanel('emoji');else{setPanel(null);draft.focus({preventScroll:true});}
});
$('#show-emoji').addEventListener('click',()=>{catalog.hidden=true;setCatalogInert(false);setPanel('emoji');});
$('#show-tools').addEventListener('click',()=>{catalog.hidden=true;setCatalogInert(false);setPanel('tools');});
$('#expand').addEventListener('click',()=>setExpanded(!expanded));
$('#collapse').addEventListener('click',()=>{setPanel(null);$('#emoji-toggle').focus({preventScroll:true});});
draft.addEventListener('focus',()=>{if(activePanel)setPanel(null);});
for(const type of ['select','keyup','blur'])draft.addEventListener(type,()=>selection={start:draft.selectionStart,end:draft.selectionEnd});
function resizeDraft() {
  draft.style.height='44px';draft.style.height=`${Math.min(88,Math.max(44,draft.scrollHeight))}px`;
  $('#send').hidden=!draft.value.trim();
  selection={start:draft.selectionStart,end:draft.selectionEnd};
}
draft.addEventListener('input',resizeDraft);
function insertEmoji(emoji) {
  const start=Math.min(selection.start,draft.value.length),end=Math.min(selection.end,draft.value.length);
  const value=draft.value.slice(0,start)+emoji+draft.value.slice(end);
  if(value.length>4000){notify('消息最多 4,000 个字符');return;}
  draft.value=value;draft.setSelectionRange(start+emoji.length,start+emoji.length);resizeDraft();
}
function addMessage(text,item) {
  const row=document.createElement('div');row.className='message outgoing';
  const bubble=document.createElement('div');bubble.className=`bubble${item?' expression-message':''}`;
  if(item) {
    const image=picture(item,false);image.alt=item.label??item.emoji??'表情';bubble.append(image);messagePlayback.observe(image);
  }else bubble.append(document.createTextNode(text));
  const time=document.createElement('span');time.className='message-meta';time.textContent='17:45 ✓';bubble.append(time);row.append(bubble);$('.timeline').append(row);
  $('.timeline').scrollTop=$('.timeline').scrollHeight;
}
$('.composer').addEventListener('submit',event=>{event.preventDefault();if(!draft.value.trim())return;addMessage(draft.value);draft.value='';resizeDraft();});
draft.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('.composer').requestSubmit();}});

function stateBlock(title,icon,actionLabel,action) {
  const state=document.createElement('div');state.className='panel-state';state.append(svg(icon));
  const copy=document.createElement('p');copy.textContent=title;state.append(copy);
  if(actionLabel){const button=document.createElement('button');button.type='button';button.textContent=actionLabel;button.addEventListener('click',action);state.append(button);}
  return state;
}
function loadingGrid() {const grid=document.createElement('div');grid.className='skeleton-grid';grid.setAttribute('aria-label','正在加载表情');grid.setAttribute('role','status');for(let i=0;i<20;i++)grid.append(document.createElement('i'));return grid;}
function resetScenario(){scenario='normal';$('#scenario').value='normal';renderShortcuts();renderContent();renderCatalog();syncTools();}
function section(title,items,isSticker=false) {
  const element=document.createElement('section');const heading=document.createElement('h3');heading.textContent=title;element.append(heading);
  const grid=document.createElement('div');grid.className=isSticker?'sticker-grid':'emoji-grid';
  for(const item of items) {
    const button=document.createElement('button');button.type='button';
    button.setAttribute('aria-label',`${isSticker?'发送贴纸':'发送 Fluent 表情'}：${item.label??item.emoji}`);button.append(picture(item));
    button.addEventListener('pointerdown',event=>event.preventDefault());
    button.addEventListener('click',()=>{addMessage('',item);notify('已模拟发送，面板保持打开');});
    button.addEventListener('contextmenu',event=>{event.preventDefault();favoriteIds.add(item.id);notify('已加入表情收藏（原型）');});grid.append(button);
  }
  element.append(grid);return element;
}
function renderContent() {
  playback.disconnect();content.replaceChildren();
  if(scenario==='loading'){content.append(loadingGrid());return;}
  if(scenario==='error'){content.append(stateBlock('表情暂时加载失败','CloudOff','重试',resetScenario));return;}
  if(active==='emoji') {
    content.append(section('Fluent',fluent));
    for(const [title,emoji] of [['表情与情感','😀 😃 😄 😁 😆 😅 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 🤗 🤔 🫠 🥹'],['动物与自然','🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🌱 🌿 🍃 🌼 🌞 🌙 ⭐ 🌈'],['食物与饮料','🍎 🍐 🍊 🍋 🍓 🍒 🍑 🥑 ☕ 🍵 🥐 🍞 🍰 🧁']]) {
      const s=document.createElement('section'),h=document.createElement('h3'),grid=document.createElement('div');h.textContent=title;grid.className='emoji-grid';
      for(const value of emoji.split(' ')){const b=document.createElement('button');b.type='button';b.textContent=value;b.setAttribute('aria-label',`插入 ${value}`);b.addEventListener('pointerdown',event=>event.preventDefault());b.addEventListener('click',()=>insertEmoji(value));grid.append(b);}
      s.append(h,grid);content.append(s);
    }
  } else {
    const ids=scenario==='empty'?[]:installed;
    if(!ids.length){content.append(stateBlock('还没有添加贴纸','Sticker','添加贴纸',openCatalog));return;}
    for(const id of ids) {const pack=packs.find(p=>p.id===id);const s=section(pack.title,pack.items,true);s.dataset.pack=id;content.append(s);}
    if(active!=='stickers')requestAnimationFrame(()=>{const target=content.querySelector(`[data-pack="${active}"]`);if(target)content.scrollTop=target.offsetTop-content.offsetTop;});
  }
}
function renderShortcuts() {
  const rail=$('#pack-shortcuts');rail.replaceChildren();
  for(const id of scenario==='empty'?[]:installed) {
    const pack=packs.find(p=>p.id===id),button=document.createElement('button');button.type='button';button.className='icon-button';button.dataset.pack=id;
    button.setAttribute('aria-label',`${pack.title}，长按拖动或 Alt 加左右方向键排序`);button.setAttribute('aria-keyshortcuts','Alt+ArrowLeft Alt+ArrowRight');button.setAttribute('aria-pressed',String(active===id));button.append(picture(pack.items[0],false));
    button.addEventListener('click',()=>{if(button.dataset.dragged){delete button.dataset.dragged;return;}active=id;renderShortcuts();renderContent();});
    button.addEventListener('keydown',event=>{if(event.altKey&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();reorder(id,event.key==='ArrowLeft'?-1:1);rail.querySelector(`[data-pack="${id}"]`)?.focus();}});
    let hold,dragging=false;
    button.addEventListener('pointerdown',event=>{hold=setTimeout(()=>{dragging=true;button.setPointerCapture(event.pointerId);button.style.background='var(--accent-soft)';},500);});
    button.addEventListener('pointermove',event=>{if(!dragging)return;const hit=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-pack]');if(hit&&hit!==button&&rail.contains(hit)){const from=installed.indexOf(id),to=installed.indexOf(hit.dataset.pack);installed.splice(from,1);installed.splice(to,0,id);rail.insertBefore(button,to>from?hit.nextSibling:hit);button.dataset.dragged='true';}});
    const stop=()=>{clearTimeout(hold);if(dragging){dragging=false;button.style.background='';if(button.dataset.dragged)notify('已调整本次原型的合集顺序');}};
    button.addEventListener('pointerup',stop);button.addEventListener('pointercancel',()=>{stop();renderShortcuts();});rail.append(button);
  }
  $('[data-action="emoji"]').setAttribute('aria-pressed',String(active==='emoji'));
}
function reorder(id,delta){const i=installed.indexOf(id),j=i+delta;if(j<0||j>=installed.length)return;[installed[i],installed[j]]=[installed[j],installed[i]];renderShortcuts();notify('已调整本次原型的合集顺序');}
$('[data-action="emoji"]').addEventListener('click',()=>{active='emoji';renderShortcuts();renderContent();});
$('[data-action="catalog"]').addEventListener('click',openCatalog);

function setCatalogInert(value) {
  $('.chat-header').inert=value||expanded;$('.timeline').inert=value||expanded;$('.composer').inert=value||expanded;
  panel.inert=value;tools.inert=value;
}
function openCatalog() {finishMotion();pickerFocus=document.activeElement;catalogDetail=null;favoritesView=false;catalogMore=false;catalog.hidden=false;setCatalogInert(true);renderCatalog();$('#catalog-back').focus({preventScroll:true});pauseImages();}
function closeCatalog(){catalog.hidden=true;setCatalogInert(false);restoreImages();if(pickerFocus?.isConnected)pickerFocus.focus({preventScroll:true});}
$('#catalog-back').addEventListener('click',()=>{if(catalogDetail||favoritesView){catalogDetail=null;favoritesView=false;renderCatalog();}else closeCatalog();});
$('#catalog-close').addEventListener('click',closeCatalog);
$('#expression-favorites').addEventListener('click',()=>{favoritesView=!favoritesView;catalogDetail=null;renderCatalog();});
function togglePack(pack) {
  if(uploadTimers.has(pack.id)){clearTimeout(uploadTimers.get(pack.id));uploadTimers.delete(pack.id);renderCatalog();return;}
  if(installed.includes(pack.id)){installed=installed.filter(id=>id!==pack.id);if(active===pack.id)active='emoji';renderCatalog();renderShortcuts();renderContent();return;}
  uploadTimers.set(pack.id,setTimeout(()=>{uploadTimers.delete(pack.id);installed.push(pack.id);renderCatalog();renderShortcuts();renderContent();notify('已添加到本次原型');},900));renderCatalog();
}
function installButton(pack) {
  const b=document.createElement('button');b.type='button';b.className='text-action';const has=installed.includes(pack.id),pending=uploadTimers.has(pack.id);
  b.textContent=pending?'取消':has?'移除':'添加';b.dataset.installed=String(has);b.setAttribute('aria-label',`${pending?'取消下载':has?'移除':'添加'} ${pack.title}`);b.addEventListener('click',()=>togglePack(pack));return b;
}
function renderCatalog() {
  catalogContent.replaceChildren();$('.page-header h2').textContent=favoritesView?'表情收藏':catalogDetail?.title??'添加贴纸';
  $('#expression-favorites').setAttribute('aria-pressed',String(favoritesView));
  if(favoritesView){const items=[...fluent,...samples].filter(i=>favoriteIds.has(i.id));catalogContent.append(items.length?section('已收藏',items,true):stateBlock('还没有收藏的表情','Star',null));return;}
  if(scenario==='loading'){catalogContent.append(loadingGrid());return;}
  if(scenario==='error'){catalogContent.append(stateBlock('贴纸目录暂时加载失败','CloudOff','重试',resetScenario));return;}
  if(catalogDetail){const heading=document.createElement('div');heading.className='detail-heading';heading.append(picture(catalogDetail.items[0],false));const copy=document.createElement('div'),h=document.createElement('h3'),p=document.createElement('p');h.textContent=catalogDetail.title;p.textContent=catalogDetail.description;copy.append(h,p);heading.append(copy,installButton(catalogDetail));catalogContent.append(heading,section('合集预览',catalogDetail.items,true));return;}
  for(const pack of packs.slice(0,catalogMore?4:3)) {
    const row=document.createElement('div');row.className='catalog-row';const cover=document.createElement('button');cover.type='button';cover.className='catalog-cover';cover.setAttribute('aria-label',`查看 ${pack.title}`);cover.append(picture(pack.items[0],false));cover.addEventListener('click',()=>{catalogDetail=pack;renderCatalog();});
    const copy=document.createElement('div');copy.className='catalog-copy';const h=document.createElement('h3'),p=document.createElement('p');h.textContent=pack.title;p.textContent=uploadTimers.has(pack.id)?'正在下载 · 模拟进度':pack.description;copy.append(h,p);row.append(cover,copy,installButton(pack));catalogContent.append(row);
  }
  if(!catalogMore){const more=document.createElement('button');more.type='button';more.className='text-action';more.textContent='加载更多';more.addEventListener('click',()=>{catalogMore=true;renderCatalog();});catalogContent.append(more);}
}

function syncTools(){const unavailable=scenario==='restricted';for(const b of tools.querySelectorAll('[data-tool]'))if(['视频通话','实时语音'].includes(b.dataset.tool))b.disabled=unavailable;$('#call-note').hidden=!unavailable;}
for(const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click',()=>{
  selectedTool=b.dataset.tool;$('#tool-title').textContent=selectedTool;
  const explanations={图片:'正式产品直接打开系统图片／视频选择器。原型仅模拟选择和取消，不读取本机文件。',拍摄:'正式产品直接调用系统拍摄入口。原型不请求相机权限。',文件:'正式产品直接打开系统文件选择器。原型不读取或上传文件。',视频通话:'原型仅展示通话入口和可用性状态，不建立真实通话。',实时语音:'原型仅展示通话入口和可用性状态，不请求麦克风权限。',收藏:'原型展示空收藏。正式产品保留现有相册／文件分类与本机收藏行为。'};
  $('#tool-description').textContent=explanations[selectedTool];$('#tool-confirm').hidden=selectedTool==='收藏';$('#tool-dialog').showModal();
});
$('#tool-cancel').addEventListener('click',()=>$('#tool-dialog').close());
$('#tool-confirm').addEventListener('click',()=>{$('#tool-dialog').close();notify(`已模拟${selectedTool}操作，工具面板保持打开`);});
for(const b of document.querySelectorAll('[data-demo]'))b.addEventListener('click',()=>notify(b.dataset.demo));
document.addEventListener('keydown',event=>{
  if(event.key==='Tab'&&(!catalog.hidden||expanded)) {
    const root=catalog.hidden?panel:catalog;
    const focusable=[...root.querySelectorAll('button:not(:disabled)')].filter(e=>e.getClientRects().length);
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    return;
  }
  if(event.key!=='Escape'||$('#tool-dialog').open)return;
  if(!catalog.hidden){event.preventDefault();closeCatalog();}
  else if(expanded){event.preventDefault();setExpanded(false);}
  else if(activePanel){event.preventDefault();const target=activePanel==='tools'?$('#tools-toggle'):$('#emoji-toggle');setPanel(null);target.focus({preventScroll:true});}
});
document.addEventListener('pointerdown',event=>{if(activePanel==='tools'&&!event.target.closest('#tools-panel,#tools-toggle,.preview-controls,dialog'))setPanel(null);});
$('#palette').addEventListener('change',event=>document.documentElement.dataset.theme=event.target.value);
function applyScheme(){const value=$('#brightness').value;document.documentElement.dataset.colorScheme=value==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):value;}
$('#brightness').addEventListener('change',applyScheme);matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>{if($('#brightness').value==='system')applyScheme();});
$('#viewport').addEventListener('change',event=>{finishMotion();const timeline=$('.timeline'),following=timeline.scrollHeight-timeline.clientHeight-timeline.scrollTop<4;const v=event.target.value;screen.dataset.mode=v==='desktop'?'desktop':'mobile';screen.dataset.short=String(v==='short');screen.style.width=v==='desktop'?'100%':`min(${v==='short'?390:v}px,100%)`;if(following)requestAnimationFrame(()=>timeline.scrollTop=timeline.scrollHeight);});
$('#scenario').addEventListener('change',event=>{scenario=event.target.value;if(scenario==='empty')active='stickers';renderShortcuts();renderContent();renderCatalog();syncTools();});
renderShortcuts();renderContent();syncTools();resizeDraft();requestAnimationFrame(()=>$('.timeline').scrollTop=$('.timeline').scrollHeight);
