import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';

// Real new-room lifecycle and full main.ts cascade, rather than the legacy-only
// desktop fixture. Screenshots contain only this disposable local conversation.
const dataDir=await mkdtemp(path.join(tmpdir(),'quiet-pc-ui-'));
let service, vite, browser;
try {
  service=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
  vite=await createServer({root:process.cwd(),cacheDir:path.join(dataDir,'vite-cache'),configFile:false,logLevel:'error',plugins:[{
    name:'pc-ui-observer',enforce:'pre',transform(code,id) {
      if(id.endsWith('/src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');
    },
  }],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${service.port}`,'/ws':{target:`ws://127.0.0.1:${service.port}`,ws:true}}}});
  await vite.listen();
  for(const engine of [chromium,webkit]) {
    browser=await engine.launch(engine===chromium&&!process.env.CI?(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}):{});
    const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20_000);
    const capture=async name=>{if(process.env.QR_VISUAL_DIR){await mkdir(process.env.QR_VISUAL_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.QR_VISUAL_DIR,`${engine.name()}-${name}.png`)});}};
    const settle=async()=>{await page.waitForFunction(()=>!document.querySelector('.page-transition-outgoing,.local-page-outgoing')&&(window.app.activeSurface!=='chat'||(!window.app.chatViewportMotion?.moving&&!window.app.composerHeightMotion)));};
    const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const fullChat=async()=>{
      await settle();
      assert.equal(await page.locator('.desktop-sidebar,.desktop-sidebar-toggle').count(),0,'New rooms have no persistent sidebar in waiting or active states');
      assert.equal((await page.locator('.chat-shell').boundingBox()).x,0);
      await noOverflow();
    };
    await page.goto(`http://localhost:${vite.httpServer.address().port}`);
    await page.locator('#create-room').click();await page.locator('#copy-invite').waitFor();await fullChat();
    const invite=await page.locator('#invite-url').inputValue();
    const peerContext=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'}), peer=await peerContext.newPage();
    peer.on('pageerror',e=>errors.push(e.message));
    await peer.goto(invite);await peer.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);
    await page.bringToFront();await page.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);await fullChat();
    const send=async(p,text)=>{await p.locator('#message-input').fill(text);await p.locator('#composer').evaluate(form=>form.requestSubmit());};
    await send(peer,'桌面收到的验证消息。'.repeat(55));await page.locator('.message.incoming').waitFor();
    await send(page,'桌面发送的验证消息。'.repeat(55));await peer.locator('.message.incoming').waitFor();
    await page.locator('#message-input').fill('保留的桌面草稿\n第二行');
    await page.evaluate(()=>window.originalInput=document.querySelector('#message-input'));
    for(const size of [{width:1024,height:600},{width:1280,height:800},{width:1440,height:900},{width:1920,height:1080},{width:1366,height:420}]) {
      await page.setViewportSize(size);await fullChat();
      for(const selector of ['.message.incoming','.message.outgoing'])assert.ok((await page.locator(selector).last().boundingBox()).width<=641);
      assert.equal(await page.locator('#message-input').evaluate(node=>node===window.originalInput),true);
      assert.equal(await page.locator('#message-input').inputValue(),'保留的桌面草稿\n第二行');
      await page.locator('#open-chat-tools').click();await page.locator('#chat-tools').waitFor();
      const tools=await page.locator('#chat-tools').boundingBox();assert.ok(tools.y>=0&&tools.y+tools.height<=size.height&&tools.x+tools.width<=size.width,JSON.stringify({size,tools}));
      await page.keyboard.press('Escape');
      await page.locator('#chat-settings').click();await page.locator('.is-settings-sheet.is-visible .settings-desktop-close').waitFor();
      const panel=await page.locator('.is-settings-sheet>.space-drawer').boundingBox();
      assert.ok(panel.width<=720&&panel.width>=600&&panel.y>=0&&panel.y+panel.height<=size.height,JSON.stringify({size,panel}));
      assert.ok(Math.abs(panel.x+(panel.width/2)-(size.width/2))<1,JSON.stringify({size,panel}));
      assert.equal(await page.locator('.settings-dismiss-handle').isVisible(),false);
      await page.locator('#release-history').scrollIntoViewIfNeeded();assert.equal(await page.locator('#release-history').isVisible(),true);
      await page.keyboard.press('Escape');await page.locator('.is-settings-sheet').waitFor({state:'detached'});
    }
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#open-memes').click();await page.locator('.emoji-tile').first().waitFor();
    const expressions=await page.locator('.meme-panel').boundingBox();assert.ok(expressions.x>=0&&expressions.y>=0&&expressions.x+expressions.width<=1440&&expressions.y+expressions.height<=900,JSON.stringify(expressions));
    await page.keyboard.press('Escape');
    const themes=await page.evaluate(async()=>(await import('/src/lib/appearance.ts')).THEMES.map(theme=>theme.id));
    for(const scheme of ['light','dark'])for(const theme of themes) {
      await page.evaluate(async({scheme,theme})=>{const appearance=await import('/src/lib/appearance.ts');appearance.saveTheme(localStorage,theme);appearance.saveColorScheme(localStorage,scheme);appearance.applyAppearance();},{scheme,theme});
      await page.locator('#chat-settings').click();await page.locator('.is-settings-sheet.is-visible .settings-desktop-close').waitFor();
      await page.locator('.settings-desktop-close').focus();await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.is-settings-sheet')),true,'Focus remains in settings');
      await capture(`settings-${theme}-${scheme}`);
      await page.locator('.settings-desktop-close').click();await page.locator('.is-settings-sheet').waitFor({state:'detached'});
      assert.equal(await page.locator('#chat-settings').evaluate(node=>node===document.activeElement),true,'Close restores settings entry focus');
    }
    await page.locator('#chat-settings').click();await page.locator('.is-settings-sheet.is-visible .settings-desktop-close').waitFor();
    for(const [entry,target] of [['#appearance-settings','.appearance-page'],['#manage-devices','.device-management-page'],['#archive-settings','.archive-page'],['#archive-restore','.archive-page']]) {
      await page.locator(entry).scrollIntoViewIfNeeded();
      const scroll=await page.locator('.is-settings-sheet .space-drawer-scroll').evaluate(node=>node.scrollTop);
      await page.locator(entry).click();await page.locator(target).waitFor();await settle();
      const header=await page.locator(`${target}>.subpage-header`).boundingBox();
      assert.ok(header.width<=720&&header.width>=600,JSON.stringify({target,header}));await noOverflow();await capture(target.slice(1));
      await page.locator(`${target} .page-back-button`).click();await page.locator('.is-settings-sheet.is-visible .settings-desktop-close').waitFor();await settle();
      const restored=await page.locator('.is-settings-sheet .space-drawer-scroll').evaluate(node=>node.scrollTop);
      assert.ok(Math.abs(scroll-restored)<2,JSON.stringify({entry,scroll,restored}));
    }
    await page.locator('#chamber-switch-space').click();await page.locator('.is-space-list-page').waitFor();await settle();
    assert.equal(await page.locator('.space-row').count(),1);await noOverflow();await page.locator('.space-return').click();await page.locator('.is-settings-sheet.is-visible .settings-desktop-close').waitFor();
    await page.evaluate(()=>document.documentElement.style.fontSize='200%');
    await page.setViewportSize({width:1024,height:600});await noOverflow();
    await page.locator('#release-history').scrollIntoViewIfNeeded();await capture('settings-large-text');
    await page.locator('.settings-desktop-close').click();await page.locator('.is-settings-sheet').waitFor({state:'detached'});
    await page.evaluate(()=>document.documentElement.style.fontSize='');await page.setViewportSize({width:1440,height:900});
    await page.locator('#open-chat-tools').click();await page.locator('#open-favorites').click();await page.locator('.gallery-shell').waitFor();await settle();
    assert.equal(await page.locator('.desktop-sidebar-toggle').count(),0);
    const tabs=await page.locator('.gallery-tabs').evaluate(node=>({column:getComputedStyle(node).gridColumnStart,rect:node.getBoundingClientRect().toJSON()}));
    assert.equal(tabs.column,'2');assert.ok(tabs.rect.right<=1440);await noOverflow();await capture('gallery');
    await page.locator('#gallery-back').click();await page.locator('#message-input').waitFor();await fullChat();
    // Crossing the breakpoint retains mobile's original settings handle.
    await page.setViewportSize({width:390,height:844});await page.locator('#chat-settings').click();await page.locator('.settings-dismiss-handle').waitFor();
    assert.equal(await page.locator('.settings-desktop-close').isVisible(),false);await noOverflow();
    await page.locator('.settings-dismiss-handle').click();await page.locator('.is-settings-sheet').waitFor({state:'detached'});
    await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>window.app.manualLock());
    assert.equal(await page.locator('.message,.is-settings-sheet,.desktop-sidebar').count(),0,'Privacy cleanup removes private desktop presentation immediately');
    assert.deepEqual(errors,[]);
    await peerContext.close();await context.close();await browser.close();browser=null;
    console.log(`PASS PC UI ${engine.name()}: real new rooms, widths, themes, navigation, drafts, keyboard, gallery, mobile and privacy`);
  }
} finally {await browser?.close();await vite?.close();await service?.close();await rm(dataDir,{recursive:true,force:true});}
