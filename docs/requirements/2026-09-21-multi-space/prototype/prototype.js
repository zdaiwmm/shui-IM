const app = document.querySelector('#app');
const phone = document.querySelector('#phone');
const toastNode = document.querySelector('#toast');
const viewTitle = document.querySelector('#view-title');
document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const icons = {
  layers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></svg>',
  heart: '<svg class="heart-shape" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.2 3.5 12.8C-1.6 7.7 5.7 1 12 7.1 18.3 1 23.4 6.7c2.8 3.2.7 5.7-2.9 9.3Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.9 2h4.2l.7 2.4 1.7.9 2.4-.7 2.1 3.6-1.7 1.8v2l1.7 1.8-2.1 3.6-2.4-.7-1.7.9-.7 2.4H9.9l-.7-2.4-1.7-.9-2.4.7L3 13.8 4.7 12v-2L3 8.2l2.1-3.6 2.4.7 1.7-.9L9.9 2Z"/><circle cx="12" cy="11" r="3"/></svg>',
};
const seedRooms = () => [
  { id: 'a', name: '晚风', pending: false },
  { id: 'b', name: '周末小屋', pending: false },
  { id: 'c', name: '新的空间', pending: true },
];
const state = {
  rooms: seedRooms(), current: 'a', scene: 'chat', drawer: null,
  style: 'capsule', selfOnline: true, peerOnline: false,
  contextId: null, modal: null, editValue: '', returnRoom: 'a',
  nextId: 4, recovering: null, locked: false, pulse: null, createSource: 'drawer', listScroll: 0,
};
const safe = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const currentRoom = () => state.rooms.find(room => room.id === state.current);
const roomName = () => currentRoom()?.name ?? '私密空间';

function toast(message) {
  toastNode.textContent = message;
  toastNode.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastNode.hidden = true; }, 2600);
}
function button(text, action, className = 'primary') {
  return `<button class="${className}" type="button" data-action="${action}">${text}</button>`;
}
function heartMarkup() {
  const { selfOnline, peerOnline, pulse } = state;
  const both = selfOnline && peerOnline;
  return `<button class="round heart ${both ? 'both' : 'split'} ${pulse ? `pulse ${pulse}` : ''}" type="button" data-action="heart-help" aria-label="在线状态：${selfOnline ? '自己在线' : '自己离线'}，${peerOnline ? '对方在线' : '对方离线'}">
    ${both ? icons.heart : `<span class="half left ${peerOnline ? 'on' : ''}">${icons.heart}</span><span class="half right ${selfOnline ? 'on' : ''}">${icons.heart}</span>`}</button>`;
}
function chat() {
  return `<section class="chat"><header class="chat-header">
    <button class="round" type="button" data-action="drawer" aria-label="打开私密空间列表">${icons.layers}</button>
    ${state.style === 'capsule' ? `<div class="capsule" role="status"><span>TA · ♥ · 我</span><small>${state.peerOnline ? '双方在线' : state.selfOnline ? '我在线' : '离线'}</small></div>` : `<div class="space-title">${safe(roomName())}</div>`}
    ${state.style === 'heart' ? heartMarkup() : '<span></span>'}
  </header><div class="messages">
    <div class="bubble in">今天路上的风景很好看。<small>15:17</small></div>
    <div class="bubble out">照片收到了，等会儿一起看。<small>15:17 ✓✓</small></div>
    <div class="bubble in">好呀，我刚到家。<small>15:18</small></div>
  </div><div class="composer"><button class="round" type="button" data-action="composer-help" aria-label="更多功能">+</button><div class="input">输入消息</div><button class="round" type="button" data-action="send" aria-label="模拟发送消息">♩</button></div></section>`;
}
function roomList() {
  return `<div class="space-list" role="list" aria-label="本机空间">
  ${state.rooms.map(room => `<button type="button" class="space-row ${room.id === state.current ? 'selected' : ''}" data-room="${safe(room.id)}" aria-label="切换到${safe(room.name)}，长按可编辑名称"><span><strong>${safe(room.name)}</strong>${room.pending ? '<small>等待对方加入</small>' : ''}</span>${room.id === state.current ? '<span class="check" aria-hidden="true">✓</span>' : ''}</button>`).join('')}
  </div>`;
}
function settings() {
  const row = (text, action, symbol = '›', extra = '') => `<button type="button" class="setting-row" data-action="${action}"><span class="row-icon">${symbol}</span>${text}<span>${extra || '›'}</span></button>`;
  return `<div class="drawer-settings">
    <div class="setting-group"><p>当前空间</p>${row('设备管理','devices','◇')}${row('备份数据','backup','↓')}${row('恢复数据','history','↺')}</div>
    <div class="setting-group"><p>本机设置</p>${row('我的恢复码','my-code','⚿')}${row('在线样式','style','♡',state.style === 'heart' ? '爱心按钮 ›' : '默认胶囊 ›')}${row('体验或开启遮蔽','cover','◈')}</div>
    <div class="setting-group"><p>关于</p>${row('功能说明','help','ⓘ')}${row('更新日志','updates','▤')}</div>
  </div>`;
}
function drawer() {
  if (!state.drawer) return '';
  const second = state.drawer === 'settings';
  return `<div class="scrim" data-action="close-drawer"></div><aside class="drawer" aria-label="${second ? '设置' : '私密空间列表'}">
    <header class="drawer-head">${second ? '<button class="drawer-back" type="button" data-action="drawer-home">‹ 设置</button>' : '<h2>私密空间</h2>'}<button class="round" type="button" data-action="close-drawer" aria-label="关闭抽屉">×</button></header>
    ${second ? settings() : roomList()}
    ${second ? '' : `<footer class="drawer-foot"><button class="footer-action create" type="button" data-action="create-start"><span class="lead">＋</span>创建新空间</button><button class="footer-action settings" type="button" data-action="drawer-settings"><span class="gear">${icons.gear}</span>设置<span class="end">›</span></button></footer>`}
  </aside>${state.contextId ? contextMenu() : ''}`;
}
function contextMenu() {
  const room = state.rooms.find(item => item.id === state.contextId);
  if (!room) return '';
  return `<div class="menu" style="left:62px;top:${Math.min(170 + state.rooms.indexOf(room) * 78, 520)}px" role="menu"><button type="button" data-action="rename-start" role="menuitem">编辑空间名称</button></div>`;
}
function modal() {
  if (!state.modal) return '';
  return `<div class="dialog-shade"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title">修改空间名称</h2><input id="room-name" maxlength="24" value="${safe(state.editValue)}" aria-label="空间名称"><p>仅自己可见，不影响对方。</p><div class="dialog-actions"><button type="button" data-action="rename-cancel">取消</button><button class="confirm" type="button" data-action="rename-save">保存</button></div></section></div>`;
}
function page(title, copy, action, actionText, backAction, extra = '') {
  return `<section class="page"><header class="page-top"><button type="button" data-action="${backAction}" aria-label="返回">‹</button></header><div class="page-main"><div class="page-mark" aria-hidden="true">♡</div><h1>${title}</h1><p>${copy}</p>${extra}</div><footer class="page-actions">${button(actionText, action)}${button('返回', backAction, 'secondary')}</footer></section>`;
}
function createPage() {
  const secondary = state.createSource === 'lost'
    ? button('恢复私密空间', 'lost-recover', 'secondary')
    : button('返回', 'create-back', 'secondary');
  return `<section class="page"><div class="page-main"><div class="page-mark">♡</div><h1>有些话，只留给彼此。</h1><p>一个只属于两个人的私密空间。</p></div><footer class="page-actions">${button('创建私密空间','create-confirm')}${secondary}</footer></section>`;
}
function invitePage() {
  return `<section class="page"><header class="page-top"><button type="button" data-action="invite-back" aria-label="返回">‹</button></header><div class="page-main"><div class="page-mark">♡</div><h1>邀请重要的那个人</h1><p>让对方打开邀请链接，加入你刚创建的空间。</p><div class="invite-box"><p>${safe(roomName())}</p><small>模拟邀请链接，不包含真实密钥</small></div><p>等待对方加入</p></div><footer class="page-actions">${button('复制邀请链接','copy-invite')}${button('返回空间列表','invite-back','secondary')}</footer></section>`;
}
function stylePage() {
  return `<section class="page"><header class="page-top"><button type="button" data-action="style-back" aria-label="返回设置">‹</button><strong>在线样式</strong></header><div class="page-main" style="justify-content:flex-start;padding-top:36px"><button type="button" class="style-row ${state.style === 'capsule' ? 'selected' : ''}" data-action="style-capsule"><span><strong>默认胶囊</strong><small>聊天顶部展示双方在线状态</small></span><span>TA · ♥ · 我</span></button><button type="button" class="style-row ${state.style === 'heart' ? 'selected' : ''}" data-action="style-heart"><span><strong>爱心按钮</strong><small>显示在聊天页右上角</small></span><span class="preview-heart">♥</span></button><p class="hint">仅影响本机显示。自己在右侧，对方在左侧；消息电流按发送者的方向触发。</p></div></section>`;
}
function joinPage() {
  return page('有人为你留了一个私密空间','这份邀请指向另一个空间。加入后，原有空间和历史仍保留。','join-confirm','加入这个空间','join-back','<div class="invite-box">邀请目标：雨后花园</div>');
}
function lostPage() {
  return `<section class="page"><div class="page-main"><div class="page-mark">♡</div><h1>有些话，只留给彼此。</h1><p>一个只属于两个人的私密空间。</p></div><footer class="page-actions">${button('创建私密空间','lost-create')}${button('恢复私密空间','lost-recover','secondary')}</footer></section>`;
}
function recoveryPage() {
  return `<section class="page"><header class="page-top"><button type="button" data-action="lost-back" aria-label="返回">‹</button></header><div class="page-main" style="justify-content:flex-start;padding-top:32px"><h1>恢复私密空间</h1><p>输入你保存的总恢复码，找回已备份的空间目录。每个空间仍需分别完成双方确认。</p><input id="recovery-code" type="password" placeholder="输入恢复码（仅演示）" aria-label="总恢复码" style="height:48px;border-radius:13px;border:1px solid var(--line);background:var(--surface-raised);padding:0 13px;margin:20px 0"><p class="hint">未成功备份的空间和历史无法仅凭恢复码找回。</p></div><footer class="page-actions">${button('继续','recovery-list')}</footer></section>`;
}
function recoveryList() {
  return `<section class="page"><header class="page-top"><button type="button" data-action="lost-back">‹</button></header><div class="page-main" style="justify-content:flex-start;padding-top:30px"><h1>选择要恢复的空间</h1><p>可以逐个恢复；一个空间等待对方确认时，不阻塞其他空间。</p><div class="recover-list"><button type="button" data-action="recover-a">晚风<small>等待双方确认</small></button><button type="button" data-action="recover-b">周末小屋<small>可单独发起恢复</small></button></div></div></section>`;
}
function render() {
  viewTitle.textContent = ({chat:'聊天与空间列表',create:'创建空间',invite:'生成邀请',join:'打开邀请',invalid:'无效邀请',lost:'首次进入',recovery:'输入总恢复码',recoveries:'逐空间恢复',style:'在线样式'})[state.scene] ?? '交互预览';
  const views = {chat,create:createPage,invite:invitePage,join:joinPage,invalid:()=>page('邀请链接不可用','请检查邀请链接是否完整，或请对方重新分享。不会自动进入旧空间。','invalid-back','返回原空间','invalid-back'),lost:lostPage,recovery:recoveryPage,recoveries:recoveryList,style:stylePage};
  app.innerHTML = (views[state.scene] ?? chat)() + (state.scene === 'chat' ? drawer() : '') + modal();
  document.querySelector('#self-online').checked = state.selfOnline;
  document.querySelector('#peer-online').checked = state.peerOnline;
  document.querySelector('#dark-mode').checked = document.documentElement.dataset.theme === 'dark';
  const list = app.querySelector('.space-list');
  if (list) list.scrollTop = state.listScroll;
  if (state.modal) app.querySelector('#room-name')?.focus();
}
function openChat() { state.scene='chat';state.drawer=null;state.contextId=null;state.modal=null;state.locked=false;render(); }
function triggerPulse(side) { state.pulse=side;render();clearTimeout(triggerPulse.timer);triggerPulse.timer=setTimeout(()=>{state.pulse=null;render();},700); }
function handleAction(action) {
  if (action === 'drawer') { state.drawer='rooms';state.contextId=null; }
  else if (action === 'close-drawer') { state.drawer=null;state.contextId=null; }
  else if (action === 'drawer-settings') { state.drawer='settings';state.contextId=null; }
  else if (action === 'drawer-home') state.drawer='rooms';
  else if (action === 'rename-start') { state.modal='rename';state.editValue=state.rooms.find(room=>room.id===state.contextId)?.name ?? '';state.contextId=null; }
  else if (action === 'rename-cancel') state.modal=null;
  else if (action === 'rename-save') { const value=app.querySelector('#room-name')?.value.trim();if(!value){toast('请输入空间名称');return;}const room=state.rooms.find(item=>item.id===state.editingId);if(room)room.name=value;state.modal=null;toast('名称已更新，仅自己可见'); }
  else if (action === 'create-start') { state.returnRoom=state.current;state.createSource='drawer';state.scene='create';state.drawer=null; }
  else if (action === 'create-back') {state.current=state.returnRoom;openChat();state.drawer='rooms';}
  else if (action === 'create-confirm') {const id=`new-${state.nextId++}`;state.rooms.push({id,name:'新的空间',pending:true});state.current=id;state.scene='invite';}
  else if (action === 'invite-back') {openChat();state.drawer='rooms';}
  else if (action === 'copy-invite') toast('模拟复制成功：没有生成真实邀请密钥');
  else if (action === 'style') {state.scene='style';state.drawer=null;}
  else if (action === 'style-back') {openChat();state.drawer='settings';}
  else if (action === 'style-capsule'||action === 'style-heart') {state.style=action==='style-heart'?'heart':'capsule';toast('在线样式已更新');}
  else if (action === 'join-confirm') {const id=`joined-${state.nextId++}`;state.rooms.push({id,name:'雨后花园',pending:false});state.current=id;openChat();toast('已加入新空间，旧空间仍在列表中');}
  else if (action === 'join-back'||action === 'invalid-back') openChat();
  else if (action === 'lost-create') { state.createSource='lost';state.scene='create'; }
  else if (action === 'lost-recover') state.scene='recovery';
  else if (action === 'lost-back') state.scene='lost';
  else if (action === 'recovery-list') {if(!app.querySelector('#recovery-code')?.value.trim()){toast('请输入恢复码（演示可填任意文字）');return;}state.scene='recoveries';}
  else if (action==='recover-a'||action==='recover-b') toast('模拟：等待此空间双方分别确认；其他空间仍可操作');
  else if (action==='send') triggerPulse('self');
  else if (action==='heart-help') toast('左半代表对方，右半代表自己；电流按发消息的一侧触发');
  else if (action==='composer-help') toast('聊天功能沿用现有行为，此原型只演示空间切换');
  else if (['devices','backup','history','my-code','cover','help','updates'].includes(action)) toast(`${({devices:'设备管理',backup:'备份数据',history:'恢复数据','my-code':'我的恢复码',cover:'体验或开启遮蔽',help:'功能说明',updates:'更新日志'})[action]}：原有功能从此入口进入`);
  render();
}
let holdTimer;
let longPressed=false;
app.addEventListener('pointerdown', event => {
  const row=event.target.closest('[data-room]');
  if(!row)return;
  longPressed=false;
  clearTimeout(holdTimer);
  holdTimer=setTimeout(()=>{state.contextId=row.dataset.room;state.editingId=state.contextId;longPressed=true;render();},550);
});
for (const kind of ['pointerup','pointercancel','pointerleave']) app.addEventListener(kind,()=>clearTimeout(holdTimer));
app.addEventListener('pointermove',()=>clearTimeout(holdTimer));
app.addEventListener('contextmenu',event=>{const row=event.target.closest('[data-room]');if(!row)return;event.preventDefault();state.contextId=row.dataset.room;state.editingId=state.contextId;render();});
app.addEventListener('scroll',event=>{if(event.target.classList.contains('space-list'))state.listScroll=event.target.scrollTop;},true);
app.addEventListener('click', event => {
  const row=event.target.closest('[data-room]');
  if(row){if(longPressed){longPressed=false;return;}state.current=row.dataset.room;openChat();return;}
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action)handleAction(action);
  else if(state.contextId){state.contextId=null;render();}
});
app.addEventListener('keydown',event=>{if(event.key==='Escape'){if(state.modal)state.modal=null;else if(state.contextId)state.contextId=null;else state.drawer=null;render();}if(event.key==='Enter'&&state.modal&&event.target.id==='room-name'){event.preventDefault();handleAction('rename-save');}});
document.querySelectorAll('[data-demo]').forEach(button=>button.addEventListener('click',()=>{const demo=button.dataset.demo;if(demo==='chat'){openChat();return;}state.drawer=null;state.contextId=null;state.modal=null;state.scene=({invite:'join',invalid:'invalid',lost:'lost'})[demo];render();}));
document.querySelector('#self-online').addEventListener('change',event=>{state.selfOnline=event.target.checked;render();});
document.querySelector('#peer-online').addEventListener('change',event=>{state.peerOnline=event.target.checked;render();});
document.querySelector('#dark-mode').addEventListener('change',event=>{document.documentElement.dataset.theme=event.target.checked?'dark':'light';render();});
document.querySelector('#simulate-peer-message').addEventListener('click',()=>triggerPulse('peer'));
render();
