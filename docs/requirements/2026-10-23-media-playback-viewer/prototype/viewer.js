import '/src/styles.css';
import '/src/chat-layout.css';
import '/src/gallery.css';
import '/src/chat-interactions.css';
import '/src/motion.css';
import '/src/desktop.css';
import '/src/experience.css';
import '/src/system-chrome.css';
import '/src/form-input.css';
import '/src/chamber-refinements.css';
import '/src/room-polish.css';
import './viewer.css';
import {createElement,X,Play,Pause,RotateCcw,RotateCw,Volume2,VolumeX,Trash2,Star,Info,ChevronLeft,ChevronRight,Maximize,Image as ImageIcon,Video,LockKeyhole,RefreshCw} from 'lucide';
import fixtureSource from '/tests/video-flow.e2e.mjs?raw';

// Reuse the existing synthetic photo asset without executing the test or app.
const sample=fixtureSource.match(/new File\(\['(<svg[^\n]+?<\/svg>)'\]/)?.[1];
if(!sample)throw Error('Synthetic photo fixture is unavailable');
const mediaUrl=URL.createObjectURL(new Blob([sample],{type:'image/svg+xml'}));
const root=document.querySelector('#app');
const icon=(shape)=>createElement(shape).outerHTML;
const button=(label,shape,attr='')=>`<button class="viewer-control" type="button" aria-label="${label}" title="${label}" ${attr}>${icon(shape)}</button>`;
let settings={source:'chat',kind:'video',state:'normal',scheme:'light',font:'16'};
let kind='video',playing=false,muted=false,speed=1,current=12,controlsHidden=false,closed=false;
let tick,hideTimer,retryTimer;
const duration=154;
const format=value=>`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
function reportLayout(){requestAnimationFrame(()=>{
  parent.postMessage({type:'media-review-current',state:settings.state,kind,revision:settings.revision},location.origin);
  const rect=s=>root.querySelector(s)?.getBoundingClientRect();const center=rect('.prototype-center'),bottom=rect('.prototype-bottom');
  const visible=[...root.querySelectorAll('button')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');
  const seek=root.querySelector('[data-seek]'),r=seek?.getBoundingClientRect();
  const geometry={width:innerWidth,height:innerHeight,font:getComputedStyle(document.documentElement).fontSize,centerBottom:center?.bottom??null,bottomTop:bottom?.top??null,overlap:!!center&&!!bottom&&center.bottom>bottom.top,seekHit:r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===seek:null,smallTargets:visible.filter(el=>{const b=el.getBoundingClientRect();return b.width<44||b.height<44}).map(el=>el.getAttribute('aria-label')||el.textContent),playButtons:root.querySelectorAll('[data-play]').length,errorVisible:!!root.querySelector('.prototype-feedback'),horizontalOverflow:document.documentElement.scrollWidth>innerWidth};
  parent.postMessage({type:'media-review-geometry',geometry,revision:settings.revision},location.origin);
})}
function stop(){clearInterval(tick);clearTimeout(hideTimer);clearTimeout(retryTimer);playing=false;controlsHidden=false;}
function status(text){const box=root.querySelector('[data-notice]');if(box){box.textContent=text;box.hidden=false;setTimeout(()=>{if(box.isConnected)box.hidden=true},2600)}}
function sync(){
  const viewer=root.querySelector('.image-viewer');if(!viewer)return;
  viewer.dataset.controls=controlsHidden?'hidden':'visible';
  const play=root.querySelector('[data-play]');if(play){play.innerHTML=icon(playing?Pause:Play);play.setAttribute('aria-label',playing?'暂停视频':'播放视频');play.title=play.getAttribute('aria-label');}
  const seek=root.querySelector('[data-seek]');if(seek){seek.value=current;seek.setAttribute('aria-valuetext',`${format(current)} / ${format(duration)}`)}
  const time=root.querySelector('[data-time]');if(time)time.textContent=`${format(current)} / ${format(duration)}`;
  const remain=root.querySelector('[data-remaining]');if(remain)remain.textContent=`−${format(duration-current)}`;
}
function togglePlay(){
  playing=!playing;controlsHidden=false;clearInterval(tick);clearTimeout(hideTimer);
  if(playing){tick=setInterval(()=>{current=Math.min(duration,current+.1*speed);if(current>=duration){stop()}sync()},100);if(settings.source==='safe')hideTimer=setTimeout(()=>{controlsHidden=true;sync()},2600)}
  sync();
}
function render(){
  stop();kind=settings.kind;current=12;speed=1;muted=false;closed=false;
  document.documentElement.dataset.colorScheme=settings.scheme;
  document.documentElement.style.fontSize=`${settings.font}px`;
  if(settings.state==='locked'){root.innerHTML=`<main class="prototype-fallback"><div>${icon(LockKeyhole)}<h1>内容已隐藏</h1><p>查看器与播放已立即关闭。</p><button type="button" data-return>返回原型</button></div></main>`;root.querySelector('[data-return]').onclick=()=>{settings.state='normal';render()};reportLayout();return}
  if(settings.state==='empty'){showGallery(true);return}
  drawViewer();
}
function showGallery(empty=false){
  stop();closed=true;
  root.innerHTML=`<main class="prototype-gallery"><header><h1>${settings.source==='safe'?'保险箱相册':'聊天媒体'}</h1></header>${empty?`<section class="prototype-fallback"><div>${icon(ImageIcon)}<h2>还没有照片和视频</h2><p>这里仅展示原型的空状态。</p><button data-restore type="button">恢复示例媒体</button></div></section>`:`<div class="prototype-grid"><button data-open="photo" aria-label="显示图片 示例照片.svg"><img src="${mediaUrl}" alt="示例照片" class="concealed"></button><button data-open="video" aria-label="显示视频预览 示例片段.webm"><img src="${mediaUrl}" alt="示例视频封面" class="concealed">${icon(Play)}</button></div><p class="prototype-gallery-note">首次点击显露，再次点击打开</p>`}</main>`;
  root.querySelector('[data-restore]')?.addEventListener('click',()=>showGallery());
  root.querySelectorAll('[data-open]').forEach(el=>el.onclick=()=>{if(!el.dataset.revealed){el.dataset.revealed='true';el.querySelector('img').classList.remove('concealed');el.setAttribute('aria-label',`${el.dataset.open==='photo'?'查看图片':'播放视频'} 示例媒体`)}else{kind=el.dataset.open;closed=false;settings.state='normal';drawViewer()}});
}
function drawViewer(){
  stop();const safe=settings.source==='safe',video=kind==='video';
  const fault=['tap','decode','network','loading'].includes(settings.state);
  const title=video?'示例片段.webm':'示例照片.svg';
  root.innerHTML=`<section class="image-viewer is-visible ${video?'video-viewer':''}" role="dialog" aria-modal="true" aria-label="${video?'视频播放器':'图片查看器'}" ${safe?'data-safe-viewer':''} data-controls="visible" data-kind="${kind}" data-prototype-state="${settings.state}">
    <header class="viewer-header">${button('关闭查看器',X,'data-close data-viewer-close')}<div class="prototype-metadata" ${safe&&video?'hidden':''}><strong data-viewer-name>${title}</strong><div class="viewer-metadata"><span data-viewer-counter>${video?'2':'1'} / 2</span><time>2026/10/23 14:30</time></div></div>${safe&&video?button('静音',Volume2,'data-mute'):safe?button('查看图片详情',Info,'data-info aria-expanded="false"'):button('收藏当前附件',Star,'data-favorite aria-pressed="false"')}</header>
    <div class="viewer-stage" tabindex="${video?'0':'-1'}" aria-label="${video?'视频画面，空格播放或暂停':'图片画面'}"><div class="viewer-media-layer ${video?'is-video':'is-image'}"><img class="prototype-media" src="${mediaUrl}" alt="${video?'合成视频示例画面':'合成照片示例'}" draggable="false"></div></div>
    ${video&&!fault?`<div class="prototype-center" aria-label="视频播放控制">${button('后退 10 秒',RotateCcw,'data-back')}<button class="viewer-control prototype-main-play" data-play type="button" aria-label="播放视频">${icon(Play)}</button>${button('前进 10 秒',RotateCw,'data-forward')}</div><div class="prototype-bottom"><div class="prototype-actions">${safe?button('删除保险箱中的此项',Trash2,'data-delete'):''}${safe?'':button('静音',Volume2,'data-mute')}<button class="viewer-control prototype-speed" type="button" aria-label="播放速度 1 倍" data-speed>1×</button>${safe?'':button('全屏播放',Maximize,'data-fullscreen')}</div><div class="prototype-timeline"><span data-time>${format(current)} / ${format(duration)}</span><input type="range" min="0" max="${duration}" value="${current}" step="0.1" aria-label="视频进度" data-seek>${safe?'<span data-remaining>−2:22</span>':''}</div></div>`:''}
    ${safe&&!video?`<div class="viewer-delete-wrap">${button('删除保险箱中的此项',Trash2,'data-delete')}</div>`:''}
    <button class="viewer-nav viewer-previous" aria-label="上一项" type="button" data-page="-1">${icon(ChevronLeft)}</button><button class="viewer-nav viewer-next" aria-label="下一项" type="button" data-page="1">${icon(ChevronRight)}</button>
    <p class="prototype-notice" role="status" data-notice hidden></p>
    ${fault?stateMarkup():''}
  </section>`;
  root.querySelector('[data-close]').onclick=()=>showGallery();
  root.querySelectorAll('[data-page]').forEach(el=>el.onclick=()=>{kind=kind==='video'?'photo':'video';settings.state='normal';drawViewer()});
  root.querySelector('[data-play]')?.addEventListener('click',togglePlay);
  root.querySelector('[data-back]')?.addEventListener('click',()=>{current=Math.max(0,current-10);sync()});
  root.querySelector('[data-forward]')?.addEventListener('click',()=>{current=Math.min(duration,current+10);sync()});
  root.querySelector('[data-mute]')?.addEventListener('click',event=>{muted=!muted;event.currentTarget.innerHTML=icon(muted?VolumeX:Volume2);event.currentTarget.setAttribute('aria-label',muted?'开启声音':'静音');event.currentTarget.setAttribute('aria-pressed',String(muted))});
  root.querySelector('[data-speed]')?.addEventListener('click',event=>{speed=speed===1?1.5:speed===1.5?2:1;event.currentTarget.textContent=`${speed}×`;event.currentTarget.setAttribute('aria-label',`播放速度 ${speed} 倍`)});
  root.querySelector('[data-seek]')?.addEventListener('input',event=>{current=Number(event.target.value);sync()});
  root.querySelector('[data-fullscreen]')?.addEventListener('click',()=>{const el=root.querySelector('.image-viewer');if(el.requestFullscreen)void el.requestFullscreen().catch(()=>status('全屏请求未获允许，仍可在页内查看'));else status('此浏览器未提供全屏入口')});
  root.querySelector('[data-favorite]')?.addEventListener('click',event=>{const value=event.currentTarget.getAttribute('aria-pressed')!=='true';event.currentTarget.setAttribute('aria-pressed',String(value));event.currentTarget.setAttribute('aria-label',value?'取消收藏当前附件':'收藏当前附件');status(value?'已收藏':'已取消收藏')});
  root.querySelector('[data-delete]')?.addEventListener('click',event=>showDelete(event.currentTarget));
  root.querySelector('[data-info]')?.addEventListener('click',showDetails);
  root.querySelector('[data-retry]')?.addEventListener('click',()=>{settings.state='loading';drawViewer();retryTimer=setTimeout(()=>{if(!closed&&settings.state==='loading'){settings.state='normal';drawViewer()}},700)});
  root.querySelector('[data-allow-play]')?.addEventListener('click',()=>{settings.state='normal';drawViewer();togglePlay()});
  const stage=root.querySelector('.viewer-stage');
  stage?.addEventListener('click',()=>{if(safe&&video&&playing){controlsHidden=!controlsHidden;sync()}});
  let swipeStart;
  stage?.addEventListener('pointerdown',event=>{swipeStart={x:event.clientX,y:event.clientY}});
  stage?.addEventListener('pointerup',event=>{if(!swipeStart)return;const dx=event.clientX-swipeStart.x,dy=event.clientY-swipeStart.y;swipeStart=undefined;if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5){kind=kind==='video'?'photo':'video';settings.state='normal';drawViewer()}});
  stage?.addEventListener('pointercancel',()=>{swipeStart=undefined});
  root.querySelector('.prototype-media')?.addEventListener('dblclick',event=>{if(!video)event.currentTarget.classList.toggle('is-zoomed')});
  root.querySelector('[data-close]').focus({preventScroll:true});sync();reportLayout();
}
function stateMarkup(){
  const s=settings.state;
  const media=kind==='video'?'视频':'图片';
  const title=s==='loading'?`正在加载${media}`:s==='tap'?'点按播放视频':s==='network'?`${media}加载失败`:`此浏览器无法${kind==='video'?'播放该视频':'显示该图片'}`;
  const copy=s==='loading'?'加载完成后即可播放。':s==='tap'?'浏览器需要你再次确认播放。':s==='network'?'请检查连接后重试。':'可关闭查看器，或切换到其他媒体。';
  return `<section class="prototype-feedback" role="status" aria-live="polite">${icon(s==='network'?RefreshCw:Video)}<h2>${title}</h2><p>${copy}</p>${s==='network'?'<button type="button" data-retry>重试</button>':s==='tap'?'<button type="button" data-allow-play>播放视频</button>':''}</section>`;
}
function showDelete(anchor){
  root.querySelector('.media-delete-confirm')?.remove();
  const box=document.createElement('div');box.className='media-delete-confirm prototype-delete-confirm';box.setAttribute('role','dialog');box.setAttribute('aria-label','确认删除保险箱中的此项');
  box.innerHTML=`<p>仅从这台设备的保险箱删除此${kind==='video'?'视频':'照片'}，聊天消息保留。</p><button type="button" data-confirm-delete>删除${kind==='video'?'视频':'照片'}</button><button type="button" data-cancel-delete>取消</button>`;
  anchor.parentElement.append(box);anchor.setAttribute('aria-expanded','true');
  const dismiss=()=>{box.remove();anchor.setAttribute('aria-expanded','false');anchor.focus({preventScroll:true})};
  box.querySelector('[data-cancel-delete]').onclick=dismiss;box.querySelector('[data-confirm-delete]').onclick=()=>showGallery(true);box.querySelector('[data-cancel-delete]').focus();
}
function showDetails(){
  root.querySelector('[data-info]').setAttribute('aria-expanded','true');
  const details=document.createElement('section');details.className='photo-details prototype-details';details.setAttribute('role','dialog');details.setAttribute('aria-label','图片详情');
  details.innerHTML='<h2>图片详情</h2><dl><dt>文件名</dt><dd>示例照片.svg</dd><dt>格式 / 大小</dt><dd>SVG+XML · 合成样本</dd><dt>像素尺寸</dt><dd>320 × 180</dd><dt>拍摄时间</dt><dd>未记录</dd><dt>上传 / 发送时间</dt><dd>2026/10/23 14:30</dd></dl><button type="button" data-hide-details>收起详情</button>';
  root.querySelector('.image-viewer').append(details);details.querySelector('button').onclick=()=>{details.remove();root.querySelector('[data-info]').setAttribute('aria-expanded','false');root.querySelector('[data-info]').focus()};details.querySelector('button').focus();
}
document.addEventListener('keydown',event=>{
  const viewer=root.querySelector('.image-viewer');if(!viewer)return;
  if(event.key==='Escape'){if(root.querySelector('[data-cancel-delete]'))root.querySelector('[data-cancel-delete]').click();else if(root.querySelector('[data-hide-details]'))root.querySelector('[data-hide-details]').click();else showGallery();return}
  controlsHidden=false;sync();
  if(event.target instanceof HTMLInputElement)return;
  if(event.key===' '&&event.target.classList.contains('viewer-stage')&&kind==='video'&&settings.state==='normal'){event.preventDefault();togglePlay()}
  if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();kind=kind==='video'?'photo':'video';settings.state='normal';drawViewer()}
  if(event.key==='Tab'){
    const activeModal=root.querySelector('.prototype-delete-confirm,.prototype-details')||viewer;
    const nodes=[...activeModal.querySelectorAll('button,input,[tabindex="0"]')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');
    if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1)?.focus()}else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0]?.focus()}
  }
});
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='media-review-v1')return;const next=event.data.settings;if(!['chat','safe'].includes(next.source)||!['video','photo'].includes(next.kind)||!['normal','loading','tap','decode','network','empty','locked'].includes(next.state))return;settings={...settings,...next};render()});
window.addEventListener('pagehide',()=>{stop();URL.revokeObjectURL(mediaUrl)});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();settings.state='locked';render()}});
render();
