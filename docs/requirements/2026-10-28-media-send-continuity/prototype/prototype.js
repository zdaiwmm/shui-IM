import createElement from '../../../../node_modules/lucide/dist/esm/createElement.js';
import UserRound from '../../../../node_modules/lucide/dist/esm/icons/user-round.js';
import Settings from '../../../../node_modules/lucide/dist/esm/icons/settings.js';
import CirclePlus from '../../../../node_modules/lucide/dist/esm/icons/circle-plus.js';
import Smile from '../../../../node_modules/lucide/dist/esm/icons/smile.js';
import Mic from '../../../../node_modules/lucide/dist/esm/icons/mic.js';
import LoaderCircle from '../../../../node_modules/lucide/dist/esm/icons/loader-circle.js';
import Check from '../../../../node_modules/lucide/dist/esm/icons/check.js';
import CircleAlert from '../../../../node_modules/lucide/dist/esm/icons/circle-alert.js';
import Video from '../../../../node_modules/lucide/dist/esm/icons/video.js';
const iconNames={UserRound,Settings,CirclePlus,Smile,Mic,LoaderCircle,Check,CircleAlert,Video};
for(const node of document.querySelectorAll('[data-icon]'))node.append(createElement(iconNames[node.dataset.icon]));
const rows=[...document.querySelectorAll('.message')],phase=document.querySelector('#phase'),note=document.querySelector('#phase-note'),cycle=document.querySelector('#cycle-label'),frame=document.querySelector('#frame'),toggle=document.querySelector('#toggle');
const duration=16000;
for(let n=0;n<=160;n++){const option=document.createElement('option');option.value=String(n);option.textContent=`${(n/10).toFixed(1)}s`;frame.append(option);}
let playing=!matchMedia('(prefers-reduced-motion: reduce)').matches,start=performance.now(),current=0,lastFrame=0;
const ease=x=>Math.max(0,Math.min(1,x));
function stateAt(t){
 if(t<600)return {state:'preparing',step:'upload',title:'准备发送',note:'位置先留好，时间暂不显示',progress:0,part:0};
 if(t<3500)return {state:'uploading',step:'upload',title:'上传中',note:'只更新进度，不改变消息尺寸',progress:ease((t-600)/2900),part:0};
 if(t<4700)return {state:'confirming',step:'confirm',title:'等待服务确认',note:'上传完成，仍不显示发送时间',progress:1,part:0};
 if(t<7600)return {state:'success',step:'done',title:'发送成功',note:'收到确认后，时间在原槽淡入',progress:1,alpha:ease((t-4700)/180),part:0};
 if(t<8200)return {state:'preparing',step:'upload',title:'再看一次失败重试',note:'同一条消息仍留在原位',progress:0,part:1};
 if(t<10100)return {state:'uploading',step:'upload',title:'上传中',note:'发送未完成，时间保持隐藏',progress:ease((t-8200)/2800),part:1};
 if(t<11900)return {state:'failed',step:'upload',title:'上传失败',note:'原位显示重试，不出现发送时间',progress:.68,part:1};
 if(t<13700)return {state:'uploading',step:'upload',title:'原位重试',note:'复用原消息与进度，不另插一条',progress:.68+.32*ease((t-11900)/1800),part:1};
 if(t<14300)return {state:'confirming',step:'confirm',title:'等待服务确认',note:'保持位置，等待真实发送结果',progress:1,part:1};
 return {state:'success',step:'done',title:'重试成功',note:'确认完成，再显示发送时间',progress:1,alpha:ease((t-14300)/180),part:1};
}
function render(t){
 current=Math.max(0,Math.min(duration,t));const s=stateAt(current);phase.textContent=s.title;note.textContent=s.note;cycle.textContent=s.part?'失败与重试':'正常发送';document.querySelector('#frame-label').textContent=`${(current/1000).toFixed(1)}s`;
 for(const li of document.querySelectorAll('li[data-step]'))li.classList.toggle('active',li.dataset.step===s.step);
 for(const [i,row]of rows.entries()){
   row.dataset.state=s.state;row.classList.toggle('is-failed',s.state==='failed');
   const time=row.querySelector('time'),activity=row.querySelector('.activity'),success=row.querySelector('.success'),retry=row.querySelector('.retry'),ring=row.querySelector('.progress-ring'),percent=row.querySelector('.percentage');
   time.style.opacity=String(s.state==='success'?s.alpha??1:0);time.setAttribute('aria-hidden',String(s.state!=='success'));
   activity.style.opacity=String(s.state==='success'?1-(s.alpha??1):s.state==='failed'?0:1);success.style.opacity=String(s.state==='success'?s.alpha??1:0);retry.style.opacity=String(s.state==='failed');retry.disabled=s.state!=='failed';retry.hidden=s.state!=='failed';
   const proportion=s.state==='uploading'?Math.max(0,Math.min(100,Math.round(s.progress*100)-(i===1?5:0))):0;
   percent.textContent=`${proportion}%`;percent.style.opacity=String(s.state==='uploading'&&i!==2);
   ring.style.transform=`rotate(${Math.round(current*.36)}deg)`;
   row.querySelector('.status').setAttribute('aria-label',s.state==='success'?`已发送，${time.textContent}`:s.state==='failed'?'上传失败，可重试':s.title);
 }
 document.querySelector('#board').dataset.time=String(current);document.querySelector('#board').dataset.phase=s.state;
}
function setPlaying(value){playing=value;toggle.textContent=value?'暂停':'播放';start=performance.now()-current;}
frame.addEventListener('change',()=>{if(frame.value==='auto'){setPlaying(true)}else{setPlaying(false);render(Number(frame.value)*100)}});
toggle.addEventListener('click',()=>{setPlaying(!playing);if(playing)frame.value='auto'});
document.querySelector('#replay').addEventListener('click',()=>{render(0);frame.value='auto';setPlaying(true)});
for(const button of document.querySelectorAll('.retry'))button.addEventListener('click',()=>{render(11900);frame.value='auto';setPlaying(true)});
for(const video of document.querySelectorAll('video'))video.addEventListener('loadedmetadata',()=>{video.currentTime=.15;video.pause()},{once:true});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',event=>{if(event.matches){setPlaying(false);render(5000)}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)setPlaying(false)});
render(playing?0:5000);toggle.textContent=playing?'暂停':'播放';
function tick(now){if(playing&&now-lastFrame>40){render((now-start)%duration);lastFrame=now;}requestAnimationFrame(tick)}requestAnimationFrame(tick);
