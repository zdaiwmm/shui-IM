import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startMobileDevelopment } from '../scripts/dev-mobile.mjs';
import { deviceProfile } from '../tools/mobile-debug/plugin.mjs';

async function freePort() {
  const server=createSocketServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
const data=await mkdtemp(path.join(tmpdir(),'quiet-room-mobile-debug-test-'));
let running,browser,ordinary;
try {
  const port=await freePort();let apiPort=await freePort();while(apiPort===port)apiPort=await freePort();
  running=await startMobileDevelopment(['--port',String(port),'--api-port',String(apiPort),'--data-dir',data,'--no-watch'],{quiet:true});
  assert.equal((await (await fetch(`http://localhost:${port}/api/health`)).json()).ok,true);
  browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
  const context=await browser.newContext({viewport:{width:1000,height:1100},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:deviceProfile.userAgent.userAgent});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const cdp=await context.newCDPSession(page);
  await cdp.send('Emulation.setUserAgentOverride',deviceProfile.userAgent);
  await cdp.send('Emulation.setTouchEmulationEnabled',deviceProfile.touch);
  await page.goto(running.url);
  await page.frameLocator('iframe').locator('#create-room').waitFor();
  const frame=page.frames().find(f=>f!==page.mainFrame()&&new URL(f.url()).pathname==='/');assert.ok(frame);
  const initial=await frame.evaluate(()=>({layout:document.documentElement.clientHeight,vv:visualViewport.height,bridge:window.__localSafariBridge?.installed,ua:navigator.userAgent,touch:navigator.maxTouchPoints,dpr:devicePixelRatio}));
  assert.equal(initial.bridge,true);assert.equal(initial.layout,683);assert.equal(initial.vv,683);assert.equal(initial.touch,5);assert.equal(initial.dpr,3);assert.match(initial.ua,/iPhone/);
  assert.equal(await page.locator('#local-address').textContent(),`localhost:${port}`);
  await frame.locator('#create-room').click();
  await frame.locator('.space-profile-overlay').evaluate(async el=>{await Promise.all(el.getAnimations().filter(a=>Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map(a=>a.finished));});
  const footerBefore=await frame.locator('.space-profile-footer').boundingBox();
  const assertStableFooter=async()=>{
    const after=await frame.locator('.space-profile-footer').boundingBox();
    assert.ok(footerBefore&&after&&Object.keys(footerBefore).every(key=>Math.abs(after[key]-footerBefore[key])<=1),JSON.stringify({before:footerBefore,after}));
  };
  await frame.locator('#new-space-name').click();await frame.locator('#form-input-draft').fill('测试空间',{timeout:5000});
  await frame.waitForFunction(()=>visualViewport.height===473);
  assert.equal(await frame.evaluate(()=>document.documentElement.clientHeight),683);
  await assertStableFooter();
  assert.equal(await frame.locator('.space-profile-overlay').evaluate(el=>el.inert),true);
  assert.ok(await frame.locator('.form-input-panel').evaluate(el=>el.getBoundingClientRect().bottom<=visualViewport.height));
  await page.locator('#keyboard [data-key="q"]').click();await page.locator('#keyboard [data-key="Backspace"]').click();
  assert.equal(await frame.locator('#form-input-draft').inputValue(),'测试空间');
  await frame.locator('[data-form-input-done]').click();await page.waitForFunction(()=>document.getElementById('keyboard').hidden);
  assert.equal(await frame.locator('#new-space-name').inputValue(),'测试空间');
  assert.equal(await frame.locator('[data-form-input-cancel]').count(),0);
  await frame.locator('#new-space-name').click();
  const editorBar = await frame.locator('.form-input-panel').evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,color:getComputedStyle(el).backgroundColor}));
  assert.equal(editorBar.left,0); assert.equal(editorBar.right,393);
  assert.equal(editorBar.color,await page.locator('.accessory').evaluate(el=>getComputedStyle(el).backgroundColor));
  // Dismissing without a blur leaves the editor active: a fresh pointer must reopen.
  await page.locator('#keyboard-toggle').click(); await frame.waitForFunction(()=>visualViewport.height===683);
  await frame.locator('#form-input-draft').click(); await frame.waitForFunction(()=>visualViewport.height===473);
  await frame.locator('[data-form-input-done]').click(); await page.waitForFunction(()=>document.getElementById('keyboard').hidden);

  await frame.locator('#new-space-name').click();await frame.locator('#form-input-draft').fill('中文合成');
  await frame.locator('#form-input-draft').dispatchEvent('compositionstart');
  await frame.locator('#form-input-draft').press('Enter');
  await frame.locator('.form-input-panel').dispatchEvent('submit');
  assert.equal(await frame.locator('#form-input-draft').count(),1,'IME and implicit submit cannot finish editing');
  assert.equal(await frame.locator('#new-space-name').inputValue(),'测试空间');
  await frame.locator('#form-input-draft').dispatchEvent('compositionend');
  await frame.locator('#form-input-draft').press('Escape');
  await frame.locator('#new-space-name').click();await frame.locator('#form-input-draft').fill('不应保存');await frame.locator('#form-input-draft').press('Escape');
  assert.equal(await frame.locator('#new-space-name').inputValue(),'测试空间');
  await frame.evaluate(()=>{const label=document.createElement('label');label.textContent='备注';const note=document.createElement('textarea');note.id='note';label.append(note);document.querySelector('#create-space-profile').append(label);});
  await frame.locator('#note').click();await frame.locator('#form-input-draft').fill('第一行\n第二行');
  await page.locator('#keyboard [data-key="Enter"]').click();
  assert.equal(await frame.locator('#form-input-draft').inputValue(),'第一行\n第二行\n');
  await page.locator('#done').click();await page.waitForFunction(()=>document.getElementById('keyboard').hidden);
  assert.equal(await frame.locator('#note').inputValue(),'第一行\n第二行\n');
  await assertStableFooter();
  await frame.locator('#new-space-name').click();await page.locator('#keyboard-height').selectOption('400');
  await frame.waitForFunction(()=>visualViewport.height===393);
  await page.locator('#done').click();await page.locator('#toolbar-toggle').click();
  await frame.waitForFunction(()=>visualViewport.height===763);
  await page.reload();await page.frameLocator('iframe').locator('#create-room').waitFor();
  assert.equal(await page.locator('#keyboard-height').inputValue(),'400');
  assert.equal(await page.locator('#toolbar-toggle').getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('#scale').textContent(),'100%');
  assert.equal(await page.locator('#phone').evaluate(el=>getComputedStyle(el).outlineWidth),'1px');
  const reloaded=page.frames().find(f=>f!==page.mainFrame()&&new URL(f.url()).pathname==='/');
  const heading=await reloaded.locator('.gateway-heading').evaluate(el=>{const box=el.getBoundingClientRect(),p=el.querySelector('p').getBoundingClientRect();return {center:box.x+box.width/2,paragraph:p.x+p.width/2};});
  assert.ok(Math.abs(heading.center-heading.paragraph)<1,'Welcome description centers within the same heading');
  await reloaded.locator('#create-room').click();await reloaded.locator('#new-space-name').click();await reloaded.locator('#form-input-draft').fill('能力与布局验收');await reloaded.locator('[data-form-input-done]').click();await page.waitForFunction(()=>document.getElementById('keyboard').hidden);await reloaded.waitForFunction(()=>visualViewport.height===763);await reloaded.locator('#profile-done').click();
  await reloaded.locator('.gateway-intro .gateway-heading').waitFor();
  assert.equal(await reloaded.locator('.entry-protection,.recovery-explanation').count(),0,'Creation protection uses the confirmed compact name-only layout');
  const sizes=[];
  // Font metrics and password-vs-passkey copy shift the small-art interval.
  // Sample that interval densely instead of pinning it to one desktop font.
  for(const height of [1100,...Array.from({length:21},(_,index)=>900-index*24),360,320,280,240,683]) {
    sizes.push(await reloaded.evaluate(async height=>{document.querySelector('#app').style.height=`${height}px`;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const g=document.querySelector('.gateway-intro'),content=g.querySelector('.gateway-intro-content');return {height,hero:g.dataset.hero,overflow:content.scrollHeight-content.clientHeight,content:content.clientHeight,items:[...content.children].map(n=>({tag:n.className,h:n.getBoundingClientRect().height,margin:getComputedStyle(n).margin}))};},height));
  }
  assert.deepEqual(new Set(sizes.map(s=>s.hero)),new Set(['large','small','none']));
  assert.ok(sizes.find(s=>s.height===683).overflow<=1,'Protection fits one normal simulated Safari screen');
  await reloaded.evaluate(()=>document.querySelector('#app').style.height='');
  await page.goto(`http://localhost:${port}/`);await page.locator('#create-room').waitFor();
  assert.equal(await page.evaluate(()=>typeof window.__localSafariBridge),'undefined');
  ordinary=await createServer({root:process.cwd(),logLevel:'error',optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0,hmr:false}});
  await ordinary.listen();const plain=await (await fetch(`http://localhost:${ordinary.httpServer.address().port}/`)).text();
  assert.ok(!plain.includes('__mobile-debug-bridge'));
  await page.goto(running.url);await page.frameLocator('iframe').locator('#create-room').waitFor();
  const fresh=page.frames().find(f=>f!==page.mainFrame()&&new URL(f.url()).pathname==='/');
  await fresh.locator('#create-room').click();
  await fresh.locator('.space-profile-overlay').evaluate(async el=>{await Promise.all(el.getAnimations().filter(a=>Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map(a=>a.finished));});
  await fresh.locator('#new-space-name').click();await fresh.locator('#form-input-draft').fill('仅草稿');
  await fresh.evaluate(()=>{window.retiredDraft=document.querySelector('#form-input-draft');document.querySelector('#new-space-name').closest('.space-profile-overlay').remove();});
  await fresh.locator('.form-input-overlay').waitFor({state:'detached'});
  assert.equal(await fresh.evaluate(()=>retiredDraft.value),'','Source invalidation wipes the detached editor');
  await page.reload();await page.frameLocator('iframe').locator('#create-room').waitFor();
  const privateFrame=page.frames().find(f=>f!==page.mainFrame()&&new URL(f.url()).pathname==='/');
  await privateFrame.locator('#create-room').click();
  await privateFrame.locator('.space-profile-overlay').evaluate(async el=>{await Promise.all(el.getAnimations().filter(a=>Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map(a=>a.finished));});
  await privateFrame.locator('#new-space-name').click();await privateFrame.locator('#form-input-draft').fill('不应保留的草稿');
  await privateFrame.evaluate(()=>{window.retiredDraft=document.querySelector('#form-input-draft');Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await privateFrame.locator('.form-input-overlay').waitFor({state:'detached'});
  assert.equal(await privateFrame.evaluate(()=>retiredDraft.value),'','Background privacy teardown wipes the draft synchronously');
  assert.deepEqual(errors,[]);
  console.log('MOBILE_DEBUG_OK: real loopback API, alternate ports, isolated data, mobile UA/touch/DPR, synthetic viewport, fixed background, commit/cancel, keyboard, reload, ordinary-dev isolation.');
} finally {
  await browser?.close();await ordinary?.close();await running?.close();await rm(data,{recursive:true,force:true});
}
