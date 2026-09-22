const $ = s => document.querySelector(s);
const app = $('#app');
const params = new URLSearchParams(location.search);
if(params.has('live')) document.documentElement.classList.add('live');
const paths = {
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  back:'<path d="m14 5-7 7 7 7"/>',
  next:'<path d="m9 5 7 7-7 7"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  spaces:'<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M9 4v16"/>',
  heart:'<path d="M12 20 3.8 12A5.2 5.2 0 0 1 12 5.7 5.2 5.2 0 0 1 20.2 12Z"/>',
  edit:'<path d="m14.5 4.5 5 5M4 20l5-1L20 8a2.5 2.5 0 0 0-5-5L4 14Z"/>',
  gear:'<path d="m9 3-.7 2.2-2 .9-2.1-.5-2 3.4 1.5 1.8v2.4L2.2 15l2 3.4 2.1-.5 2 .9L9 21h4l.7-2.2 2-.9 2.1.5 2-3.4-1.5-1.8v-2.4l1.5-1.8-2-3.4-2.1.5-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/>',
  device:'<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10 18h4"/>',
  key:'<circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9 9M16 16l3-3M18.5 18.5l3-3"/>',
  upload:'<path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M12 16V3m-5 5 5-5 5 5"/>',
  download:'<path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4M12 3v12m-5-5 5 5 5-5"/>',
  recover:'<rect x="3" y="3" width="13" height="13" rx="3"/><rect x="8" y="8" width="13" height="13" rx="3"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.4 9a2.6 2.6 0 1 1 4.3 2c-1 .7-1.7 1-1.7 3M12 17h.01"/>',
  cover:'<path d="M3 3l18 18M10.5 5.2A10 10 0 0 1 21 12a14 14 0 0 1-3 4M6.5 6.5A15 15 0 0 0 3 12c4 8 12 8 16 3M10 10a3 3 0 0 0 4 4"/>',
  history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"/>',
};
function icon(name, cls=''){return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${name==='gear'?'<g transform="translate(1 0)">'+paths.gear+'</g>':paths[name]||paths.help}</svg>`;}
const round = (name, action, label, cls='') => `<button class="round ${cls}" data-action="${action}" aria-label="${label}">${icon(name)}</button>`;
const escape = s => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let rooms=[
  {name:'日常',pending:false,preview:'好，老地方见。',unread:0},
  {name:'周末计划',pending:false,preview:'周六去海边，还是去山里走走？',unread:3},
  {name:'沿途风景',pending:false,preview:'[图片]',unread:12},
  {name:'一起看的',pending:false,preview:'[视频]',unread:0},
  {name:'快乐收藏',pending:false,preview:'[表情]',unread:105},
  {name:'小小宇宙',pending:true,preview:'',unread:0}
];
let presenceStyle='heart';
let current=params.get('scene')==='invite'?5:0, scene=params.get('scene')||'list', edit=1, listScroll=0;
const labels={list:'空间列表',menu:'长按菜单',rename:'修改名称',invite:'邀请半屏弹窗',settings:'设置',chat:'聊天与心动按钮',style:'在线状态样式',detail:'设置入口'};
function chat(){return `<section class="chat"><header class="chat-head"><button class="space-entry" data-action="list" aria-label="打开私密空间列表，当前空间：${escape(rooms[current].name)}">${icon('spaces')}<span>${escape(rooms[current].name)}</span></button>${presenceStyle==='heart'?round('heart','heart','心动按钮：双方在线','heart'):'<button class="presence-capsule" data-action="heart" aria-label="在线胶囊：双方在线"><span>TA</span>'+icon('heart')+'<span>我</span></button><span class="header-spacer" aria-hidden="true"></span>'}</header><div class="messages"><div class="date">今天</div><div class="bubble">今天的风很舒服。<small>16:08</small></div><div class="bubble out">等会儿一起走走？<small>16:09 ✓✓</small></div><div class="bubble">好，老地方见。<small>16:10</small></div></div><footer class="composer"><div class="composer-field">说点什么…</div>${round('plus','demo','聊天工具')}</footer></section>`;}
function header(title,back=false){return `<header class="drawer-head">${back?round('back','list','返回空间列表','back'):''}<h2>${title}</h2>${round('close','chat','关闭抽屉')}</header>`;}
function row(r,i){const preview=r.pending?'等待对方加入':r.preview||'还没有消息';const unread=r.unread||0;return `<button class="space ${scene==='menu'&&i===edit?'context':''}" data-room="${i}" aria-current="false" aria-label="${escape(r.name)}，${escape(preview)}${unread?'，'+unread+'条未读':''}"><span class="copy"><strong>${escape(r.name)}</strong><small class="message-preview ${r.pending?'pending':''}">${escape(preview)}</small></span><span class="space-trailing">${unread?`<span class="unread-badge" aria-hidden="true">${unread>99?'99+':unread}</span>`:icon('next','chevron')}</span></button>`;}

function drawer(){const active=rooms[current];return `<div class="overlay" data-action="chat"></div><section class="drawer space-index" role="dialog" aria-modal="true" aria-label="私密空间">${header('私密空间')}<div class="rows"><button class="current-space ${scene==='menu'&&edit===current?'context':''}" data-room="${current}" aria-current="true" aria-label="${escape(active.name)}"><span class="current-eyebrow">当前空间</span><span class="current-name"><strong>${escape(active.name)}</strong><span class="current-tick">${icon('check')}</span></span>${active.pending?'<small class="current-pending">等待对方加入</small>':''}</button><div class="other-heading"><span>其他空间</span><span>${rooms.length-1}</span></div><div class="other-spaces">${rooms.map((r,i)=>i===current?'':row(r,i)).join('')}</div></div><footer class="drawer-foot"><button class="create" data-action="create">${icon('plus')}<span>创建新空间</span></button><button class="settings-entry" data-action="settings" aria-label="设置">${icon('gear')}</button></footer></section>`;}

const settingGroups=[['当前空间',[['device','设备管理'],['upload','备份数据'],['download','恢复数据']]],['本机',[['key','我的恢复码'],['recover','恢复其他空间'],['cover','体验或开启遮蔽']]],['关于',[['history','更新日志']]]];
function setting(name,label,action='detail'){return `<button class="setting" data-action="${action}" data-label="${label}"><span class="icon-slot">${icon(name)}</span><span class="text">${label}${action==='style'?'<small>'+ (presenceStyle==='heart'?'心动按钮':'在线胶囊')+'</small>':''}</span>${icon('next','chevron')}</button>`;}
function settings(){return `<div class="overlay" data-action="chat"></div><section class="drawer" role="dialog" aria-modal="true" aria-label="设置">${header('设置',true)}<div class="settings-scroll">${setting('heart','在线状态样式','style')}${settingGroups.map(([title,rows])=>`<div class="group-label">${title}</div>${rows.map(([n,l])=>setting(n,l)).join('')}`).join('')}</div></section>`;}
function stylePage(){return `<div class="overlay" data-action="chat"></div><section class="drawer style-drawer" role="dialog" aria-modal="true" aria-label="在线状态样式"><header class="drawer-head">${round('back','settings','返回设置','back')}<h2>在线状态样式</h2>${round('close','chat','关闭设置')}</header><div class="style-content"><p class="style-intro">选择聊天页顶部的显示方式。</p><div class="presence-options" role="radiogroup" aria-label="在线状态样式">${['capsule','heart'].map(style=>`<button class="presence-option ${style===presenceStyle?'is-chosen':''}" role="radio" aria-checked="${style===presenceStyle}" data-action="choose-${style}"><span class="option-preview">${style==='capsule'?'<span class="presence-capsule"><span>TA</span>'+icon('heart')+'<span>我</span></span>':'<span class="round heart">'+icon('heart')+'</span>'}</span><span class="option-copy"><strong>${style==='capsule'?'在线胶囊':'心动按钮'}</strong><small>${style==='capsule'?'显示双方的在线状态':'在聊天页右上角显示'}</small></span><span class="radio-mark">${style===presenceStyle?icon('check'):''}</span></button>`).join('')}</div><div class="presence-note"><p>左半代表对方，右半代表自己。</p><p>在线时，对应半边爱心亮起。</p><p>此设置只影响本机显示。</p></div></div><footer class="style-footer"><button class="primary" data-action="chat">查看聊天效果</button></footer></section>`;}
function modal(){return `<div class="modal-shade"><form class="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title"><h2 id="rename-title">编辑空间名称</h2><input id="name" aria-label="空间名称" value="${escape(rooms[edit].name)}" maxlength="40" autocomplete="off" enterkeyhint="done"><p class="hint">仅修改你这边的名称，对方的名称不变。</p><p class="error" role="alert"></p><div class="modal-actions"><button type="button" data-action="cancel">取消</button><button class="primary" type="submit">保存</button></div></form></div>`;}
function invite(){return `<div class="sheet-shade" data-action="list"></div><section class="invite-sheet" role="dialog" aria-modal="true" aria-labelledby="invite-title"><div class="sheet-drag" aria-hidden="true"><span></span></div><header class="sheet-head"><span class="sheet-kicker">${escape(rooms[current].name)}</span>${round('close','list','关闭邀请')}</header><div class="sheet-body"><h1 id="invite-title">邀请对方加入</h1><p>分享邀请链接，<br>让对方来到这个空间。</p><div class="sheet-state"><span class="dot"></span>等待对方加入</div></div><footer class="sheet-actions"><button class="primary" data-action="copy">${icon('recover')}<span>复制邀请链接</span></button><p>关闭后，可从空间列表再次打开邀请。</p></footer></section>`;}

function render(focus=false){
  $('#state-title').textContent=labels[scene]||scene;
  document.querySelectorAll('[data-scene]').forEach(b=>b.setAttribute('aria-current',b.dataset.scene===scene));
  app.innerHTML=chat()+(scene==='settings'?settings():scene==='style'?stylePage():['list','menu','rename','invite'].includes(scene)?drawer():'');
  if(scene==='invite'){
    app.querySelector('.drawer').inert=true;
    app.insertAdjacentHTML('beforeend',invite());
    app.querySelector('.invite-sheet').addEventListener('keydown',trap);
    const handle=app.querySelector('.sheet-drag');let startY;
    handle.addEventListener('pointerdown',e=>{startY=e.clientY;handle.setPointerCapture(e.pointerId);});
    handle.addEventListener('pointerup',e=>{if(startY!==undefined&&e.clientY-startY>45)go('list');startY=undefined;});
    handle.addEventListener('pointercancel',()=>startY=undefined);
  }
  if($('.rows')) $('.rows').scrollTop=listScroll;
  if(scene==='menu'){
    const target=app.querySelector(`[data-room="${edit}"]`).getBoundingClientRect(), host=app.getBoundingClientRect();
    const left=Math.max(12,Math.min(target.left-host.left+12,host.width-242));
    const top=Math.max(8,Math.min(target.bottom-host.top-6,host.height-68));
    app.insertAdjacentHTML('beforeend',`<div class="menu" role="menu" style="left:${left}px;top:${top}px"><button role="menuitem" data-action="rename">${icon('edit')}编辑空间名称</button></div>`);
  }
  if(scene==='rename'){
    app.querySelector('.drawer').inert=true;
    app.insertAdjacentHTML('beforeend',modal());
    app.querySelector('form').addEventListener('submit',save);
    if(focus) {$('#name').focus({preventScroll:true});$('#name').setSelectionRange($('#name').value.length,$('#name').value.length);}
  }
  if(['settings','list','style'].includes(scene)) app.querySelector('.drawer')?.addEventListener('keydown',trap);
  app.querySelector('.modal')?.addEventListener('keydown',trap);
}
function trap(e){if(e.key!=='Tab')return;const items=[...e.currentTarget.querySelectorAll('button,input')];const a=items[0],b=items.at(-1);if(e.shiftKey&&document.activeElement===a){e.preventDefault();b.focus();}else if(!e.shiftKey&&document.activeElement===b){e.preventDefault();a.focus();}}
function toast(t){const el=$('.toast');el.textContent=t;el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.hidden=true,2200);}
function go(s,focus=false){if($('.rows'))listScroll=$('.rows').scrollTop;scene=s;render(focus);}
function save(e){e.preventDefault();const value=$('#name').value.trim();if(!value){$('.error').textContent='请输入空间名称';$('#name').focus();return;}rooms[edit].name=value;$('#name').blur();go('list');toast('空间名称已更新');}
app.addEventListener('click',e=>{
  const row=e.target.closest('[data-room]');
  if(row){if(longPressed){longPressed=false;return;}current=Number(row.dataset.room);go(rooms[current].pending?'invite':'chat');return;}
  const button=e.target.closest('[data-action]');if(!button){if(scene==='menu')go('list');return;}
  const action=button.dataset.action;
  if(action==='rename'){go('rename',true);return;}
  if(action==='cancel'){go('list');return;}
  if(action==='create'){rooms.push({name:'新的空间',pending:true});current=rooms.length-1;go('invite');return;}
  if(action==='copy'){button.innerHTML=icon('check')+'<span>已复制邀请链接</span>';toast('演示：邀请链接已复制');return;}
  if(action==='heart'){toast('左侧代表对方，右侧代表自己');return;}
  if(action==='style'){go('style');return;}
  if(action==='choose-heart'||action==='choose-capsule'){presenceStyle=action==='choose-heart'?'heart':'capsule';go('style');app.querySelector(`[data-action="${action}"]`).focus({preventScroll:true});return;}
  if(action==='detail'){toast(`${button.dataset.label}：沿用现有功能`);return;}
  if(action==='demo'){toast('此处保留现有聊天工具');return;}
  go(action);
});
let timer,longPressed=false,pressPoint;
function stop(){clearTimeout(timer);}
app.addEventListener('pointerdown',e=>{const row=e.target.closest('[data-room]');if(!row||e.button!==0)return;longPressed=false;pressPoint=[e.clientX,e.clientY];timer=setTimeout(()=>{edit=Number(row.dataset.room);longPressed=true;go('menu');},550);});
app.addEventListener('pointermove',e=>{if(pressPoint&&Math.hypot(e.clientX-pressPoint[0],e.clientY-pressPoint[1])>10)stop();});
['pointerup','pointercancel'].forEach(event=>app.addEventListener(event,stop));
app.addEventListener('contextmenu',e=>{const row=e.target.closest('[data-room]');if(!row)return;e.preventDefault();stop();edit=Number(row.dataset.room);go('menu');});
app.addEventListener('keydown',e=>{if(scene==='style'&&e.target.matches('[role=radio]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();presenceStyle=e.key==='Home'?'capsule':e.key==='End'?'heart':presenceStyle==='heart'?'capsule':'heart';go('style');app.querySelector('[aria-checked=true]').focus({preventScroll:true});return;}if(e.key==='Escape'){go(scene==='style'?'settings':['rename','menu','invite'].includes(scene)?'list':'chat');}if(e.key==='F2'&&e.target.closest('[data-room]')){e.preventDefault();edit=Number(e.target.closest('[data-room]').dataset.room);go('menu');}});
document.querySelectorAll('[data-scene]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.scene,b.dataset.scene==='rename')));
$('#height').addEventListener('input',e=>{$('#viewport').style.height=e.target.value+'px';$('#height-label').textContent=e.target.value+' px';$('#measure').textContent='393 × '+e.target.value+' CSS px';});
function viewport(){const v=window.visualViewport;document.documentElement.style.setProperty('--vv-height',`${v?v.height:innerHeight}px`);document.documentElement.style.setProperty('--vv-top',`${v?v.offsetTop:0}px`);}
window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);window.addEventListener('resize',viewport);viewport();render(scene==='rename');
