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
   const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
   const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`http://localhost:${server.httpServer.address().port}/__voice_message_ui`);
   await page.evaluate(async()=>{
    for(const sheet of ['styles','chat-layout','gallery','auth-recovery','chat-interactions','cover','voice-messages','call'])await import(`/src/${sheet}.css?import`);
    const {QuietRoomApp}=await import('/src/app.ts');const {encodeVoiceWav}=await import('/src/lib/voice-audio.ts');
    for(const sheet of ['motion','desktop','experience','system-chrome','form-input','chamber-refinements','room-polish'])await import(`/src/${sheet}.css?import`);
    const app=new QuietRoomApp(document.querySelector('#app'));app.updateSafetyCode=async()=>{};app.updateBackgroundNotificationControl=async()=>{};app.flushUiPreferencesSave=()=>{};
    const own={deviceId:'own',role:'creator',status:'active',capabilities:['voice-message-v1']};app.session={vault:{role:'creator',protocol:'legacy-v1',members:[own],identity:{publicBundle:own}}};app.privacyCovered=false;app.runtimeEpoch++;app.runtimeAbort=new AbortController();app.renderChat();
    const wav=encodeVoiceWav(Float32Array.from({length:24000*8},(_,i)=>.2*Math.sin(2*Math.PI*1000*i/24000)));
    app.loadVerifiedFile=async()=>wav;
    for(const[index,durationMs]of [500,6000,30000,60000,300000].entries()){
     const message={seq:index+1,clientMsgId:`voice-geometry-${index}`,senderId:index%2?'own':'other',payload:{v:1,kind:'audio',durationMs,waveform:[1,50,100],audio:{},sentAt:new Date().toISOString()},status:'stored',acceptedAt:new Date().toISOString()};app.messages.set(index+1,message);
    }app.renderMessages();window.__voiceUiApp=app;
   });
   const geometry=[];
   for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:844});
    for(const scheme of ['light','dark']){
     await page.evaluate(scheme=>document.documentElement.dataset.colorScheme=scheme,scheme);
     const rows=await page.locator('.voice-bubble').evaluateAll(bubbles=>bubbles.map(bubble=>{
      const button=bubble.querySelector('.voice-play'),time=bubble.querySelector('.voice-time'),icon=bubble.querySelector('.voice-sound'),meta=bubble.querySelector('.message-meta');
      const b=button.getBoundingClientRect(),t=time.getBoundingClientRect(),i=icon.getBoundingClientRect(),m=meta.getBoundingClientRect(),style=getComputedStyle(bubble),paint=getComputedStyle(button,'::before'),outgoing=Boolean(bubble.closest('.outgoing'));
      return{width:b.width,height:b.height,paintedHeight:b.height-parseFloat(paint.top)-parseFloat(paint.bottom),transparent:style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.backgroundImage==='none',
       inside:time.parentElement===button&&t.left>=b.left+13&&t.right<=b.right-13&&t.top>=b.top+2&&t.bottom<=b.bottom-2,
       gap:outgoing?i.left-t.right:t.left-i.right,iconDirection:getComputedStyle(icon).transform,expectedDirection:outgoing?'matrix(-1, 0, 0, 1, 0, 0)':'none',
       textColor:getComputedStyle(time).color,iconColor:getComputedStyle(icon).color,metaBelow:m.top>=b.bottom,seconds:time.textContent};
     }));
     assert.equal(rows.length,5);for(const row of rows){assert.equal(row.height,44);assert.equal(row.paintedHeight,40);assert(row.transparent&&row.inside&&row.metaBelow,`${name} ${width} ${scheme}: ${JSON.stringify(row)}`);assert.equal(row.gap,8);assert.equal(row.iconDirection,row.expectedDirection);assert.equal(row.textColor,row.iconColor);}
     assert(rows[0].width>=84&&rows[0].width<rows[1].width);assert.equal(rows[3].width,rows[4].width);assert.equal(rows[0].seconds,'1″');assert.equal(await page.locator('.voice-player input').count(),0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} ${width} ${scheme} horizontal overflow`);geometry.push({width,scheme,rows});
     if(evidence&&width===390)await page.screenshot({path:`${evidence}/implemented-${name}-${scheme}.png`,fullPage:true});
    }
   }
   await page.setViewportSize({width:390,height:844});
   const first=page.locator('[data-client-msg-id=voice-geometry-1] .voice-play');
   const second=page.locator('[data-client-msg-id=voice-geometry-2] .voice-play');
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[data-playing=true]').waitFor();
   await page.waitForTimeout(400);const saved=await page.evaluate(()=>{window.__firstVoice=window.__voiceUiApp.voicePlayback.current;return window.__firstVoice.audio.currentTime;});assert(saved>.1);
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-play[aria-label="播放语音"]').waitFor();const paused=await page.evaluate(()=>window.__firstVoice.audio.currentTime);assert(paused>=saved);
   await second.click();await page.locator('[data-client-msg-id=voice-geometry-2] .voice-player[data-playing=true]').waitFor();assert(await page.evaluate(()=>!window.__firstVoice.url&&!window.__firstVoice.audio.hasAttribute('src')));
   await first.click();await page.locator('[data-client-msg-id=voice-geometry-1] .voice-player[data-playing=true]').waitFor();assert(await page.evaluate(before=>window.__firstVoice.audio.currentTime>=before-.05,paused),'Switching back lost the paused position');
   await page.evaluate(()=>{const app=window.__voiceUiApp;app.messages.get(2).status='delivered';app.renderMessages();});assert.equal(await first.getAttribute('aria-label'),'暂停语音');assert(await page.evaluate(()=>window.__voiceUiApp.voicePlayback.current===window.__firstVoice));
   await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await first.locator('.voice-wave-1').evaluate(element=>getComputedStyle(element).animationName),'none');
   await page.evaluate(()=>window.__voiceUiApp.lockNow());assert(await page.evaluate(()=>!window.__firstVoice.url&&!window.__firstVoice.audio.hasAttribute('src')));assert.deepEqual(errors,[]);
   console.log(`${name}: real voice geometry, native playback/pause/switch resume, receipt preservation and lock cleanup passed (${geometry.length} layouts)`);
   await context.close();
  }finally{await browser.close();}
 }
}finally{await server.close();}
