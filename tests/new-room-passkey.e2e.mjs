import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'new-room-passkey-'));let backend,vite,browser;
try {
 backend=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
 vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[{name:'passkey-observer',enforce:'pre',transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});await vite.listen();
 browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
 const context=await browser.newContext({locale: 'zh-CN'}),page=await context.newPage(),cdp=await context.newCDPSession(page),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,hasPrf:true,automaticPresenceSimulation:true,isUserVerified:true}});
 await context.addInitScript(()=>Object.defineProperty(PublicKeyCredential,'getClientCapabilities',{configurable:true,value:async()=>({'extension:prf':true,userVerifyingPlatformAuthenticator:true})}));
 await context.addInitScript(()=>{const get=navigator.credentials.get.bind(navigator.credentials);window.credentialRequests=0;const create=navigator.credentials.create.bind(navigator.credentials);navigator.credentials.create=async options=>{if(sessionStorage.getItem('cancel-next-create')==='1'){sessionStorage.removeItem('cancel-next-create');throw new DOMException('Cancelled','NotAllowedError');}return create(options);};navigator.credentials.get=async options=>{window.credentialRequests++;if(sessionStorage.getItem('cancel-next-unlock')==='1'){sessionStorage.removeItem('cancel-next-unlock');throw new DOMException('Cancelled','NotAllowedError');}return get(options);};});
 await page.goto(`http://localhost:${vite.httpServer.address().port}/`);await page.locator('#create-room').click();await page.locator('#copy-invite').waitFor();
 const original=await page.evaluate(()=>app.session.vault.roomArchiveV2.key.descriptor.id);
 await page.locator('[data-personal-guide=lock]').click();await page.locator('.auto-lock-page').waitFor();
 assert.equal(await page.locator('[data-idle-toggle]').getAttribute('aria-checked'),'true');
 assert.equal(await page.locator('[data-duration-value]').textContent(),'30 秒');
 const method=await page.evaluate(async()=>{const v=await import('/src/lib/vault.ts');const record=await v.readRoomProtection();if('secret'in record)throw new Error('Automatic key retained');return record.method;});assert.equal(method,'platform');
 await page.evaluate(()=>app.manualLock());assert.equal(await page.locator('#message-input').count(),0);assert.equal(await page.evaluate(()=>!!app.desktopAccess.peek()),false);
 await page.reload();await page.locator('#copy-invite').waitFor();assert.equal(await page.evaluate(()=>window.credentialRequests),1,'Cold reopen automatically requests exactly one assertion');
 await page.evaluate(()=>sessionStorage.setItem('cancel-next-unlock','1'));await page.reload();await page.locator('[data-room-unlock]:not(:disabled)').waitFor();await page.locator('.app-toast').waitFor();
 assert.equal(await page.locator('#message-input').count(),0);assert.equal(await page.evaluate(()=>window.credentialRequests),1);
 if(process.env.QR_VISUAL_DIR){await mkdir(process.env.QR_VISUAL_DIR,{recursive:true});await page.setViewportSize({width:390,height:844});await page.locator('.app-toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(process.env.QR_VISUAL_DIR,'unlock.png')});await page.locator('[data-room-unlock-help]').click();await page.locator('.simple-confirm').waitFor();await page.evaluate(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(process.env.QR_VISUAL_DIR,'unlock-help.png')});await page.locator('[data-close]').click();await page.locator('.simple-confirm').waitFor({state:'detached'});}

 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(await page.evaluate(()=>window.credentialRequests),1,'Cancel does not automatically prompt again');
 await page.locator('[data-room-unlock]').click();await page.locator('#copy-invite').waitFor();assert.equal(await page.evaluate(()=>app.session.vault.roomArchiveV2.key.descriptor.id),original);
 // Cancel replacement after authenticating the old passkey. No settled daily-unlock
 // promise may be retained, and cancellation must leave the old protection intact.
 await page.locator('#chat-settings').click();await page.locator('#room-lock-settings').click();
 const beforeChange=await page.evaluate(async()=>({revision:(await(await import('/src/lib/vault.ts')).readRoomProtection()).revision,requests:window.credentialRequests}));
 await page.evaluate(()=>sessionStorage.setItem('cancel-next-create','1'));await page.locator('[data-change-room-lock]').click();
 await page.locator('.app-toast').waitFor();await page.waitForFunction(n=>window.credentialRequests>n,beforeChange.requests);
 assert.equal(await page.locator('.auto-lock-page').count(),1,'Canceled replacement preserves the origin page');
 assert.equal(await page.evaluate(async()=>(await(await import('/src/lib/vault.ts')).readRoomProtection()).revision),beforeChange.revision);
 await page.locator('#auto-lock-back').click();await page.locator('.is-settings-page[aria-label="设置"]').waitFor();await page.locator('.is-settings-page .space-back:visible, .is-settings-page .settings-dismiss-handle:visible').click();
 await page.evaluate(()=>{sessionStorage.setItem('cancel-next-unlock','1');app.manualLock();});await page.locator('[data-room-unlock]:not(:disabled)').waitFor();await page.locator('.app-toast').waitFor();
 const requests=await page.evaluate(()=>window.credentialRequests);await page.locator('[data-room-unlock]').click();await page.locator('#copy-invite').waitFor();
 assert.equal(await page.evaluate(()=>window.credentialRequests),requests+1,'Unlock after canceled replacement performs a fresh assertion');
 assert.equal(await page.evaluate(()=>app.session.vault.roomArchiveV2.key.descriptor.id),original);
 assert.deepEqual(errors,[]);console.log('New-room WebAuthn PRF application lock passed: optional setup, no automatic secret, manual lock discards desktop return, authenticated reopen preserves archive.');
}finally{await browser?.close();await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true});}
