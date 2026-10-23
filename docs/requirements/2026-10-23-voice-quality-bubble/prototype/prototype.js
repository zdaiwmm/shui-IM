const $ = selector => document.querySelector(selector);
const icons = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="wave-1" d="M6 11v2"/><path class="wave-2" d="M10 8a6 6 0 0 1 0 8"/><path class="wave-3" d="M14 4.5a11 11 0 0 1 0 15"/></svg>';
const receipt = '<svg viewBox="0 0 22 16" aria-hidden="true"><path d="m2 8 4 4L16 2"/></svg>';
let selected = { seconds:12, direction:'outgoing', state:'idle', elapsed:0, reply:false };
let active = null, timeout = null, timer = null, menuTarget = null, longPress = null, consumeClick = false;
let samples = [], selectedVisible = true;
const widthFor = seconds => Math.round(84 + 136 * Math.min(1, Math.max(0, seconds - 1) / 59));
function stopTiming(){clearTimeout(timeout);clearInterval(timer);timeout=null;timer=null;}
function announce(text){$('#announcement').textContent=text;}
function closeMenu(){ $('#message-menu').hidden=true; menuTarget=null; }
function stateLabel(message){return ({loading:'正在加载… 再点取消',playing:'正在播放',paused:`已暂停 · ${Math.floor(message.elapsed)} 秒`,ended:'已播完',error:'加载失败，轻点重试',pending:'发送中', 'send-error':'发送失败，轻点重试'})[message.state]||'';}
function buildMessage(message,index){
 const row=document.createElement('article');row.className=`message ${message.direction}${message===selected?' selected-message':' demo-message'}`;row.dataset.index=String(index);
 const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=message.direction==='outgoing'?'我':'日';avatar.setAttribute('aria-hidden','true');
 const content=document.createElement('div');content.className='message-content';
 if(message.reply){const quote=document.createElement('div');quote.className='reply-quote';quote.innerHTML='<strong>对方</strong>好的，晚一点说。';content.append(quote);}
 const line=document.createElement('div');line.className='voice-line';
 const button=document.createElement('button');button.className='voice-hit';button.dataset.state=message.state;button.style.setProperty('--voice-width',`${widthFor(message.seconds)}px`);button.type='button';
 const action=message.state==='playing'?'暂停':message.state==='loading'?'取消加载':['error','send-error'].includes(message.state)?'重试':'播放';
 button.setAttribute('aria-label',`${action}${message.seconds}秒语音`);button.setAttribute('aria-busy',String(message.state==='loading'||message.state==='pending'));button.setAttribute('aria-pressed',String(message.state==='playing'));
 button.innerHTML=`<span class="sound-icon">${icons}</span>`;
 const duration=document.createElement('span');duration.className='voice-duration';duration.textContent=`${message.seconds}″`;duration.setAttribute('aria-hidden','true');line.append(button,duration);content.append(line);
 const meta=document.createElement('div');meta.className='voice-meta';meta.innerHTML=`<time>10:${String(20+index).padStart(2,'0')}</time>${message.direction==='outgoing'?receipt:''}`;if(message.direction==='outgoing')meta.setAttribute('aria-label',`${message.state==='pending'?'等待发送':message.state==='send-error'?'发送失败':'已发送，未收到已读回执'}`);content.append(meta);
 if(['pending','send-error'].includes(message.state))meta.querySelector('svg')?.remove();
 const status=document.createElement('div');status.className=`voice-status${['error','send-error'].includes(message.state)?' error':''}`;status.textContent=stateLabel(message);status.setAttribute('role','status');if(!status.textContent)status.hidden=true;content.append(status);
 row.append(avatar,content);
 button.addEventListener('click',()=>{if(consumeClick){consumeClick=false;return;}activate(message);});
 const openMenu=event=>{event.preventDefault();menuTarget=message;const menu=$('#message-menu');menu.hidden=false;const rect=button.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(innerWidth-198,rect.left))}px`;menu.style.top=`${Math.max(8,Math.min(innerHeight-154,rect.bottom+8))}px`;};
 button.addEventListener('contextmenu',openMenu);button.addEventListener('pointerdown',event=>{if(event.button!==0)return;const x=event.clientX,y=event.clientY;longPress=setTimeout(()=>{consumeClick=true;openMenu(event);},500);const cancel=()=>clearTimeout(longPress);button.addEventListener('pointermove',move=>{if(Math.hypot(move.clientX-x,move.clientY-y)>10)cancel();},{once:true});button.addEventListener('pointerup',cancel,{once:true});button.addEventListener('pointercancel',cancel,{once:true});});
 return row;
}
function render(){
 const list=$('#message-list');const scroll=list.scrollTop;list.replaceChildren();
 const date=document.createElement('p');date.className='date-label';date.textContent='今天 · 合成聊天示例';list.append(date);
 const text=document.createElement('p');text.className='text-message';text.textContent='路上的风有点大，我发语音说。';list.append(text);
 [...samples,...(selectedVisible?[selected]:[])].forEach((message,index)=>list.append(buildMessage(message,index)));
 list.scrollTop=scroll;
 $('#duration').value=String(selected.seconds);$('#duration-value').textContent=selected.seconds>=60?`${Math.floor(selected.seconds/60)} 分 ${selected.seconds%60} 秒`:`${selected.seconds} 秒`;
 $('#state').value=selected.state;$('#show-reply').checked=selected.reply;document.querySelectorAll('[name=direction]').forEach(input=>input.checked=input.value===selected.direction);document.querySelectorAll('[data-seconds]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.seconds)===selected.seconds)));
}
function beginPlaying(message){message.state='playing';active=message;render();timer=setInterval(()=>{message.elapsed+=.25;if(message.elapsed>=message.seconds){stopTiming();message.elapsed=0;message.state='ended';active=null;render();announce('演示语音已播完');}},250);}
function activate(message){
 closeMenu();if(message.state==='pending')return;
 if(active&&active!==message){active.state='paused';}
 stopTiming();
 if(message.state==='playing'){message.state='paused';active=null;render();return;}
 if(message.state==='loading'){message.state='idle';active=null;render();return;}
 if(message.state==='send-error'){message.state='pending';active=message;render();timeout=setTimeout(()=>{message.state='idle';active=null;render();announce('演示发送成功');},700);return;}
 if(message.state==='ended')message.elapsed=0;
 message.state='loading';active=message;render();timeout=setTimeout(()=>beginPlaying(message),500);
}
function updateSelected(patch){if(active){active.state='paused';}stopTiming();active=null;selectedVisible=true;selected={...selected,state:'idle',elapsed:0,...patch};render();}
function setState(state){updateSelected({state});if(state==='playing')beginPlaying(selected);else if(state==='paused'){selected.elapsed=Math.min(3,selected.seconds/2);render();}}
function reset(){stopTiming();active=null;closeMenu();selectedVisible=true;samples=[{seconds:3,direction:'incoming',state:'idle',elapsed:0},{seconds:6,direction:'outgoing',state:'idle',elapsed:0},{seconds:38,direction:'incoming',state:'idle',elapsed:0}];selected={seconds:12,direction:'outgoing',state:'idle',elapsed:0,reply:false};$('#privacy-cover').hidden=true;$('#message-list').inert=false;render();}
function lock(){stopTiming();if(active){active.state='idle';active.elapsed=0;}active=null;closeMenu();render();$('#message-list').inert=true;$('#privacy-cover').hidden=false;announce('演示已锁定，播放与加载已停止');}
$('#duration').addEventListener('input',event=>updateSelected({seconds:Number(event.target.value)}));document.querySelectorAll('[data-seconds]').forEach(button=>button.addEventListener('click',()=>updateSelected({seconds:Number(button.dataset.seconds)})));
document.querySelectorAll('[name=direction]').forEach(input=>input.addEventListener('change',()=>updateSelected({direction:input.value})));
$('#state').addEventListener('change',event=>setState(event.target.value));$('#show-reply').addEventListener('change',event=>updateSelected({reply:event.target.checked}));
$('#theme-toggle').addEventListener('click',()=>{const dark=document.documentElement.dataset.colorScheme!=='dark';document.documentElement.dataset.colorScheme=dark?'dark':'light';$('#theme-toggle').textContent=dark?'浅色':'深色';$('#theme-toggle').setAttribute('aria-label',dark?'切换浅色主题':'切换深色主题');});
$('#reset-demo').addEventListener('click',reset);$('#lock-demo').addEventListener('click',lock);$('#unlock-demo').addEventListener('click',reset);
$('#add-sample').addEventListener('click',()=>{if(samples.length>=8)samples.shift();samples.push({...selected,state:'idle',elapsed:0});render();$('#message-list').scrollTop=$('#message-list').scrollHeight;});
$('#reply-action').addEventListener('click',()=>{updateSelected({reply:true});closeMenu();announce('已为演示语音添加引用');});$('#delete-action').addEventListener('click',()=>{if(menuTarget===active){stopTiming();active=null;}if(menuTarget===selected)selectedVisible=false;else samples=samples.filter(sample=>sample!==menuTarget);closeMenu();render();announce('演示消息已删除；重置可恢复');});$('#cancel-action').addEventListener('click',closeMenu);
document.addEventListener('pointerdown',event=>{if(!event.target.closest('#message-menu,.voice-hit'))closeMenu();});document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});document.addEventListener('visibilitychange',()=>{if(document.hidden)lock();});window.addEventListener('pagehide',lock);
new ResizeObserver(()=>$('#preview-size').textContent=`${Math.round($('#chat-screen').getBoundingClientRect().width)} px · 合成示例`).observe($('#chat-screen'));
reset();
