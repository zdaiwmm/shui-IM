import { legacyCreationPlugin } from './fixtures/legacy-create.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { fillFormInput } from './helpers/form-input.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'qr-space-voice-'));
const backend=await startServer({dataDir,port:0,host:'127.0.0.1',quiet:true});
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[legacyCreationPlugin,{
  name:'observe-app',enforce:'pre',transform(code,id){if(id===path.join(process.cwd(),'src/main.ts'))return code.replace('void app.start();','window.app = app; window.started = app.start();');}
}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});
let browser;
try {
  await vite.listen(); const url=`http://localhost:${vite.httpServer.address().port}/`;
  browser=await chromium.launch(process.env.CI?{}:{channel:'chrome'});
  const pages=[];
  for(let i=0;i<2;i++) {
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
    await context.addInitScript(()=>localStorage.setItem('quiet-room:auto-lock-seconds','300'));
    const page=await context.newPage();page.setDefaultTimeout(20000);pages.push(page);
    const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,hasPrf:true,automaticPresenceSimulation:true,isUserVerified:true}});
    await page.goto(url);await page.evaluate(()=>window.started);
  }
  const [a,b]=pages;
  async function create(page,name,first=false) {
    if(first)await page.locator('#create-room').click();else {await page.locator('#open-spaces').click();await page.locator('#space-create').click();}
    await fillFormInput(page,page.locator('#new-space-name'),name);await page.locator('#profile-done').click();
    if(first){await page.locator('[data-device-verify]').waitFor();assert.equal(await page.locator('#new-device-alias,.entry-support,.recovery-explanation').count(),0);assert.equal(await page.locator('[data-device-verify]').innerText(),'设置应用锁并创建密室');await page.locator('[data-device-verify]').click();}
    await page.locator('#invite-url').waitFor();assert.match(await page.locator('#invite-countdown').innerText(),/剩余 \d\d:\d\d，超时未加入则此密室自动销毁。/);
    return page.locator('#invite-url').inputValue();
  }
  async function join(page,invite) {
    // Real hash routing in the already open browser, retaining its existing spaces.
    await page.evaluate(invite=>{location.hash=new URL(invite).hash;},invite);
    await page.locator('[data-device-verify]').waitFor();assert.equal(await page.locator('#new-device-alias').count(),0);
    assert.equal(await page.locator('.gateway-heading br').count(),1);
    await page.evaluate(()=>{
      const apply=app.applyRoomState.bind(app);
      app.applyRoomState=async(state,mutation)=>{if(app.session.vault.mls?.phase==='awaiting-welcome'&&!window.awaitingVault)window.awaitingVault=structuredClone(app.session.vault);return apply(state,mutation);};
    });
    await page.locator('[data-device-verify]').click();await page.locator('#message-input').waitFor();
  }
  async function ready(){for(const page of pages)await page.waitForFunction(()=>app.session?.vault.mls?.phase==='active'&&app.connectionState==='connected');}
  async function exchange(sender,receiver,text) {
    await sender.locator('#message-input').fill(text);await sender.locator('#message-input').press('Enter');
    await receiver.getByText(text,{exact:true}).waitFor();
  }
  console.log('SPACE_VOICE A creates, B joins');
  const firstInvite=await create(a,'空间一',true);await join(b,firstInvite);await ready();
  await exchange(a,b,'first A to B');await exchange(b,a,'first B to A');
  for(const page of pages){await page.locator('#open-spaces').click();await page.locator('.space-row').first().waitFor();assert.equal(await page.locator('[data-expires]').count(),0);await page.locator('.space-close,.settings-dismiss-handle,.space-return').click();}
  console.log('SPACE_VOICE B creates, A joins');
  const secondInvite=await create(b,'空间二');await join(a,secondInvite);await ready();
  await exchange(b,a,'second B to A');await exchange(a,b,'second A to B');
  for(const page of pages){await page.locator('#open-spaces').click();await page.locator('.space-row').first().waitFor();assert.equal(await page.locator('.space-row').count(),2);assert.equal(await page.locator('[data-expires]').count(),0);await page.locator('.space-close,.settings-dismiss-handle,.space-return').click();}
  // Old source list remains mounted behind creation and is visible throughout pop.
  await b.locator('#open-spaces').click();await b.locator('#space-create').click();
  assert.equal(await b.locator('.is-space-list-page').count(),1);
  await b.locator('#profile-back').waitFor();
  const returned=await b.evaluate(async()=>{
    const samples=[];const end=performance.now()+400;document.querySelector('#profile-back').click();
    do{const profile=document.querySelector('.space-profile-overlay');const list=document.querySelector('.is-space-list-page > .space-drawer');
      const covered=[profile,list].some(node=>{if(!node)return false;const r=node.getBoundingClientRect(),style=getComputedStyle(node);return r.left<=innerWidth/2&&r.right>=innerWidth/2&&r.top<=innerHeight/2&&r.bottom>=innerHeight/2&&Number(style.opacity)>=.99&&style.backgroundColor!=='rgba(0, 0, 0, 0)';});
      samples.push(covered);if(!covered)console.log('RETURN_UNCOVERED_FRAME',JSON.stringify({profile:profile?.getBoundingClientRect().toJSON(),list:list?.getBoundingClientRect().toJSON()}));
      await new Promise(r=>requestAnimationFrame(r));}while(performance.now()<end);
    return {covered:samples.every(Boolean),lists:document.querySelectorAll('.is-space-list-page').length};
  });assert.deepEqual(returned,{covered:true,lists:1});await b.locator('.space-close,.settings-dismiss-handle,.space-return').click();
  // Recreate the exact delayed original-participant snapshot: a welcome plus
  // signed key update arrives before any MLS state was installed in this slot.
  const delayed=await a.evaluate(async()=>{
    const v=await import('/src/lib/vault.ts'),api=await import('/src/lib/api.ts');
    const captured=structuredClone(window.awaitingVault),live=app.session;
    const state=await api.getRoomState(live.vault.roomId,live.vault.accessToken);
    if(captured.roomId!==state.roomId)throw Error('Fixture must use current room');
    if(!state.mlsWelcome||!state.mlsEvents.length)throw Error('Requires a real Welcome plus later signed commit');
    const messages=await api.getWindowMessages(live.vault.roomId,live.vault.accessToken,0);
    const first=messages.find(message=>message.seq===1);if(!first)throw Error('Requires a real encrypted peer message');
    let oldOrderError;try{await (await import('/src/lib/mls.ts')).decryptMlsApplication(captured,first.envelope);}catch(error){oldOrderError=error.message;}
    if(oldOrderError!=='MLS 会话尚未安全建立')throw Error(`Original pre-Welcome decryption failure not reproduced: ${oldOrderError}`);
    app.socket.close();live.vault=captured;app.serverQueue.clear();app.serverQueue.set(1,first);
    await app.drainServerQueue();
    if(live.vault.lastSeq!==0||!app.serverQueue.has(1)||app.privacyCovered)throw Error('Pre-Welcome ciphertext must stay queued without decrypting or locking');
    const corrupt=structuredClone(state);corrupt.mlsWelcome.signature='A'.repeat(86);
    let rejected=false;try{await v.withVaultMutation(live,mutation=>app.applyRoomState(corrupt,mutation));}catch{rejected=true;}
    if(!rejected||live.vault.mls.groupState)throw Error('Invalid Welcome must not install a group or bypass authentication');
    await v.withVaultMutation(live,mutation=>app.applyRoomState(state,mutation));
    await app.drainServerQueue();if(live.vault.lastSeq!==1)throw Error('Queued ciphertext must decrypt after authenticated bootstrap');
    return {phase:live.vault.mls.phase,seq:live.vault.mls.lastEventSeq,expected:state.nextMlsEventSeq,group:!!live.vault.mls.groupState};
  });assert.equal(delayed.phase,'active');assert.equal(delayed.seq,delayed.expected);assert.equal(delayed.group,true);
  console.log('PASS real two-browser reciprocal creation/join/send, joined countdown cleanup, direct list return and Welcome-before-update ordering');
  await browser.close();browser=null;

  // Desktop WebKit with explicit synthetic Chrome-on-iOS device evidence: vendor is not the engine contract.
  browser=await webkit.launch();
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3,
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1'});
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'vendor',{configurable:true,get:()=> 'Google Inc.'});
    Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,get:()=>5});
    // Desktop WebKit omits the iOS-only feature even in mobile emulation.
    // Supply just that feature for this synthetic branding/viewport branch.
    const supports=CSS.supports.bind(CSS);CSS.supports=(...args)=>args[0]==='-webkit-touch-callout'&&args[1]==='none'||supports(...args);
  });
  await page.goto(url);await page.evaluate(()=>window.started);
  const engine=await page.evaluate(()=>({visual:app.visualClientCoordinates,list:app.usesListScrolling,apple:app.appleWebKit,desktop:app.desktopBrowser,ua:navigator.userAgent,vendor:navigator.vendor,touch:navigator.maxTouchPoints,css:CSS.supports('-webkit-touch-callout','none')}));console.log('IOS_BRANCH_DIAGNOSTIC',JSON.stringify(engine));assert.equal(engine.visual,true);assert.equal(engine.list,true);
  await page.locator('#create-room').click();await page.locator('#new-space-name').click();await page.locator('#form-input-draft').fill('颜色验证');
  const inputFill=await page.locator('#form-input-draft').evaluate(el=>{const probe=document.createElement('span');probe.style.background='var(--surface)';el.after(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return {fill:getComputedStyle(el).backgroundColor,expected};});
  await page.locator('[data-form-input-done]').click();await page.locator('.form-input-overlay').waitFor({state:'detached'});
  await page.waitForFunction(()=>{const probe=document.createElement('i');probe.style.color='var(--chrome-top-surface)';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return document.querySelector('#system-chrome-color').content===color;});
  const color=await page.evaluate(()=>({theme:document.querySelector('#system-chrome-color').content,form:!!document.querySelector('.form-input-overlay')}));assert.equal(color.form,false);
  assert.equal(inputFill.fill,inputFill.expected);
  await page.evaluate(()=>{
    app.updateSafetyCode=async()=>{};app.flushUiPreferencesSave=()=>{};app.scheduleUiPreferencesSave=()=>{};app.updateBackgroundNotificationControl=async()=>{};
    app.session={vault:{roomId:'synthetic-chrome-layout',role:'creator',protocol:'legacy-v1',createdAt:new Date().toISOString(),members:[{deviceId:'self',role:'creator',status:'active'},{deviceId:'peer',role:'joiner',status:'active'}],identity:{publicBundle:{deviceId:'self'}}}};
    app.uiPreferences={recoveryReminderDismissed:true,entranceCardDismissed:true};app.runtimeAbort=new AbortController();app.privacyCovered=false;app.renderChat();
  });
  await page.waitForFunction(()=>Math.abs(document.querySelector('#composer').getBoundingClientRect().bottom-visualViewport.height)<1);
  await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>525});visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForFunction(()=>Math.abs(document.querySelector('#composer').getBoundingClientRect().bottom-525)<1);
  const typing=await page.evaluate(async()=>{
    const input=document.querySelector('#message-input'),original=input;let churn=0;
    const observer=new MutationObserver(records=>{for(const record of records)for(const node of [...record.addedNodes,...record.removedNodes])if(node instanceof HTMLTextAreaElement)churn++;});
    observer.observe(input.parentElement,{childList:true});const start=performance.now();
    for(let i=0;i<40;i++){input.value='中文连续输入'.repeat(i%5+1);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));}
    await Promise.resolve();observer.disconnect();return {same:input===original&&input.isConnected,churn,measure:input.parentElement.querySelectorAll('textarea[aria-hidden=true]').length,elapsed:performance.now()-start};
  });assert.equal(typing.same,true);assert.equal(typing.churn,0);assert.equal(typing.measure,1);console.log('TYPING_MEASUREMENT',JSON.stringify(typing));
  console.log('PASS desktop WebKit with synthetic iOS feature/Chrome branding: viewport branch, form surface and restored theme-color');
} finally {await browser?.close();await vite.close();await backend.close();await rm(dataDir,{recursive:true,force:true});}
