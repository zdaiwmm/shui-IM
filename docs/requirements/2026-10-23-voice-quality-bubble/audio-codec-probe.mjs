// Synthetic media only. No physical microphone, chat data or production service.
import { webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const directory=path.dirname(fileURLToPath(import.meta.url));
const evidence=path.join(directory,'.evidence');await mkdir(evidence,{recursive:true});
const origin=process.env.VOICE_PROTOTYPE_ORIGIN||'http://127.0.0.1:5283';
const browser=await webkit.launch({headless:true});
try{
 const page=await browser.newPage();await page.goto(`${origin}/docs/requirements/2026-10-23-voice-quality-bubble/prototype/audio.html`);
 const report=await page.evaluate(async()=>{
  const {encodeVoiceWav}=await import('/src/lib/voice-audio.ts');
  const decode=async(bytes)=>{try{const context=new OfflineAudioContext(1,1,48000);const audio=await context.decodeAudioData(bytes.slice(0));return{ok:true,duration:audio.duration,channels:audio.numberOfChannels,sampleRate:audio.sampleRate};}catch(error){return{ok:false,error:error.message};}};
  const known=await encodeVoiceWav(Float32Array.from({length:24000},(_,i)=>.2*Math.sin(2*Math.PI*1000*i/24000))).arrayBuffer();
  const result={scope:'desktop WebKit synthetic codec isolation; no physical mic',ua:navigator.userAgent,knownPcmWav:await decode(known),trials:[]};
  for(const[mime,monitor]of [['audio/mp4',false],['audio/mp4',true],['audio/webm;codecs=opus',true]]){
   if(!MediaRecorder.isTypeSupported(mime)){result.trials.push({mime,monitor,supported:false});continue;}
   const context=new AudioContext({sampleRate:48000});await context.resume();const source=context.createOscillator();source.frequency.value=1000;const gain=context.createGain();gain.gain.value=.2;const destination=context.createMediaStreamDestination();destination.channelCount=1;source.connect(gain).connect(destination);
   if(monitor){const silent=context.createGain();silent.gain.value=0;gain.connect(silent).connect(context.destination);}
   const recorder=new MediaRecorder(destination.stream,{mimeType:mime,audioBitsPerSecond:64000});const chunks=[];recorder.ondataavailable=event=>chunks.push(event.data);
   const stopped=new Promise(resolve=>recorder.onstop=resolve);source.start();recorder.start();await new Promise(resolve=>setTimeout(resolve,2200));recorder.stop();await stopped;
   const blob=new Blob(chunks,{type:recorder.mimeType});const bytes=await blob.arrayBuffer();const decoded=await decode(bytes);
   const element=new Audio();element.muted=true;const url=URL.createObjectURL(blob);const metadata=await new Promise(resolve=>{const timer=setTimeout(()=>resolve({ok:false,error:'metadata timeout'}),2000);element.onloadedmetadata=()=>{clearTimeout(timer);resolve({ok:true,duration:element.duration});};element.onerror=()=>{clearTimeout(timer);resolve({ok:false,error:element.error?.message||`MediaError ${element.error?.code}`});};element.src=url;element.load();});element.removeAttribute('src');element.load();URL.revokeObjectURL(url);
   source.stop();destination.stream.getTracks().forEach(track=>track.stop());await context.close();
   result.trials.push({mime,actualMime:recorder.mimeType,monitor,supported:true,bytes:blob.size,decode:decoded,metadata,data:Array.from(new Uint8Array(bytes))});
  }return result;
 });
 for(let i=0;i<report.trials.length;i++){const trial=report.trials[i];if(!trial.data)continue;const file=path.join(evidence,`webkit-codec-${i}.${trial.mime.includes('mp4')?'mp4':'webm'}`);await writeFile(file,Buffer.from(trial.data));delete trial.data;const info=spawnSync('/usr/bin/afinfo',[file],{encoding:'utf8'});trial.systemDecoder={exitCode:info.status,summary:info.stdout.split('\n').filter(line=>/audio|format|duration|estimated|packets|error/i.test(line)).map(line=>line.trim()),error:info.stderr.trim()};}
 await writeFile(path.join(evidence,'webkit-codec-probe.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
