import { VoiceRecorder } from '/src/lib/voice-recorder.ts';
import { encodeVoiceWav, VOICE_SAMPLE_RATE } from '/src/lib/voice-audio.ts';
import { encryptAudioFile, decryptAudioFile } from '/src/lib/file-crypto.ts';

const $ = selector => document.querySelector(selector);
const NativeRecorder = window.MediaRecorder;
const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
let running=false, cancelled=false, current=null, contexts=[], urls=[], currentTrial=null, referenceUrl=null;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function stats(samples,rate){let peak=0,sum=0,clipped=0,maxJump=0;for(let i=0;i<samples.length;i++){const v=samples[i];peak=Math.max(peak,Math.abs(v));sum+=v*v;if(Math.abs(v)>=.999)clipped++;if(i)maxJump=Math.max(maxJump,Math.abs(v-samples[i-1]));}return {sampleRate:rate,durationMs:Math.round(samples.length/rate*1000),peak:+peak.toFixed(6),rms:+Math.sqrt(sum/Math.max(1,samples.length)).toFixed(6),clippedPercent:+(100*clipped/Math.max(1,samples.length)).toFixed(4),maxAdjacentJump:+maxJump.toFixed(6)};}
function readWav(bytes){const view=new DataView(bytes);const samples=new Float32Array((bytes.byteLength-44)/2);for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(44+i*2,true)/32768;return {samples,rate:view.getUint32(24,true)};}
async function digest(blob){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');}
function row(name,data,result){const tr=document.createElement('tr');for(const text of [name,`${data.sampleRate} Hz`,data.peak,data.rms,`${data.clippedPercent}%`,result]){const td=document.createElement('td');td.textContent=String(text);tr.append(td);}$('#results').append(tr);}
function edgeSafe(samples,fade=true){const result=Float32Array.from(samples);let peak=0;for(const sample of result)peak=Math.max(peak,Math.abs(sample));const scale=peak>.891?.891/peak:1;const edge=Math.min(Math.floor(VOICE_SAMPLE_RATE*.005),Math.floor(result.length/2));for(let i=0;i<result.length;i++){const envelope=fade&&edge?Math.min(1,i/edge,(result.length-1-i)/edge):1;result[i]*=scale*Math.max(0,envelope);}return result;}
function boundaryComparison(){
 const size=2400,a=new Float32Array(size).fill(.55),b=new Float32Array(size).fill(-.55);const joined=new Float32Array(size*2);joined.set(a);joined.set(b,size);const smoothed=new Float32Array(size*2);smoothed.set(edgeSafe(a));smoothed.set(edgeSafe(b),size);
 const loud=Float32Array.from({length:2400},(_,i)=>1.25*Math.sin(2*Math.PI*1000*i/24000));
 return {joined,smoothed,loud,boundaryBefore:Math.abs(joined[size]-joined[size-1]),boundaryAfter:Math.abs(smoothed[size]-smoothed[size-1])};
}
async function makeSynthetic(){const context=new AudioContext({sampleRate:48000});contexts.push(context);await context.resume();const buffer=context.createBuffer(1,48000*8,48000);const data=buffer.getChannelData(0);for(let i=0;i<data.length;i++){const t=i/48000;data[i]=.3*Math.sin(2*Math.PI*1000*t)+.08*Math.sin(2*Math.PI*2700*t)+.03*Math.sin(2*Math.PI*5600*t);}const source=context.createBufferSource();source.buffer=buffer;source.loop=true;const destination=context.createMediaStreamDestination();source.connect(destination);source.start();return destination.stream;}
async function decode(blob){const context=new OfflineAudioContext(1,1,48000);const buffer=await context.decodeAudioData(await blob.arrayBuffer());return stats(buffer.getChannelData(0),buffer.sampleRate);}
async function settleRecorder(recorder,state,failure){const start=performance.now();while(recorder.state!==state){if(cancelled)throw new DOMException('已取消','AbortError');if(recorder.signal.aborted)throw failure()||new Error('录音器已终止');if(performance.now()-start>15000)throw new Error(`录音器未进入${state}状态`);await wait(20);}}
function cleanupPlayback(includeReference=false){document.querySelectorAll('audio').forEach(audio=>{audio.pause();if(audio.id==='reference-play'&&!includeReference)return;audio.removeAttribute('src');audio.load();});for(const url of urls)URL.revokeObjectURL(url);urls=[];if(includeReference&&referenceUrl){URL.revokeObjectURL(referenceUrl);referenceUrl=null;}}
async function cleanup(){cancelled=true;current?.destroy();current=null;cleanupPlayback(true);for(const context of contexts)if(context.state!=='closed')await context.close().catch(()=>{});contexts=[];$('#stop-capture').disabled=true;}
async function trial(name,{synthetic=true,bitrate=64000,echoOff=false,duration=1600,mimeOverride=''}={}){
 let rawParts=[],draft=null,settings={},closeFinished=false,closeStarted=false,closeDoneAt=null,readyAt=null,rawType='',failure=null;
 const nativeClose=AudioContext.prototype.close;
 AudioContext.prototype.close=function(...args){closeStarted=true;const promise=nativeClose.apply(this,args);promise.then(()=>{closeFinished=true;closeDoneAt=performance.now();},()=>{});return promise;};
 navigator.mediaDevices.getUserMedia=async options=>{const captureOptions=echoOff?{audio:{echoCancellation:false},video:false}:options;const stream=synthetic?await makeSynthetic():await getMedia(captureOptions);const actual=stream.getAudioTracks()[0]?.getSettings()||{};settings=Object.fromEntries(['sampleRate','sampleSize','channelCount','echoCancellation','noiseSuppression','autoGainControl','latency'].filter(key=>key in actual).map(key=>[key,actual[key]]));return stream;};
 window.MediaRecorder=class extends NativeRecorder{constructor(stream,options){super(stream,{...options,...(mimeOverride?{mimeType:mimeOverride}:{}),audioBitsPerSecond:bitrate});this.addEventListener('dataavailable',event=>{if(event.data.size)rawParts.push(event.data);});this.addEventListener('stop',()=>{rawType=this.mimeType;});currentTrial={requestedBitrate:bitrate,actualBitrate:this.audioBitsPerSecond,mimeType:this.mimeType};}};
 const host=$('#recorder-host');host.hidden=true;
 const recorder=new VoiceRecorder(host,{permission:()=>false,permissionPrepared:()=>true,fail:message=>{failure=new Error(message);},cancel:()=>{},send:async value=>{draft=value;readyAt=performance.now();}});
 current=recorder;
 try{
  await recorder.start();await settleRecorder(recorder,'recording',()=>failure);host.hidden=true;await wait(duration);if(cancelled)throw new DOMException('已取消','AbortError');recorder.pause();await settleRecorder(recorder,'paused',()=>failure);const readyBeforeClose=closeStarted&&!closeFinished;await recorder.send();if(!draft)throw new Error('没有生成录音文件');
  const raw=new Blob(rawParts,{type:rawType||currentTrial.mimeType});const rawStats=await decode(raw);const parsed=readWav(await draft.file.arrayBuffer());const wavStats=stats(parsed.samples,parsed.rate);
  const chunks=new Map();const manifest=await encryptAudioFile(draft.file,{reserve:async()=>{},status:async()=>({uploadedIndexes:[...chunks.keys()],completed:false}),upload:async(_id,index,bytes)=>{chunks.set(index,bytes);},complete:async()=>{},savePlan:async()=>{}});
  const restored=await decryptAudioFile(manifest,async(_id,index)=>chunks.get(index));const equal=await digest(draft.file)===await digest(restored);
  row(`${name} 原始`,rawStats,`${currentTrial.mimeType}`);row(`${name} 最终 WAV`,wavStats,equal?'加解密逐字节一致':'字节不一致');
  if(cancelled)throw new DOMException('已取消','AbortError');cleanupPlayback();for(const [selector,blob]of [['#raw-play',raw],['#wav-play',draft.file]]){const url=URL.createObjectURL(blob);urls.push(url);$(selector).src=url;}
  return {name,synthetic,settings,...currentTrial,raw:rawStats,wav:wavStats,encryptedRoundtripEqual:equal,close:{readyBeforeClose,closeStarted,closeFinished,readyAt,closeDoneAt}};
 }finally{recorder.destroy();current=null;host.hidden=true;window.MediaRecorder=NativeRecorder;navigator.mediaDevices.getUserMedia=getMedia;AudioContext.prototype.close=nativeClose;for(const context of contexts)if(context.state!=='closed')await context.close().catch(()=>{});contexts=[];}
}
export async function runQualitySuite({synthetic=true,preferOpus=false,echoOff=false}={}){
 if(running)throw new Error('已有对照运行中');running=true;cancelled=false;cleanupPlayback();delete window.__qualityReport;$('#results').replaceChildren();$('#run-synthetic').disabled=true;$('#capture-real').disabled=true;$('#stop-capture').disabled=false;
 const report={baseline:'d0a997d4c03d04be3157c976dfe7c53cb32668ce',codecExperiment:preferOpus?'force internal WebM/Opus; product recorder unchanged':'baseline codec selection',scope:synthetic?'synthetic-stream; no physical microphone or iPhone audio session':'physical microphone; local memory only',ua:navigator.userAgent,trials:[],limits:synthetic?['合成流不触发真实getUserMedia系统音频会话','不能由合成流推断物理录放音质','指标不能代替主观语音清晰度及真机路由验证']:['仅覆盖当前设备本轮短录音','不覆盖间歇性问题、长录音或真实聊天发送路径','指标须与用户试听及设备核验结合']};
 try{
  const variants=synthetic?[['现状 64k',{}],['采集 128k',{bitrate:128000}]]:[['本机麦克风',{duration:4000}]];
  for(const [name,options]of variants){$('#lab-status').textContent=`正在对照：${name}…`;report.trials.push(await trial(name,{synthetic,echoOff,...options,...(preferOpus?{mimeOverride:'audio/webm;codecs=opus'}:{})}));if(cancelled)throw new DOMException('已取消','AbortError');}
  const boundary=boundaryComparison();const baseline=readWav(await encodeVoiceWav(boundary.loud).arrayBuffer());const candidate=readWav(await encodeVoiceWav(edgeSafe(boundary.loud)).arrayBuffer());report.controlledStress={purpose:'受控极端输入，用于证明代码行为，不代表真实录音已经削波',joinJumpBefore:boundary.boundaryBefore,joinJumpAfter:boundary.boundaryAfter,loudBaseline:stats(baseline.samples,baseline.rate),loudCandidate:stats(candidate.samples,candidate.rate)};
  row('超幅压力输入／现状',report.controlledStress.loudBaseline,'直接截断');row('超幅压力输入／候选',report.controlledStress.loudCandidate,'仅衰减 + 5ms 边缘平滑');
  report.outputLimit={fiveMinuteWavBytes:24000*2*300+44,maxBytes:16*1024*1024,sampleRateUnchanged:true};$('#lab-status').textContent='对照完成。结果只适用于当前浏览器与上述输入。';window.__qualityReport=report;$('#lab-report').textContent=JSON.stringify(report,null,2);return report;
 }catch(error){report.error={name:error.name,message:error.message};$('#lab-status').textContent=error.name==='AbortError'?'已停止并清空录音。':`对照失败：${error.message}`;window.__qualityReport=report;$('#lab-report').textContent=JSON.stringify(report,null,2);throw error;}
 finally{running=false;$('#run-synthetic').disabled=false;$('#capture-real').disabled=false;$('#stop-capture').disabled=urls.length===0;}
}
$('#run-synthetic').addEventListener('click',()=>runQualitySuite().catch(()=>{}));$('#run-opus').addEventListener('click',()=>runQualitySuite({preferOpus:true}).catch(()=>{}));$('#capture-real').addEventListener('click',()=>runQualitySuite({synthetic:false,preferOpus:$('#capture-mode').value==='opus',echoOff:$('#capture-mode').value==='echo-off'}).catch(()=>{}));$('#stop-capture').addEventListener('click',()=>void cleanup());
$('#play-reference').addEventListener('click',async()=>{if(running)return;try{if(!referenceUrl){const samples=Float32Array.from({length:24000*3},(_,i)=>{const edge=Math.min(1,i/720,(24000*3-1-i)/720);return .18*Math.sin(2*Math.PI*330*i/24000)*Math.max(0,edge);});referenceUrl=URL.createObjectURL(encodeVoiceWav(samples));$('#reference-play').src=referenceUrl;}await $('#reference-play').play();}catch{$('#lab-status').textContent='基准音播放失败，请再次点击。';}});
document.querySelectorAll('audio').forEach(audio=>audio.addEventListener('play',()=>{if(running){audio.pause();return;}document.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();});}));
document.addEventListener('visibilitychange',()=>{if(document.hidden)void cleanup();});window.addEventListener('pagehide',()=>void cleanup());
window.runQualitySuite=runQualitySuite;
