import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server=await createServer({configFile:false,appType:'custom',root:process.cwd(),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false}});
server.middlewares.use('/__voice_message_ui',(_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>');});
const evidence=process.argv[2];if(evidence)await mkdir(evidence,{recursive:true});
try{
 await server.listen();
 for(const[name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true});
  try{
   const context=await browser.newContext({ locale: 'zh-CN',viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
   const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`http://localhost:${server.httpServer.address().port}/__voice_message_ui`);
   await page.evaluate(async()=>{
    for(const sheet of ['styles','chat-layout','gallery','auth-recovery','chat-interactions','cover','voice-messages','call'])await import(`/src/${sheet}.css?import`);
    const {QuietRoomApp}=await import('/src/app.ts');const {encodeVoiceWav}=await import('/src/lib/voice-audio.ts');
    for(const sheet of ['motion','desktop','experience','system-chrome','form-input','chamber-refinements','room-polish'])await import(`/src/${sheet}.css?import`);
    const app=new QuietRoomApp(document.querySelector('#app'));app.updateSafetyCode=async()=>{};app.updateBackgroundNotificationControl=async()=>{};app.flushUiPreferencesSave=()=>{};
    const own={deviceId:'own',role:'creator',status:'active',capabilities:['voice-message-v1']};app.session={vault:{role:'creator',protocol:'legacy-v1',members:[own,{...own,deviceId:'other',role:'joiner'}],identity:{publicBundle:own}}};app.privacyCovered=false;app.runtimeEpoch++;app.runtimeAbort=new AbortController();app.renderChat();
    const wav=encodeVoiceWav(Float32Array.from({length:24000*8},(_,i)=>.2*Math.sin(2*Math.PI*1000*i/24000)));
    app.loadVerifiedFile=async()=>wav;
    for(const[index,durationMs]of [500,6000,30000,60000,300000,18000,18000].entries()){
     const message={seq:index+1,clientMsgId:`voice-geometry-${index}`,senderId:index%2?'own':'other',payload:{v:1,kind:'audio',durationMs,waveform:[1,50,100],audio:{},sentAt:new Date().toISOString()},status:'stored',acceptedAt:new Date().toISOString()};app.messages.set(index+1,message);
    }
    for(const [index,senderId] of ['other','own'].entries())app.messages.set(8+index,{seq:8+index,clientMsgId:'text-reference-'+index,senderId,payload:{v:1,kind:'text',text:'气泡样式参照',sentAt:new Date().toISOString()},status:'stored'});
    app.renderMessages();window.__voiceUiApp=app;window.__voiceTestWav=wav;
   });
   const readGeometry=()=>page.locator('.voice-bubble').evaluateAll(bubbles=>bubbles.map(bubble=>{
    const button=bubble.querySelector('.voice-play'),time=bubble.querySelector('.voice-time'),icon=bubble.querySelector('.voice-sound'),meta=bubble.querySelector('.message-meta');
    const b=button.getBoundingClientRect(),p=bubble.getBoundingClientRect(),t=time.getBoundingClientRect(),i=icon.getBoundingClientRect(),m=meta.getBoundingClientRect();
    const outgoing=Boolean(bubble.closest('.outgoing')),style=getComputedStyle(bubble),reference=getComputedStyle(document.querySelector(outgoing?'.outgoing .text-bubble':'.incoming .text-bubble'));
    return {
     width:b.width,height:b.height,paintedHeight:p.height,seconds:time.textContent,metaBottom:p.bottom-m.bottom,metaRight:p.right-m.right,
     inside:t.left>=p.left&&t.right<=p.right&&m.left>=p.left&&m.right<=p.right&&m.top>=p.top&&m.bottom<=p.bottom,
     sameRow:m.top<i.bottom&&m.bottom>i.top,offset:(m.top+m.bottom-i.top-i.bottom)/2,
     gap:outgoing?i.left-t.right:t.left-i.right,metaGap:m.left-Math.max(t.right,i.right),
     mirrored:getComputedStyle(icon).transform===(outgoing?'matrix(-1, 0, 0, 1, 0, 0)':'none'),
     inheritedSurface:style.backgroundColor===reference.backgroundColor&&style.backgroundImage===reference.backgroundImage,
     round:style.borderTopLeftRadius==='16px',noTail:getComputedStyle(button,'::after').content==='none',
     textColor:getComputedStyle(time).color,iconColor:getComputedStyle(icon).color,
     fullTarget:document.elementFromPoint(m.left+2,(m.top+m.bottom)/2)?.closest('.voice-play')===button,
     normalStatus:bubble.querySelector('.voice-play-status').textContent==='',metaCount:bubble.querySelectorAll('.message-meta').length,
    };
   }));
   const checkGeometry=async(label,hitTargets=false)=>{
    const rows=await readGeometry();
    assert.equal(rows.length,7);
    for(const row of rows){
     assert.equal(row.height,44,label);assert.equal(row.paintedHeight,40,label);
     if(!label.includes('200%'))assert(row.width<=220,label+': total voice width exceeds the 220px cap');
     assert(row.inside&&row.sameRow&&row.mirrored&&row.inheritedSurface&&row.round&&row.noTail&&row.normalStatus,label+': '+JSON.stringify(row));
     assert.equal(row.gap,8,label);assert(row.metaGap>=11.5,label+': '+JSON.stringify(row));
     assert(Math.abs(row.metaBottom-6)<.6&&Math.abs(row.metaRight-8)<.6,label+': '+JSON.stringify(row));assert.equal(row.textColor,row.iconColor,label);
     assert.equal(row.metaCount,1);if(hitTargets)assert(row.fullTarget,label+': timestamp did not hit full voice control');
    }
    assert(rows[0].width>=140&&rows[0].width<rows[1].width,label);
    assert.equal(rows[3].width,rows[4].width,label);assert.equal(rows[5].width,rows[6].width,label);
    assert.equal(rows[0].seconds,'1″');assert.equal(await page.locator('.voice-player input').count(),0);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' horizontal overflow');
    return rows;
   };
   const geometry=[];
   for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:844});
    for(const scheme of ['light','dark'])for(const theme of ['blue','green','purple','apricot','sea','rose','terracotta','lemon','graphite']){
     await page.evaluate(({scheme,theme})=>{document.documentElement.dataset.colorScheme=scheme;document.documentElement.dataset.theme=theme;},{scheme,theme});
     geometry.push({width,scheme,theme,rows:await checkGeometry(name+' '+width+' '+scheme+' '+theme)});
     if(evidence&&width===390&&theme==='blue')await page.screenshot({path:`${evidence}/implemented-${name}-${scheme}.png`,fullPage:true});
    }
   }
   // Enlarged copy must preserve the single row without covering the duration.
   await page.setViewportSize({width:320,height:844});
   await page.evaluate(()=>document.documentElement.style.fontSize='32px');
   for(const scheme of ['light','dark'])for(const theme of ['blue','green','purple','apricot','sea','rose','terracotta','lemon','graphite']){
    await page.evaluate(({scheme,theme})=>{document.documentElement.dataset.colorScheme=scheme;document.documentElement.dataset.theme=theme;},{scheme,theme});
    await checkGeometry(name+' 200% '+scheme+' '+theme);
   }
   await page.evaluate(()=>{document.documentElement.style.fontSize='';document.documentElement.dataset.theme='blue';});
   await page.emulateMedia({forcedColors:'active'});await checkGeometry(name+' forced colors');
   await page.emulateMedia({forcedColors:'none'});
   await page.setViewportSize({width:390,height:844});
   // Bring each row into the viewport to check the metadata's effective hit area.
   for(const bubble of await page.locator('.voice-bubble').all()){
    await bubble.scrollIntoViewIfNeeded();
    assert(await bubble.locator('.message-meta').evaluate(meta=>{
     const r=meta.getBoundingClientRect();return document.elementFromPoint(r.left+2,(r.top+r.bottom)/2)?.closest('.voice-play')===meta.closest('.voice-player').querySelector('.voice-play');
    }),name+': timestamp blocks playback');
   }
   const first=page.locator('[data-client-msg-id=voice-geometry-1] .voice-play');
   const second=page.locator('[data-client-msg-id=voice-geometry-2] .voice-play');
   await page.evaluate(()=>{const app=window.__voiceUiApp,original=app.messages.get(2);app.messages.get(8).payload.text='长引用内容'.repeat(60);app.messages.set(11,{...original,seq:11,clientMsgId:'voice-with-reply',payload:{...original.payload,replyTo:{clientMsgId:'text-reference-0',serverSeq:8,senderId:'other',kind:'text',preview:'长引用内容'}}});app.renderMessages();});
   assert(await page.locator('[data-client-msg-id=voice-with-reply]').evaluate(row=>{
    const b=row.querySelector('.voice-bubble').getBoundingClientRect(),q=row.querySelector('.message-reply-quote').getBoundingClientRect(),i=row.querySelector('.voice-sound').getBoundingClientRect(),m=row.querySelector('.message-meta').getBoundingClientRect();
    return b.width<=220&&q.left>=b.left&&q.right<=b.right&&m.top>=q.bottom&&m.top<i.bottom&&m.bottom>i.top&&m.left>=i.right+12;
   }),name+': a quote displaced voice metadata from its row');
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[data-playing=true]').waitFor();
   await page.waitForTimeout(400);const saved=await page.evaluate(()=>{window.__firstVoice=window.__voiceUiApp.voicePlayback.current;return window.__firstVoice.audio.currentTime;});assert(saved>.1);
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-play[aria-label="播放语音"]').waitFor();const paused=await page.evaluate(()=>window.__firstVoice.audio.currentTime);assert(paused>=saved);
   await second.click();await page.locator('[data-client-msg-id=voice-geometry-2] .voice-player[data-playing=true]').waitFor();assert(await page.evaluate(()=>!window.__firstVoice.url&&!window.__firstVoice.audio.hasAttribute('src')));
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[data-playing=true]').waitFor();assert(await page.evaluate(before=>window.__firstVoice.audio.currentTime>=before-.05,paused),'Switching back lost the paused position');
   await page.evaluate(()=>{const app=window.__voiceUiApp;app.messages.get(2).status='delivered';app.messageEventHistory.set(10,{seq:10,clientMsgId:'voice-read-event',senderId:'other',status:'stored',payload:{v:1,kind:'message-read',target:{serverSeq:2,clientMsgId:'voice-geometry-1',senderId:'own'},sentAt:new Date().toISOString()}});app.renderMessages();});assert.equal(await first.getAttribute('aria-label'),'暂停语音');assert(await page.evaluate(()=>window.__voiceUiApp.voicePlayback.current===window.__firstVoice));
   assert.equal(await page.locator('[data-client-msg-id=voice-geometry-1] .message-delivery').getAttribute('data-state'),'read');
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[data-playback-state=paused]').waitFor();
   assert.equal(await page.locator('[data-client-msg-id=voice-geometry-1] .voice-play-status').textContent(),'');
   await first.focus();await page.keyboard.press('Enter');await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[data-playing=true]').waitFor();
   // A real pending load is cancellable from the timestamp, with no process copy.
   await page.evaluate(()=>{
    const app=window.__voiceUiApp;app.voicePlayback.stop();
    app.loadVerifiedFile=(_session,_audio,signal)=>{window.__voiceLoadSignal=signal;return new Promise(resolve=>window.__resolveVoiceLoad=resolve);};
   });
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[aria-busy=true]').waitFor();
   assert.equal(await page.locator('[data-client-msg-id=voice-geometry-1] .voice-play-status').textContent(),'');
   const stamp=page.locator('[data-client-msg-id=voice-geometry-1] .message-meta');await stamp.scrollIntoViewIfNeeded();const stampBox=await stamp.boundingBox();
   await page.mouse.click(stampBox.x+2,stampBox.y+stampBox.height/2);
   assert(await page.evaluate(()=>window.__voiceLoadSignal.aborted));
   await page.evaluate(async()=>{window.__resolveVoiceLoad(window.__voiceTestWav);await Promise.resolve();await Promise.resolve();});
   assert(await page.evaluate(()=>!window.__firstVoice.url));
   // Genuine failures retain an accessible explanation and the existing retry.
   await page.evaluate(()=>window.__voiceUiApp.loadVerifiedFile=async()=>{throw Error('synthetic audio load failure');});
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[data-error-code]').waitFor();
   assert((await page.locator('[data-client-msg-id=voice-geometry-1] .voice-play-status').textContent()).length>0);
   await page.evaluate(()=>window.__voiceUiApp.loadVerifiedFile=async()=>window.__voiceTestWav);
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[data-playing=true]').waitFor();
   await page.evaluate(()=>{const app=window.__voiceUiApp;app.messages.get(2).status='failed';app.attemptSend=async()=>{window.__voiceSendRetried=true;};app.renderMessages();});
   const retry=page.locator('[data-client-msg-id=voice-geometry-1] .message-retry');await retry.scrollIntoViewIfNeeded();
   // A failed-state render can still be settling the preceding press/FLIP.
   // Wait for finite presentation only; playing waves remain independent.
   await page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const row=document.querySelector('[data-client-msg-id=voice-geometry-1]');await Promise.all(row.getAnimations({subtree:true}).filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));});
   const retryBox=await retry.boundingBox();assert(retryBox.width>=44&&retryBox.height>=44);
   await retry.click();assert(await page.evaluate(()=>window.__voiceSendRetried));
   assert.equal(await page.locator('[data-client-msg-id=voice-geometry-1] .message-pending').count(),1);
   await page.evaluate(()=>{const app=window.__voiceUiApp;app.messages.get(2).status='stored';app.renderMessages();});
   await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await first.locator('.voice-wave-1').evaluate(element=>getComputedStyle(element).animationName),'none');
   await page.evaluate(()=>window.__voiceUiApp.lockNow());assert(await page.evaluate(()=>!window.__firstVoice.url&&!window.__firstVoice.audio.hasAttribute('src')));assert.deepEqual(errors,[]);
   console.log(`${name}: integrated single-row voice geometry, nine palettes, 200% copy, native playback/pause/switch resume, silent load/cancel, failure/retry, receipt preservation and lock cleanup passed (${geometry.length} layouts)`);
   await context.close();
  }finally{await browser.close();}
 }
}finally{await server.close();}
