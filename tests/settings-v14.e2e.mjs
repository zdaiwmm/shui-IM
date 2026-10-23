import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
import {fillFormInput} from './helpers/form-input.mjs';
import {submitPassword} from './helpers/password.mjs';

const dataDir=await mkdtemp(path.join(tmpdir(),'quiet-settings-v14-'));
let service,vite,browser,page;const errors=[];
try{
  service=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
  vite=await createServer({root:process.cwd(),cacheDir:path.join(dataDir,'vite-cache'),configFile:false,logLevel:'error',plugins:[{name:'settings-v14-observer',enforce:'pre',transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${service.port}`,'/ws':{target:`ws://127.0.0.1:${service.port}`,ws:true}}}});await vite.listen();
  browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write'],viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:3,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1'});
  page=await context.newPage();page.setDefaultTimeout(20_000);page.on('pageerror',error=>errors.push(error.message));
  const capture=async name=>{if(process.env.QR_VISUAL_DIR){await page.waitForFunction(()=>!document.querySelector('.local-page-outgoing,.page-transition-outgoing'));await mkdir(process.env.QR_VISUAL_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.QR_VISUAL_DIR,name+'.png')});}};
  const origin=`http://localhost:${vite.httpServer.address().port}`;
  await page.goto(origin);await page.locator('#create-room').waitFor();
  const originalBrand=await page.locator('.chamber-brand').evaluate(node=>{window.originalCreationBrand=node;return node.getBoundingClientRect().toJSON();});
  const started=Date.now();await page.locator('#create-room').click();await page.locator('.room-creation-page').waitFor();
  assert.equal(await page.evaluate(()=>document.querySelector('.chamber-brand')===window.originalCreationBrand),true,'Creation must reuse the actual welcome brand, not replace the page');
  const creatingBrand=await page.locator('.chamber-brand').evaluate(node=>node.getBoundingClientRect().toJSON());assert.ok(creatingBrand.width>originalBrand.width);assert.equal(await page.locator('.gateway-heading .room-creation-indicator').count(),1);
  assert.equal(await page.locator('.room-creation-overlay,.creation-track').count(),0);
  await capture('creation');
  await page.waitForTimeout(400);assert.equal(await page.locator('.room-creation-spinner').count(),1,'A delayed button label cannot overwrite the loading indicator');
  await page.locator('#copy-invite').waitFor();assert.ok(Date.now()-started>=3600);
  assert.equal(await page.locator('.release-update-reminder,.release-history-page').count(),0);
  await page.locator('#copy-invite').click();await page.locator('.app-toast').filter({hasText:'已复制'}).waitFor();
  const participantLink=await page.evaluate(()=>navigator.clipboard.readText());
  const peerContext=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true}),peer=await peerContext.newPage();peer.on('pageerror',error=>errors.push(error.message));
  await peer.goto(participantLink);await peer.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);await page.bringToFront();await page.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);
  await page.locator('#message-input').fill('synthetic before device admission');await page.locator('#composer').evaluate(form=>form.requestSubmit());await peer.getByText('synthetic before device admission',{exact:true}).waitFor();

  // Started capsule transitions finish; intermediate targets that never painted are coalesced.
  const capsuleProof=await page.evaluate(async()=>{
    const {transitionMediaCapsule,clearMediaCapsule}=await import('/src/lib/media-capsule.ts');
    const host=document.createElement('div');host.style.cssText='position:fixed;top:100px;width:max-content;height:24px;display:flex';host.textContent='准备中';document.body.append(host);
    const painted=[];const draw=text=>()=>{painted.push({text,time:performance.now()});host.querySelector('.media-capsule-content').textContent=text;};
    transitionMediaCapsule(host,draw('上传中'));transitionMediaCapsule(host,draw('加密中'));transitionMediaCapsule(host,draw('已发送'));
    await new Promise(resolve=>setTimeout(resolve,550));const result={painted,text:host.textContent};clearMediaCapsule(host);host.remove();return result;
  });
  assert.deepEqual(capsuleProof.painted.map(x=>x.text),['上传中','已发送']);assert.ok(capsuleProof.painted[1].time-capsuleProof.painted[0].time>=220,JSON.stringify(capsuleProof));
  await page.locator('#open-memes').click();await page.locator('.emoji-tile').first().waitFor();
  await page.locator('[data-shortcut=add]').click();await page.locator('.meme-search-dialog').waitFor();await page.locator('.meme-page-back button').click();await page.locator('.meme-search-dialog').waitFor({state:'detached'});assert.ok(await page.locator('.emoji-tile').count()>0,'Returning from sticker addition restores emoji content');
  await page.locator('#chat-settings').click();
  await page.locator('.space-setting-section>h3').first().waitFor();assert.equal(await page.locator('#notification-settings').count(),0);
  assert.deepEqual(await page.locator('.space-setting-section>h3').allTextContents(),['聊天体验','隐私保护','密室与设备','备份与恢复','关于']);
  const geometry=await page.locator('.settings-dismiss-handle').evaluate(node=>{const h=node.getBoundingClientRect(),line=node.firstElementChild.getBoundingClientRect();return {hit:h.height,width:line.width,height:line.height,bottom:h.bottom-line.bottom};});assert.deepEqual(geometry,{hit:44,width:40,height:5,bottom:8});
  const chrome=async()=>page.evaluate(()=>({meta:document.querySelector('#system-chrome-color').content,paper:getComputedStyle(document.querySelector('.space-drawer')??document.querySelector('.chamber-settings-page')).backgroundColor}));await page.waitForFunction(()=>document.querySelector('#system-chrome-color').content===getComputedStyle(document.querySelector('.space-drawer')).backgroundColor);assert.equal((await chrome()).meta,(await chrome()).paper);
  await page.waitForFunction(()=>Math.abs(document.querySelector('.is-settings-sheet>.space-drawer').getBoundingClientRect().top)<1);
  await capture('settings');
  const settingsFrame=await page.locator('.is-settings-sheet>.space-drawer').evaluate(n=>n.getBoundingClientRect().toJSON());
  await page.locator('#presence-style-setting').click();await page.locator('.is-settings-subpage').waitFor();assert.equal(await page.locator('.is-settings-subpage>.space-drawer:not(.local-page-outgoing) .settings-dismiss-handle').count(),0,'Presence is a complete child page');
  await page.locator('.space-style-choice[data-style=heart]').click();await page.locator('.space-drawer:not(.local-page-outgoing) .space-back').click();await page.locator('.is-settings-sheet').waitFor();
  await page.locator('#chamber-switch-space').click();const listMotion=await page.locator('.is-space-list-page>.space-drawer:not(.local-page-outgoing)').evaluate(n=>n.getAnimations().some(a=>{const f=a.effect.getKeyframes();return f[0]?.transform&&new DOMMatrix(f[0].transform).m41>0;}));assert.equal(listMotion,true,'Switch-room enters from the right with the shared child-page motion');const layers=await page.locator('.is-space-list-page').first().evaluate(n=>{const old=n.querySelector(':scope>.local-page-outgoing'),front=n.querySelector(':scope>.space-drawer:not(.local-page-outgoing)'),panel=old.querySelector(':scope>.space-drawer');for(const a of [...old.getAnimations(),...front.getAnimations()]){a.pause();a.currentTime=140;}const r=panel.getBoundingClientRect();const proof={x:r.x,y:r.y,width:r.width,height:r.height,front:Number(getComputedStyle(front).zIndex),back:Number(getComputedStyle(old).zIndex),stationary:old.getAnimations().every(a=>a.effect.getKeyframes().every(f=>!f.transform||new DOMMatrix(f.transform).m41===0))};for(const a of [...old.getAnimations(),...front.getAnimations()])a.play();return proof;});assert.ok(layers.stationary&&layers.front>layers.back,JSON.stringify(layers));for(const key of ['x','y','width','height'])assert.ok(Math.abs(layers[key]-settingsFrame[key])<1,JSON.stringify({layers,settingsFrame}));assert.equal(await page.locator('.space-drawer-header #space-create').count(),1);assert.equal(await page.locator('.space-drawer-footer #space-create').count(),0);
  await page.locator('.space-return').click();await page.locator('#cover-practice-menu').click();const settingDeparture=await page.locator('#app>.page-transition-outgoing').evaluate(n=>n.getAnimations().every(a=>a.effect.getKeyframes().every(f=>!f.transform||new DOMMatrix(f.transform).m41===0)));assert.equal(settingDeparture,true,'The settings canvas stays still while a child covers it');assert.equal(await page.locator('.cover-style-caption,.cover-list-heading').count(),0);assert.equal(await page.locator('.cover-preview-hotspot').textContent(),'');
  const cover=await page.locator('.cover-preview-canvas').evaluate(n=>({width:n.clientWidth,height:n.clientHeight,viewportWidth:innerWidth,viewportHeight:visualViewport.height}));assert.equal(cover.width,cover.viewportWidth);assert.equal(cover.height,cover.viewportHeight);const coverGap=await page.locator('.cover-style-list').evaluate(n=>n.getBoundingClientRect().top-document.querySelector('.privacy-setting').getBoundingClientRect().bottom);assert.ok(coverGap>=23,`Cover preview gap ${coverGap}`);
  await page.locator('#cover-settings-back').click();await page.locator('.settings-dismiss-handle').click();
  await page.locator('#open-gallery').click();await page.locator('.gallery-empty').waitFor();
  const tabs=await page.locator('.gallery-tabs').evaluate(track=>{const t=track.getBoundingClientRect();return [...track.querySelectorAll('.gallery-tab')].map(tab=>{const r=tab.getBoundingClientRect();return {inset:r.top-t.top,bottom:t.bottom-r.bottom,hit:document.elementFromPoint(r.x+r.width/2,t.top+1)?.closest('.gallery-tab')===tab};});});assert.ok(tabs.every(tab=>tab.inset>=3.9&&tab.bottom>=3.9&&tab.hit),JSON.stringify(tabs));
  for(const tab of ['images','files']){await page.locator(`#gallery-tab-${tab}`).click();await page.locator(`#gallery-grid[aria-labelledby=gallery-tab-${tab}] .gallery-empty`).waitFor();const empty=await page.locator('#gallery-grid').evaluate(grid=>{const e=grid.querySelector('.gallery-empty'),a=grid.getBoundingClientRect(),b=e.getBoundingClientRect(),s=getComputedStyle(grid),center=a.top+parseFloat(s.paddingTop)+(a.height-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom))/2;return {delta:b.top+b.height/2-center,overflow:grid.scrollWidth>grid.clientWidth};});assert.ok(Math.abs(empty.delta+24)<2,JSON.stringify(empty));assert.equal(empty.overflow,false);}
  await page.locator('#gallery-back').click();await page.locator('#chat-settings').click();await page.locator('#archive-settings').click();
  const phrase='a synthetic recovery password';
  await page.locator('[data-card-form] input[name=password]').focus();await page.locator('#form-input-draft').waitFor();
  const backgroundLock=await page.evaluate(async()=>{const node=document.querySelector('.archive-page .backup-content'),top=node.scrollTop,left=node.scrollLeft;node.scrollTop=top+60;node.scrollLeft=left+40;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:120,deltaX:80});node.dispatchEvent(event);return {unchanged:node.scrollTop===top&&node.scrollLeft===left,blocked:event.defaultPrevented};});assert.ok(backgroundLock.unchanged&&backgroundLock.blocked,JSON.stringify(backgroundLock));
  await page.evaluate(value=>{const original=document.querySelector('[data-card-form] input[name=password]');original.value=value;original.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText'}));},phrase);
  assert.equal(await page.locator('#form-input-draft').inputValue(),phrase,'Password-manager replacement must synchronize into the focused editor');
  await page.locator('[data-form-input-done]').click();assert.equal(await page.locator('[data-card-form] input[name=password]').inputValue(),phrase);
  await fillFormInput(page,page.locator('[data-card-form] input[name=confirm]'),phrase);
  await capture('credential-password');
  await page.locator('[data-card-form] button[type=submit]').click();await page.locator('[data-card-image][src]').waitFor();
  await capture('credential-export');
  assert.equal(await page.locator('.numeric-password-page').count(),0,'First credential setup must not insert application-lock setup or verification');
  assert.equal(await page.evaluate(async()=>(await(await import('/src/lib/vault.ts')).readRoomProtection()).method),'automatic');
  await page.evaluate(()=>{Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.savedTestCard=data.files[0];}});});await page.locator('[data-download]').click();await page.waitForFunction(()=>!!window.savedTestCard);const saved=path.join(dataDir,'credential.png');await writeFile(saved,Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await window.savedTestCard.arrayBuffer())))));
  await page.locator('[data-verify]').waitFor();assert.equal(await page.locator('.archive-verification-overlay').count(),0);
  await capture('credential-verify');
  const cardGeometry=await page.locator('[data-verify]').evaluate(form=>{const card=form.querySelector('.archive-material-card'),button=form.querySelector('button[type=submit]'),icon=card.querySelector('.archive-upload>svg'),upload=card.querySelector('.archive-upload'),input=card.querySelector('input[name=password]');const c=card.getBoundingClientRect(),b=button.getBoundingClientRect(),i=icon.getBoundingClientRect(),u=upload.getBoundingClientRect();return {outside:!card.contains(button)&&b.top>=c.bottom,width:Math.abs(b.width-c.width),center:Math.abs(i.x+i.width/2-u.x-u.width/2),inputBorder:getComputedStyle(input).borderTopWidth,placeholder:getComputedStyle(input,'::placeholder').fontWeight};});
  assert.ok(cardGeometry.outside&&cardGeometry.width<1&&cardGeometry.center<1,JSON.stringify(cardGeometry));assert.equal(cardGeometry.inputBorder,'1px');assert.equal(cardGeometry.placeholder,'400');
  const chooserPromise=page.waitForEvent('filechooser');await page.locator('[data-verify] input[type=file]').click();await(await chooserPromise).setFiles(saved);await page.locator('.archive-selected:not([hidden])').waitFor();
  await capture('credential-selected');assert.equal(await page.locator('.archive-file-progress').count(),0);assert.equal(await page.locator('.archive-upload').isVisible(),false);
  assert.match(await page.locator('[data-selected-status]').textContent(),/已就绪/);assert.equal(await page.locator('[data-verify] button[type=submit]').isEnabled(),true);
  await fillFormInput(page,page.locator('[data-verify] input[name=password]'),'wrong synthetic phrase');await page.locator('[data-verify] button[type=submit]').click();await page.locator('.app-toast').filter({hasText:'恢复口令不正确'}).waitFor();assert.equal(await page.evaluate(()=>app.session.vault.roomArchiveV2.cardVerified),false);
  await fillFormInput(page,page.locator('[data-verify] input[name=password]'),phrase);await page.locator('[data-verify] button[type=submit]').click();await page.locator('.archive-managed-status').waitFor();await page.waitForFunction(()=>!document.querySelector('.local-page-outgoing'));assert.equal(await page.locator('.archive-steps').count(),0);assert.equal(await page.locator('[data-download],[data-change-password]').count(),2);
  await capture('credential-managed');
  await page.locator('.archive-page:not(.local-page-outgoing) [data-back]').click();await page.locator('#manage-devices').click();await page.locator('#add-own-device:not([disabled])').waitFor();assert.equal(await page.locator('.device-header #add-own-device').count(),1);const arrow=await page.locator('.device-list-row').first().evaluate(n=>{const a=n.querySelector('.device-chevron').getBoundingClientRect(),c=n.children[1].getBoundingClientRect();return {right:a.left>=c.right,center:Math.abs(a.top+a.height/2-(c.top+c.height/2))};});assert.ok(arrow.right&&arrow.center<1,JSON.stringify(arrow));
  await page.locator('#refresh-devices:not([disabled]) svg').waitFor();await capture('devices');
  await page.locator('#add-own-device').click();assert.equal(await page.locator('.add-own-device-page .primary-button').count(),1);
  // A disposable numeric protection fixture isolates fresh-operation verification
  // from physical WebAuthn setup; no production credentials or authenticators.
  await page.evaluate(async()=>{await(await import('/src/lib/browser-room-key.ts')).protectBrowserRoomKey(await(await import('/src/lib/password-protection.ts')).deriveNumericPasswordCredential('123456'));app.roomLockEnabled=true;});
  let creates=0;page.on('request',request=>{if(request.method()==='POST'&&/\/device-links$/.test(new URL(request.url()).pathname))creates++;});
  await page.locator('#copy-device-join').click();await page.locator('.numeric-password-page').waitFor();assert.equal(creates,0,'No link exists before local verification');await page.locator('[data-numeric-left]').click();await page.locator('.numeric-password-page').waitFor({state:'detached'});assert.equal(creates,0,'Cancellation must not mint a link');
  await page.locator('#copy-device-join').click();await submitPassword(page,'654321');await page.locator('.app-toast').filter({hasText:'密码'}).waitFor();assert.equal(creates,0);await page.waitForTimeout(400);await submitPassword(page,'123456');await page.locator('.app-toast').filter({hasText:'设备链接已复制'}).waitFor();assert.equal(creates,1);
  const link=await page.evaluate(()=>navigator.clipboard.readText());const otherContext=await browser.newContext({viewport:{width:1200,height:850}}),other=await otherContext.newPage();other.on('pageerror',error=>errors.push(error.message));
  await other.goto(link);await page.bringToFront();await other.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false,{},{timeout:30000});assert.equal(await other.locator('.device-inline-code').count(),0,'The authorized short link joins without a safety-code step');
  assert.notEqual(await other.evaluate(()=>app.session.vault.roomArchiveV2.key.descriptor.id),await page.evaluate(()=>app.session.vault.roomArchiveV2.key.descriptor.id));assert.equal(await other.evaluate(async()=>(await(await import('/src/lib/vault.ts')).loadHistory(app.session)).length),0,'A new device receives no pre-join history');
  await page.evaluate(()=>app.renderChat());await page.setViewportSize({width:393,height:568});
  if(!await page.locator('.is-settings-sheet').count())await page.locator('#chat-settings').click();
  await page.locator('.is-settings-sheet .space-drawer-scroll').evaluate(node=>node.scrollTop=node.scrollHeight);await page.waitForTimeout(300);
  const savedScroll=await page.locator('.is-settings-sheet .space-drawer-scroll').evaluate(node=>node.scrollTop);assert.ok(savedScroll>0);
  await page.locator('#archive-settings').click();
  const oldScroll=await page.locator('.page-transition-outgoing .space-drawer-scroll').evaluate(node=>node.scrollTop);assert.ok(Math.abs(oldScroll-savedScroll)<1,'Settings snapshot preserves scroll during child entry');
  await page.locator('.archive-page:not(.local-page-outgoing) [data-back]').click();await page.waitForTimeout(350);assert.equal(await page.locator('.is-settings-sheet .space-drawer-scroll').evaluate(node=>node.scrollTop),savedScroll);
  await page.locator('#help-peer-enter').click();await page.locator('#refresh-devices:not([disabled]) svg').waitFor();
  assert.equal(await page.locator('.device-toolbar strong').textContent(),'对方设备');assert.equal(await page.locator('.device-toolbar #refresh-devices').count(),1);assert.equal(await page.locator('.peer-device-continue').textContent(),'重新生成此密室进入的链接');
  await capture('peer-devices-short');await page.evaluate(()=>document.documentElement.dataset.colorScheme='dark');await capture('peer-devices-dark');await page.evaluate(()=>document.documentElement.dataset.colorScheme='light');
  await page.locator('#device-back').click();await page.locator('#chamber-switch-space').click();await page.locator('#space-create').click();
  await page.locator('.room-creation-page').waitFor();await capture('create-from-room-list');await page.locator('#copy-invite').waitFor();

  assert.deepEqual(errors,[]);console.log('Settings V1.4 real UI passed: continuous creation, groups, page navigation, cover, empty states, autofill, first credential without app lock, file verification and authenticated code-free device admission.');
}catch(error){console.error('V14_PAGE_ERRORS',errors);console.error('V14_UI_STATE',await page?.locator('body').innerText());throw error;}
finally{await browser?.close();await vite?.close();await service?.close();await rm(dataDir,{recursive:true,force:true});}
