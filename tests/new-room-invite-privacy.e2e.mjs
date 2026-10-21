import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { fillFormInput } from './helpers/form-input.mjs';

const dataDir=await mkdtemp(path.join(tmpdir(),'room-invite-privacy-'));
let backend,vite;
try {
  backend=await startServer({host:'127.0.0.1',port:0,dataDir,quiet:true});
  vite=await createServer({root:process.cwd(),configFile:false,logLevel:'error',plugins:[{name:'privacy-test-observer',enforce:'pre',transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});
  await vite.listen();
  for(const [name,engine]of Object.entries(process.env.QR_TRACE_WEBKIT?{webkit}:{chromium,webkit}).flatMap(entry=>entry[0]==='webkit'?Array.from({length:process.env.CI?24:1},()=>entry):[entry])) {
    const browser=await engine.launch(name==='chromium'&&!process.env.CI&&!process.env.CHROME_PATH?{channel:'chrome'}:process.env.CHROME_PATH&&name==='chromium'?{executablePath:process.env.CHROME_PATH}:{});
    try {
      const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});
      const page=await context.newPage(),errors=[],teardownFetchDiagnostics=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>{
        if(name==='webkit'&&error.name==='Fetch API cannot load http'&&/\/unread\//.test(error.message)&&/renderCover/.test(error.stack??'')&&/lockNow/.test(error.stack??''))teardownFetchDiagnostics.push('pagehide unread resource canceled');
        else errors.push({name:error.name,message:error.message,stack:error.stack});
      });
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
      await page.evaluate(()=>{window.creationTrace=[];for(const name of ['renderCreate','leaveSpace','handleCreate','cleanupRuntime','lockNow','showNotice','openSession']){const original=app[name];app[name]=function(...args){const record=phase=>window.creationTrace.push({name,phase,epoch:this.runtimeEpoch,session:!!this.session,covered:this.privacyCovered,creating:!!this.spaceCreationAbort,...(name==='cleanupRuntime'&&phase==='start'?{stack:new Error().stack}:{}),...(name==='showNotice'?{notice:String(args[0])}:{})});record('start');try{const result=original.apply(this,args);if(result?.then){void result.then(()=>record('done'),error=>window.creationTrace.push({name,error:error.message}));return result;}record('done');return result;}catch(error){window.creationTrace.push({name,error:error.message});throw error;}};}});
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
      assert.match(await page.locator('.backup-intro').first().textContent(),/不上传服务器/);
      await page.locator('[data-back]').click();await page.locator('#copy-invite').waitFor();
      await page.locator('#chat-settings').click();await page.locator('#cover-practice-menu').click();
      await page.locator('#cover-enabled').click();await page.waitForFunction(()=>document.querySelector('#cover-enabled')?.getAttribute('aria-checked')==='true');
      await page.locator('#cover-settings-back').click();await page.locator('#chamber-switch-space').waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('#copy-invite').waitFor();
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
      await openList();await createFromList();await page.waitForFunction(()=>document.title==='chamber2',{},{timeout:20000}).catch(async error=>{console.error('NUMBERING_STATE',await page.evaluate(()=>({trace:window.creationTrace,title:document.title,text:document.querySelector('#app').innerText.slice(0,2400),name:app.currentSpaceName,session:app.session?.vault.roomId,code:!!app.session?.vault.spaceRecoveryCode,creating:!!app.spaceCreationAbort})));throw error;});await page.locator('#copy-invite').waitFor();assert.equal(await page.title(),'chamber2');assert.match(await page.locator('[data-personal-guide=cover] small').textContent(),/^已开启 - /);
      await openList();await page.locator(`${list} .space-row.is-selected`).dispatchEvent('contextmenu');await page.locator('#space-rename').click();await fillFormInput(page,page.locator('#space-name'),'chamber900');await page.locator('#space-name-form').evaluate(form=>form.requestSubmit());
      await page.waitForFunction(()=>document.title==='chamber900');
      await page.locator(`${list} .space-row.is-selected`).dispatchEvent('contextmenu');page.once('dialog',dialog=>dialog.accept());await page.locator('#space-delete').click();await page.waitForFunction(()=>document.title==='chamber1');await page.locator('#copy-invite').waitFor();assert.equal(await page.title(),'chamber1');
      await openList();await createFromList();await page.waitForFunction(()=>document.title==='chamber3').catch(async error=>{console.error('THIRD_CREATE_STATE',await page.evaluate(()=>({trace:window.creationTrace,title:document.title,text:document.querySelector('#app').innerText.slice(0,1800),creating:!!app.spaceCreationAbort,locked:app.privacyCovered})));throw error;});await page.locator('#copy-invite').waitFor();assert.equal(await page.title(),'chamber3','Deleted and renamed rooms do not reuse their sequence');
      await page.reload();await page.locator('.cover').waitFor();assert.equal(await page.title(),'Chamber','Locked pages do not expose room names');
      assert.deepEqual(errors,[]);await context.close();
      console.log(`${name}: invitation copy, 24-hour display, credential entry, real guide state, themed switches, local numbering and private tab titles passed; ${teardownFetchDiagnostics.length} known pagehide unread diagnostics recorded.`);
    } finally { await browser.close(); }
  }
} finally { await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true}); }
