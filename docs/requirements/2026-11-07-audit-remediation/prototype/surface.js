// Review-only adapter: actual product shell, message components and cascade;
// synthetic model, no server/vault installation. Not production virtualization.
import {generateIdentity} from '/src/lib/crypto.ts';
import {mountSystemChrome} from '/src/lib/system-chrome.ts';
const styles = await (await fetch('/prototype-style-order.json')).json();
for (const style of styles.slice(0,9)) await import(style);
const {QuietRoomApp}=await import('/src/app.ts');
for (const style of styles.slice(9)) await import(style);
mountSystemChrome();
const root=document.querySelector('#app'),app=new QuietRoomApp(root),identity=await generateIdentity(),peer=await generateIdentity();
const now='2026-11-07T08:00:00Z';
app.session={vault:{v:3,roomId:'synthetic-window',role:'creator',identity,accessToken:'synthetic',pairingSecret:'',creatorFingerprint:'synthetic',lastSeq:10000,createdAt:now,protocol:'legacy-v1',members:[{...identity.publicBundle,role:'creator',status:'active'},{...peer.publicBundle,role:'joiner',status:'active'}]},key:await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),stored:{v:3,unlockMethod:'password',spaceId:'synthetic-window'}};
app.privacyCovered=false;app.runtimeAbort=new AbortController();app.uiPreferencesHydrated=true;app.uiPreferences={entranceCardDismissed:true,recoveryReminderDismissed:true};app.connectionState='connected';app.currentSpaceName='慢慢说';app.currentSpaceAvatar={v:1,kind:'emoji',emoji:'1f331',background:0};
app.updateSafetyCode=async()=>{};app.updateBackgroundNotificationControl=async()=>{};app.scheduleUiPreferencesSave=()=>{};app.unreadCounter.markRead=async()=>{};app.mountChatImageObserver=()=>{};
app.renderChat();app.chatBottomControl?.destroy();app.updateConnectionStatus();
const messages=Array.from({length:10000},(_,i)=>({seq:i+1,clientMsgId:'prototype-'+(i+1),senderId:i%3===0?identity.publicBundle.deviceId:peer.publicBundle.deviceId,status:'delivered',acceptedAt:now,payload:{v:1,kind:'text',sentAt:now,text:(i===5999?'记得最开始说过的那句话。':i%7===0?'今天不急着赶路，沿着河边慢慢走。聊到这里，也可以停下来看看远处。':'晚一点见，路上慢慢来。')+' ['+(i+1)+']'}}));
messages[5999].payload.replyTo={clientMsgId:messages[99].clientMsgId,serverSeq:100,senderId:messages[99].senderId,kind:'text',text:messages[99].payload.text};
app.messages=new Map(messages.map(m=>[m.seq,m]));
// The prototype owns only the list projection; product mutation/transport is never invoked.
app.renderMessages=()=>{};app.historyHasMore=false;app.historyHasNewer=false;app.jumpToReplyTarget=(_id,seq)=>jump(seq);
root.querySelector('#composer').addEventListener('submit',e=>{e.preventDefault();e.stopImmediatePropagation()},true);
const list=root.querySelector('#message-list');list.replaceChildren();
const heights=new Array(10020).fill(70),nodes=new Map(),top=document.createElement('div'),bottom=document.createElement('div');
top.setAttribute('aria-hidden','true');bottom.setAttribute('aria-hidden','true');top.style.flexShrink='0';bottom.style.flexShrink='0';
const originalBadge=root.querySelector('#chat-bottom-control'),badge=originalBadge.cloneNode(true);badge.id='prototype-bottom-control';badge.classList.add('is-visible');badge.setAttribute('aria-hidden','false');badge.tabIndex=0;originalBadge.replaceWith(badge);
function badgeCount(n){badge.dataset.newMessages=String(n>0);const count=badge.querySelector('.chat-new-count');count.hidden=!n;count.textContent=n+' 条新消息';badge.setAttribute('aria-label',n?'进入首条未读':'回到最新')}
let start=0,end=0,unread=0,locked=false,raf=0,firstUnread=0;
const offset=i=>heights.slice(0,i).reduce((a,b)=>a+b,0);
const scroll=()=>app.chatScrollTop;
const viewport=()=>app.usesListScrolling?list.clientHeight:innerHeight;
const setScroll=y=>app.setChatScrollTop(y);
const selected=()=>{const s=getSelection();return Boolean(s&&!s.isCollapsed&&list.contains(s.anchorNode))};
const rowAt=y=>{let n=0,h=0;while(n<messages.length&&h+heights[n]<y){h+=heights[n++]}return n};
function report(){parent.postMessage({status:locked?'已锁定：聊天节点及内存清空':`合成记录 ${messages.length.toLocaleString()} · 挂载 ${nodes.size} 条\n窗口 ${start+1}–${end} · ${selected()?'选区保留中':'可滚动'}\n滚动承载：${app.usesListScrolling?'消息列表':'文档'}`},location.origin)}
function render(center,force=false){if(locked)return;if(!force&&(selected()||list.contains(document.activeElement))){report();return}
 const n=center??rowAt(scroll()),a=Math.max(0,Math.min(messages.length-80,n-25)),z=Math.min(messages.length,a+80);
 if(!force&&a===start&&z===end)return;
 const anchor=[...nodes.entries()].find(([,el])=>el.getBoundingClientRect().bottom>60);const oldTop=anchor?.[1].getBoundingClientRect().top;
 start=a;end=z;for(const [i,node] of nodes)if(i<a||i>=z){node.remove();nodes.delete(i)}
 for(let i=a;i<z;i++)if(!nodes.has(i)){const node=app.createMessageElement(messages[i],new Map());node.dataset.prototypeIndex=String(i);node.setAttribute('aria-posinset',String(i+1));node.setAttribute('aria-setsize',String(messages.length));nodes.set(i,node)}
 top.style.height=offset(a)+'px';bottom.style.height=(offset(messages.length)-offset(z))+'px';list.replaceChildren(top,...[...nodes].sort(([a],[b])=>a-b).map(([,el])=>el),bottom);
 for(const [i,node] of nodes){const css=getComputedStyle(node);heights[i]=node.getBoundingClientRect().height+parseFloat(css.marginTop)+parseFloat(css.marginBottom)}
 top.style.height=offset(a)+'px';bottom.style.height=(offset(messages.length)-offset(z))+'px';
 if(anchor&&nodes.has(anchor[0]))setScroll(scroll()+anchor[1].getBoundingClientRect().top-oldTop);
 report();}
function jump(seq){if(locked)return;getSelection()?.removeAllRanges();document.activeElement?.blur();render(Math.max(0,seq-1),true);setScroll(offset(seq-1));const node=nodes.get(seq-1);if(node){node.scrollIntoView({block:'center'});node.animate([{backgroundColor:'var(--surface-raised)'},{backgroundColor:'transparent'}],{duration:700})}report()}
function incoming(){if(locked)return;const atBottom=scroll()+viewport()>=offset(messages.length)-140;const m={...messages.at(-1),senderId:peer.publicBundle.deviceId,seq:messages.length+1,clientMsgId:'prototype-'+(messages.length+1),payload:{v:1,kind:'text',sentAt:now,text:'我到了，我们慢慢聊。 ['+(messages.length+1)+']'}};messages.push(m);heights.push(70);app.messages.set(m.seq,m);if(atBottom){jump(m.seq)}else{unread++;firstUnread||=m.seq;badgeCount(unread);if(!selected()&&!list.contains(document.activeElement))render(undefined,true);else bottom.style.height=(offset(messages.length)-offset(end))+'px'}report()}
badge.onclick=()=>{jump(firstUnread||messages.length);unread=0;firstUnread=0;badgeCount(0)};
const onScroll=()=>{if(!raf)raf=requestAnimationFrame(()=>{raf=0;render()})};list.addEventListener('scroll',onScroll,{passive:true});addEventListener('scroll',onScroll,{passive:true});document.addEventListener('selectionchange',()=>{if(!selected())onScroll();report()});
addEventListener('message',e=>{if(e.source!==parent||e.origin!==location.origin)return;switch(e.data.action){case'middle':jump(6000);break;case'incoming':incoming();break;case'unread':jump(firstUnread||9980);break;case'latest':jump(messages.length);break;case'grow':{const anchor=[...nodes.values()].find(el=>el.getBoundingClientRect().top>60);if(!anchor)break;const before=anchor.getBoundingClientRect().top;const first=nodes.get(start);first.querySelector('.message-bubble').append(document.createTextNode(' 上方内容展开。'.repeat(18)));heights[start]=first.getBoundingClientRect().height+parseFloat(getComputedStyle(first).marginTop)+parseFloat(getComputedStyle(first).marginBottom);setScroll(scroll()+anchor.getBoundingClientRect().top-before);report();break}case'lock':locked=true;app.runtimeAbort.abort();getSelection()?.removeAllRanges();messages.length=0;nodes.clear();app.messages.clear();root.replaceChildren();root.textContent='已锁定';report();break}});
window.prototype={app,jump,incoming,get nodes(){return nodes},get messages(){return messages}};
requestAnimationFrame(()=>{jump(9980);report()});
