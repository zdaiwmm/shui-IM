import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { fillFormInput } from './helpers/form-input.mjs';
import { observeExitRequests } from './helpers/webkit-exit-diagnostics.mjs';
import { verifyExpiredInviteEntry } from './fixtures/expired-invite-entry.mjs';

const dataDir=await mkdtemp(path.join(tmpdir(),'room-invite-privacy-'));
let backend,vite,delayNextDocument=false;
const allErrors=[];
try {
  backend=await startServer({host:'127.0.0.1',port:0,dataDir,quiet:true});
  vite=await createServer({root:process.cwd(),configFile:false,logLevel:'error',plugins:[{name:'privacy-test-observer',configureServer(server){server.middlewares.use((req,res,next)=>{if(delayNextDocument&&req.url==='/'){delayNextDocument=false;setTimeout(next,180);return;}if(req.url!=='/__native-keygen-probe')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated native key generation</title>');});},enforce:'pre',transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('void app.start();', 'window.app=app;const startBrowserAccess=app.startBrowserAccessServices.bind(app);app.startBrowserAccessServices=(session,signal)=>{const promise=startBrowserAccess(session,signal);window.invitePrivacyServices={session,promise};return promise;};void app.start();');if(id.endsWith('/src/app.ts'))return code.replace("})().catch(cause => { if (!this.privacyCovered) this.showNotice(cause instanceof Error ? cause.message : '创建失败，请重试', 'error'); })", "})().catch(cause => { window.creationTrace?.push({error:cause?.message,stack:cause?.stack,epoch:this.runtimeEpoch,session:!!this.session,covered:this.privacyCovered}); if (!this.privacyCovered) this.showNotice(cause instanceof Error ? cause.message : '创建失败，请重试', 'error'); })");}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});
  await vite.listen();
  for(const [name,engine]of Object.entries(process.env.QR_TRACE_WEBKIT?{webkit}:{chromium,webkit}).flatMap(entry=>entry[0]==='webkit'?Array.from({length:process.env.CI?3:1},()=>entry):[entry])) {
    await backend.close();await rm(dataDir,{recursive:true,force:true});backend=await startServer({host:'127.0.0.1',port:backend.port,dataDir,quiet:true});
    let diagnosticPage;
    const browser=await engine.launch(name==='chromium'&&!process.env.CI&&!process.env.CHROME_PATH?{channel:'chrome'}:process.env.CHROME_PATH&&name==='chromium'?{executablePath:process.env.CHROME_PATH}:{});
    try {
      await verifyExpiredInviteEntry(browser, `http://127.0.0.1:${vite.httpServer.address().port}`);
      const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});
      const page=await context.newPage(),exitEvidence=await observeExitRequests(page),errors=[],teardownFetchDiagnostics=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>{
        errors.push(exitEvidence.capture(error));
      });
      await context.addInitScript(()=>{const generate=SubtleCrypto.prototype.generateKey;SubtleCrypto.prototype.generateKey=function(algorithm,...args){if(window.blockNativeMlsKeyOperations&&['Ed25519','X25519'].includes(typeof algorithm==='string'?algorithm:algorithm.name))return Promise.reject(new DOMException('Injected WebKit Curve25519 generation failure','OperationError'));return Reflect.apply(generate,this,[algorithm,...args]);};const importKey=SubtleCrypto.prototype.importKey;SubtleCrypto.prototype.importKey=function(format,data,algorithm,...args){if(window.blockNativeMlsKeyOperations&&format==='pkcs8'&&(typeof algorithm==='string'?algorithm:algorithm.name)==='Ed25519')return Promise.reject(new DOMException('Injected WebKit Ed25519 private import failure','DataError'));return Reflect.apply(importKey,this,[format,data,algorithm,...args]);};});
      diagnosticPage=page;
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__native-keygen-probe`);
      const nativeProbe=await page.evaluate(async()=>{const results={};for(const [algorithm,usages]of [['Ed25519',['sign','verify']],['X25519',['deriveBits']]]){const counts={success:0,errors:{},signatures:0,signatureErrors:{}};for(let i=0;i<64;i++){try{const pair=await crypto.subtle.generateKey(algorithm,true,usages);counts.success++;if(algorithm==='Ed25519'){try{const encoded=await crypto.subtle.exportKey('pkcs8',pair.privateKey);const key=await crypto.subtle.importKey('pkcs8',encoded,algorithm,false,['sign']);const message=new Uint8Array([1,2,3]);const signature=await crypto.subtle.sign(algorithm,key,message);if(!await crypto.subtle.verify(algorithm,pair.publicKey,signature,message))throw new Error('SignatureMismatch');counts.signatures++;}catch(error){counts.signatureErrors[error.name]=(counts.signatureErrors[error.name]??0)+1;}}}catch(error){counts.errors[error.name]=(counts.errors[error.name]??0)+1;}}results[algorithm]=counts;}return results;});
      console.log('ISOLATED_NATIVE_KEYGEN',name,JSON.stringify(nativeProbe));
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
      await page.evaluate(()=>{window.creationTrace=[];for(const type of ['visibilitychange','pagehide','blur','focus'])window.addEventListener(type,event=>{if(event.target!==window&&event.target!==document)return;window.creationTrace.push({event:type,hidden:document.hidden,epoch:app.runtimeEpoch,session:!!app.session,covered:app.privacyCovered,creating:!!app.spaceCreationAbort});},{capture:true});});
      await page.locator('#create-room').click();await page.locator('#copy-invite').waitFor();
      assert.equal(await page.title(),'chamber1');
      assert.equal(await page.locator('#copy-invite').textContent(),'复制密室加入链接');
      assert.equal(await page.locator('.chamber-invite-hero > p').textContent(),'将密室加入链接，发给你想说悄悄话的人。');
      assert.match(await page.locator('#new-room-invite-countdown').textContent(),/链接有效时间：(24:00:00|23:59:\d{2})/);
      for(const step of ['cover','lock'])assert.match(await page.locator(`[data-personal-guide=${step}] small`).textContent(),/^未开启 - /);
      assert.match(await page.locator('[data-personal-guide=archive] small').textContent(),/^未设置 - /);
      // WebKit can suppress a synthetic mouse click during automatic scroll.
      // Settle the real mobile target in view, then send a touch activation.
      const credentialEntry=page.locator('[data-personal-guide=archive]');
      await credentialEntry.scrollIntoViewIfNeeded();
      await credentialEntry.tap();
      await page.locator('[data-card-form]').waitFor();assert.equal(await page.locator('.backup-heading h1').textContent(),'恢复凭证');
      assert.equal(await page.locator('[data-sync]').count(),0,'Guide opens the credential form directly');
      assert.equal(await page.locator('.backup-intro').first().textContent(),'凭证密码仅用于本浏览器加密，不上传服务器。');assert.deepEqual(await page.locator('.archive-steps li > span').allTextContents(),['设置密码','导出凭证','回验原图']);
      await page.locator('[data-back]').click();await page.locator('#copy-invite').waitFor();
      await page.locator('#chat-settings').click();await page.locator('#cover-practice-menu').click();
      await page.locator('#cover-enabled').click();await page.waitForFunction(()=>document.querySelector('#cover-enabled')?.getAttribute('aria-checked')==='true');
      await page.locator('#cover-settings-back').click();await page.locator('#chamber-switch-space').waitFor();await page.locator('.settings-dismiss-handle').click();await page.locator('#copy-invite').waitFor();
      assert.match(await page.locator('[data-personal-guide=cover] small').textContent(),/^已开启 - /);
      // Populate existing protection through the actual crypto module; passkey
      // creation, automatic assertion and cancellation are tested separately.
      await page.evaluate(async()=>{const k=await import('/src/lib/browser-room-key.ts'),p=await import('/src/lib/password-protection.ts');await k.protectBrowserRoomKey(await p.deriveNumericPasswordCredential('927451'));app.roomLockEnabled=true;app.renderChat();});
      assert.match(await page.locator('[data-personal-guide=lock] small').textContent(),/^已开启 - /);
      await page.locator('[data-personal-guide=lock]').click();await page.locator('.auto-lock-page').waitFor();
      assert.equal(await page.locator('[data-remove-room-lock]').getAttribute('role'),'switch');
      assert.equal(await page.locator('[data-remove-room-lock]').getAttribute('aria-checked'),'true');
      const buttons=await page.locator('.room-lock-actions button').evaluateAll(nodes=>nodes.map(n=>({w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height})));
      assert.ok(buttons.every(r=>r.w>=44&&r.h>=44),JSON.stringify(buttons));
      if(process.env.QR_VISUAL_DIR){await mkdir(process.env.QR_VISUAL_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.QR_VISUAL_DIR,`${name}-auto-lock.png`)});}
      await page.locator('#auto-lock-back').click();await page.locator('.auto-lock-page').waitFor({state:'detached'});
      for(const theme of ['blue','green','purple','apricot'])for(const scheme of ['light','dark']) {
        await page.evaluate(async({theme,scheme})=>{const a=await import('/src/lib/appearance.ts');localStorage.setItem('quiet-room:appearance',theme);a.saveColorScheme(localStorage,scheme);a.applyAppearance();},{theme,scheme});
        const colors=await page.locator('[data-personal-guide=lock] .guide-configured').evaluate(n=>{const probe=document.createElement('span');probe.style.color='var(--accent)';n.append(probe);const expected=getComputedStyle(probe).color,actual=getComputedStyle(n).color;probe.remove();return {expected,actual};});
        assert.equal(colors.actual,colors.expected);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      }
      if(process.env.QR_VISUAL_DIR){await mkdir(process.env.QR_VISUAL_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.QR_VISUAL_DIR,`${name}-guide.png`)});}
      for(const [width,height,scale]of [[320,568,1],[390,844,2]]){await page.setViewportSize({width,height});await page.evaluate(scale=>document.documentElement.style.fontSize=`${16*scale}px`,scale);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
      await page.evaluate(()=>document.documentElement.style.removeProperty('font-size'));await page.setViewportSize({width:390,height:844});
      const list='.is-space-list-page:not(.space-sidebar)';
      const openList=async()=>{await page.locator('#chat-settings').click();await page.locator('#chamber-switch-space').click();await page.locator(`${list} .space-row`).first().waitFor();};
      // Settle scrolling before native touch activation, as for the credential entry above.
      const createFromList=async()=>{const button=page.locator(`${list} #space-create`);await button.scrollIntoViewIfNeeded();await button.tap();};
      assert.equal(await page.evaluate(async()=>{window.blockNativeMlsKeyOperations=true;for(const [algorithm,usages]of [['Ed25519',['sign','verify']],['X25519',['deriveBits']]]){try{await crypto.subtle.generateKey(algorithm,true,usages);return false;}catch(error){if(error.name!=='OperationError')return false;}}try{await crypto.subtle.importKey('pkcs8',new Uint8Array([0]),'Ed25519',false,['sign']);return false;}catch(error){return error.name==='DataError'&&error.message==='Injected WebKit Ed25519 private import failure';}}),true,'The failing native generator must be active before creating the next room');
      await openList();await createFromList();await page.waitForFunction(()=>document.title==='chamber2',{},{timeout:20000}).catch(async error=>{console.error('NUMBERING_STATE',await page.evaluate(()=>({trace:window.creationTrace,title:document.title,text:document.querySelector('#app').innerText.slice(0,2400),name:app.currentSpaceName,session:app.session?.vault.roomId,code:!!app.session?.vault.spaceRecoveryCode,creating:!!app.spaceCreationAbort})));throw error;});await page.locator('#copy-invite').waitFor();assert.equal(await page.title(),'chamber2');assert.match(await page.locator('[data-personal-guide=cover] small').textContent(),/^已开启 - /);
      await openList();await page.locator(`${list} .space-row.is-selected`).dispatchEvent('contextmenu');await page.locator('#space-rename').click();await fillFormInput(page,page.locator('#space-name'),'chamber900');await page.locator('#space-name-form').evaluate(form=>form.requestSubmit());
      await page.waitForFunction(()=>document.title==='chamber900');
      await page.locator(`${list} .space-row.is-selected`).dispatchEvent('contextmenu');page.once('dialog',dialog=>dialog.accept());await page.locator('#space-delete').click();await page.waitForFunction(()=>document.title==='chamber1');await page.locator('#copy-invite').waitFor();assert.equal(await page.title(),'chamber1');
      await openList();await createFromList();await page.waitForFunction(()=>document.title==='chamber3').catch(async error=>{console.error('THIRD_CREATE_STATE',await page.evaluate(()=>({trace:window.creationTrace,title:document.title,text:document.querySelector('#app').innerText.slice(0,1800),creating:!!app.spaceCreationAbort,locked:app.privacyCovered})));throw error;});await page.locator('#copy-invite').waitFor();assert.equal(await page.title(),'chamber3','Deleted and renamed rooms do not reuse their sequence');
      // Settle actual preparation, then end this runtime before testing a cold
      // reload. In-flight-request cancellation has separate controlled coverage.
      await page.waitForFunction(()=>window.invitePrivacyServices?.session===app.session);
      await page.evaluate(async()=>{await window.invitePrivacyServices.promise;app.lockNow();await app.preferenceSaveChain;});
      delayNextDocument=true;await page.reload();await page.locator('.cover').waitFor();assert.equal(await page.title(),'Chamber','Locked pages do not expose room names');
      const unreadLifecycle=await page.evaluate(()=>{const counter=app.unreadCounter,refresh=counter.refresh;let calls=0;counter.refresh=async()=>{calls++;};try{window.dispatchEvent(new PageTransitionEvent('pagehide'));window.dispatchEvent(new Event('focus'));const leaving=calls;window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));return {leaving,returned:calls};}finally{counter.refresh=refresh;}});
      assert.equal(unreadLifecycle.leaving,0,'Exiting must not start new unread requests');assert.ok(unreadLifecycle.returned>0,'Returning must resume unread refresh');
      await context.close();for(const error of errors){if(name==='webkit'&&exitEvidence.confirmsNativeExit(error))teardownFetchDiagnostics.push('confirmed old-document read rejected during navigation');else allErrors.push(error);}
      console.log(`${name}: invitation copy, 24-hour display, credential entry, real guide state, themed switches, local numbering and private tab titles passed; ${teardownFetchDiagnostics.length} confirmed native exit diagnostics recorded.`);
    } catch(error){console.error('CREATE_DIAGNOSTIC',JSON.stringify(await diagnosticPage?.evaluate(()=>({trace:window.creationTrace,title:document.title,epoch:app.runtimeEpoch,session:!!app.session,covered:app.privacyCovered,creating:!!app.spaceCreationAbort,notice:document.querySelector('#app-toast')?.textContent})).catch(()=>null)));throw error;} finally { await browser.close(); }
  }
  assert.deepEqual(allErrors,[]);
} finally { await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true}); }
