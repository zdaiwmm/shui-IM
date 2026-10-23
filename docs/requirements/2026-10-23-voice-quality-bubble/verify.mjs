import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, webkit } from 'playwright';

const directory=path.dirname(fileURLToPath(import.meta.url));
const evidence=path.join(directory,'.evidence');await mkdir(evidence,{recursive:true});
const origin=process.env.VOICE_PROTOTYPE_ORIGIN||'http://127.0.0.1:5283';
const base=`${origin}/docs/requirements/2026-10-23-voice-quality-bubble/prototype`;
const profile=JSON.parse(await readFile(new URL('../../../tools/mobile-debug/device-profile.json',import.meta.url),'utf8'));
const summary={baseline:'d0a997d4c03d04be3157c976dfe7c53cb32668ce',engines:[],physicalDevice:false,source:'standalone prototype and isolated imports of baseline recorder/crypto; no application boot'};
for(const [name,engine]of [['chromium',chromium],['webkit',webkit]].filter(([name])=>!process.env.VOICE_VERIFY_ENGINE||process.env.VOICE_VERIFY_ENGINE===name)){
 const browser=await engine.launch({headless:true,args:name==='chromium'?['--autoplay-policy=no-user-gesture-required','--mute-audio']:[]});
 try{
  const errors=[];
  const context=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:3,userAgent:profile.userAgent.userAgent,locale:'zh-CN'});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/index.html`);await page.locator('.selected-message .voice-hit').waitFor();
  const device=await page.evaluate(()=>({ua:navigator.userAgent,touch:navigator.maxTouchPoints,dpr:devicePixelRatio,coarse:matchMedia('(pointer:coarse)').matches,hover:matchMedia('(hover:hover)').matches,width:innerWidth,height:innerHeight,visualViewport:{width:visualViewport.width,height:visualViewport.height}}));
  assert(device.coarse&&device.dpr===3);if(name==='chromium')assert(device.touch>0);assert.equal(device.width,393);
  const widths=[];
  for(const seconds of [1,6,30,60,300]){await page.locator(`[data-seconds="${seconds}"]`).click();const geometry=await page.locator('.selected-message .voice-hit').evaluate(element=>({width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height,paintedHeight:element.getBoundingClientRect().height-4}));widths.push({seconds,...geometry});assert(geometry.width<=220&&geometry.height>=44&&geometry.paintedHeight===40);}
  assert(widths[0].width<widths[1].width&&widths[1].width<widths[2].width&&widths[2].width<widths[3].width);assert.equal(widths[3].width,widths[4].width);
  await page.locator('[data-seconds="6"]').click();
  await page.locator('.selected-message .voice-hit').click();await page.locator('.selected-message .voice-hit[data-state=playing]').waitFor();
  await page.locator('.selected-message .voice-hit').click();assert.equal(await page.locator('.selected-message .voice-hit').getAttribute('data-state'),'paused');
  await page.locator('.selected-message .voice-hit').click();await page.locator('.selected-message .voice-hit[data-state=playing]').waitFor();await page.locator('.demo-message .voice-hit').first().click();await page.locator('.demo-message .voice-hit[data-state=playing]').waitFor();assert.equal(await page.locator('.voice-hit[data-state=playing]').count(),1);
  await page.locator('#state').selectOption('loading');await page.locator('.selected-message .voice-hit').click();assert.equal(await page.locator('.selected-message .voice-hit').getAttribute('data-state'),'idle');
  await page.locator('#state').selectOption('error');await page.locator('.selected-message .voice-hit').click();await page.locator('.selected-message .voice-hit[data-state=playing]').waitFor();
  await page.locator('#lock-demo').click();assert(await page.locator('#privacy-cover').isVisible());assert.equal(await page.locator('.voice-hit[data-state=playing]').count(),0);await page.locator('#unlock-demo').click();assert.equal(await page.locator('.voice-hit[data-state=playing]').count(),0);
  await page.locator('#state').selectOption('send-error');await page.locator('.selected-message .voice-hit').click();await page.locator('.selected-message .voice-hit[data-state=idle]').waitFor();
  await page.locator('#show-reply').check();assert(await page.locator('.selected-message .reply-quote').isVisible());
  await page.locator('#reset-demo').click();const target=page.locator('.selected-message .voice-hit');const bounds=await target.boundingBox();const point={pointerType:'touch',pointerId:81,button:0,clientX:bounds.x+12,clientY:bounds.y+20};await target.dispatchEvent('pointerdown',point);await page.waitForTimeout(550);await target.dispatchEvent('pointerup',point);await target.click();assert(await page.locator('#message-menu').isVisible());assert.equal(await target.getAttribute('data-state'),'idle');await page.locator('#cancel-action').click();await target.click({button:'right'});await page.locator('#delete-action').click();assert.equal(await page.locator('.selected-message').count(),0);
  await page.locator('#reset-demo').click();
  const sizes=[];
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:width===320?568:1000});
   for(const scheme of ['light','dark']){
    await page.evaluate(scheme=>document.documentElement.dataset.colorScheme=scheme,scheme);
    const fit=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,voiceWidths:Array.from(document.querySelectorAll('.voice-hit'),element=>element.getBoundingClientRect().width)}));assert(fit.scrollWidth<=fit.width,`${name} ${width} ${scheme} horizontal overflow`);
    const details=await page.locator('.voice-hit').evaluateAll(buttons=>buttons.map(button=>{const time=button.querySelector('.voice-duration'),icon=button.querySelector('.sound-icon'),b=button.getBoundingClientRect(),t=time.getBoundingClientRect(),i=icon.getBoundingClientRect(),outgoing=Boolean(button.closest('.outgoing'));return{inside:time.parentElement===button&&t.left>=b.left&&t.right<=b.right,gap:outgoing?i.left-t.right:t.left-i.right,direction:getComputedStyle(icon).transform,expected:outgoing?'matrix(-1, 0, 0, 1, 0, 0)':'none'};}));
    for(const detail of details){assert(detail.inside);assert.equal(detail.gap,8);assert.equal(detail.direction,detail.expected);}sizes.push({width,scheme,fit:true,details});
    await page.screenshot({path:path.join(evidence,`${name}-${width}-${scheme}.png`),fullPage:true});
   }
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#state').selectOption('playing');assert.equal(await page.locator('.selected-message .wave-1').evaluate(element=>getComputedStyle(element).animationName),'none');
  await page.locator('#reset-demo').click();await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{const items=Array.from(document.querySelectorAll('h1,h2,p,label,button,output,dt,dd,select,.voice-duration,.voice-meta,.composer-field,.preview-caption')).map(element=>({element,size:parseFloat(getComputedStyle(element).fontSize)}));for(const{element,size}of items)element.style.fontSize=`${size*2}px`;});assert(await page.locator('#reset-demo').isVisible());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(evidence,`${name}-text-200.png`),fullPage:true});await page.reload();
  const lab=await context.newPage();lab.on('pageerror',error=>errors.push(error.message));await lab.goto(`${base}/audio.html`);await lab.locator('#run-synthetic').waitFor();
  await lab.locator('#run-synthetic').click();await lab.waitForFunction(()=>window.__qualityReport,{timeout:60000});const audio=await lab.evaluate(()=>window.__qualityReport);
  if(!audio.error){assert.equal(audio.trials.length,2);for(const trial of audio.trials){assert(trial.encryptedRoundtripEqual);assert.equal(trial.wav.sampleRate,24000);assert(trial.wav.durationMs>1000);assert.equal(trial.wav.clippedPercent,0);}assert(audio.controlledStress.loudBaseline.clippedPercent>0);assert.equal(audio.controlledStress.loudCandidate.clippedPercent,0);assert(audio.controlledStress.joinJumpBefore>1);assert.equal(audio.controlledStress.joinJumpAfter,0);assert(audio.outputLimit.fiveMinuteWavBytes<audio.outputLimit.maxBytes);}
  else {assert.equal(name,'webkit','Chromium audio must complete');assert.equal(audio.error.message,'Decoding failed','Unexpected WebKit failure');}
  assert.equal(errors.length,0,errors.join('\n'));
  await writeFile(path.join(evidence,`${name}-audio.json`),JSON.stringify(audio,null,2)+'\n');await lab.screenshot({path:path.join(evidence,`${name}-audio.png`),fullPage:true});
  const result={name,version:browser.version(),device,deviceLimit:device.touch===0?'maxTouchPoints=0; viewport/coarse-pointer simulation only, no touch validation':null,widths,sizes,checks:['duration geometry','loading cancellation','play/pause/resume','single player','load retry','send retry','lock stop and no auto resume','reply','long press consumes click','context menu delete/reset','responsive light/dark','reduced motion','doubled visible text overflow'],audioStatus:audio.error?'INCOMPLETE_NATIVE_DECODE_FAILED':'PASS_SYNTHETIC',audio:audio.trials.map(trial=>({name:trial.name,actualBitrate:trial.actualBitrate,raw:trial.raw,wav:trial.wav,roundtrip:trial.encryptedRoundtripEqual,close:trial.close})),audioError:audio.error||null,controlledStress:audio.controlledStress||null,errors};summary.engines.push(result);await writeFile(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(`${name}: UI checks passed; audio=${result.audioStatus}`);
  await context.close();
 }finally{await browser.close();}
}
await writeFile(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(`Evidence: ${evidence}`);
