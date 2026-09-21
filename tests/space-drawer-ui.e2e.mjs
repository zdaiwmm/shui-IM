import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
const vite = await createServer({ configFile:false,root:process.cwd(),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'drawer-ui-fixture',configureServer(server){server.middlewares.use('/__drawer',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');});}}] });
let browser;
try {
  await vite.listen();
  for (const engine of [chromium,webkit]) {
    browser = await engine.launch(engine === chromium && !process.env.CI ? process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {channel:'chrome'} : {});
    const page = await browser.newPage({viewport:{width:393,height:680}}); page.setDefaultTimeout(8000);
    await page.goto(`http://localhost:${vite.httpServer.address().port}/__drawer`);
    await page.evaluate(async()=>{
      await import('/src/styles.css'); await import('/src/chat-layout.css'); await import('/src/chat-interactions.css'); await import('/src/design-system.css'); await import('/src/spaces.css');
      window.ui = await import('/src/lib/space-drawer.ts');
      window.mount = () => {
        window.abort = new AbortController(); window.renamed = ''; window.closed = 0;
        document.body.className='app-mode'; document.querySelector('#app').innerHTML='<main class="chat-shell"><button id="background">聊天背景</button></main>';
        const spaces = Array.from({length:12},(_,i)=>({roomId:String(i),name:i?'未选中空间 '+i:'两个人的空间',preview:['普通文字预览','[图片]','[视频]','[表情]'][i%4],unread:i===1?105:i===2?3:0}));
        ui.mountSpaceDrawer(document.querySelector('#app'),{spaces,currentRoom:'0',signal:abort.signal,
          actions:Object.entries(ui.spaceIcons).map(([key,icon],i)=>({id:'setting-'+i,label:'设置入口 '+i,icon,group:i<3?'当前空间':i<6?'本机':'关于',run:()=>{}})),
          select:async()=>{},create:async()=>{},rename:async(space,name)=>{window.renamed=name;},styleChanged:style=>{window.style=style;},closed:()=>{window.closed++;}});
      }; mount();
    });
    await page.locator('.space-drawer-overlay.is-visible').waitFor();
    assert.equal(await page.locator('.space-avatar').count(),0);
    assert.equal(await page.locator('[data-space="1"] .space-unread').innerText(),'99+');
    assert.equal(await page.locator('[data-space="1"] .space-unread').getAttribute('aria-label'),'105 条未读消息');
    assert.equal(await page.locator('[data-space="3"] .space-unread').isVisible(),false);
    for (const preview of ['[图片]','[视频]','[表情]']) assert.ok(await page.locator('.space-message-preview').filter({hasText:preview}).count()>0);
    await page.locator('[data-space="1"]').hover();
    assert.equal(await page.locator('[data-space="1"]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
    await page.locator('[data-space="1"]').click({button:'right'});
    await page.locator('#space-rename').click();
    assert.equal(await page.locator('#space-name').evaluate(el=>document.activeElement===el),true);
    await page.locator('#space-name').fill('   '); await page.locator('#space-name-form button[type=submit]').click();
    assert.ok((await page.locator('.space-name-dialog .form-error').innerText()).includes('1–40'));
    await page.locator('#space-name').fill('改后的名称'); await page.locator('#space-name-form button[type=submit]').click();
    await page.locator('.space-name-dialog').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.renamed),'改后的名称');
    assert.equal(await page.locator('[data-space="1"] strong').innerText(),'改后的名称');
    assert.equal(await page.locator('[data-space="1"]').evaluate(el=>document.activeElement===el),true);
    await page.locator('[data-space="1"]').press('F2'); await page.locator('#space-rename').click();
    await page.setViewportSize({width:393,height:320});
    await page.waitForFunction(()=>{const r=document.querySelector('.space-name-dialog').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;});
    await page.locator('#space-name-cancel').click(); await page.locator('.space-name-dialog').waitFor({state:'detached'});
    await page.setViewportSize({width:393,height:680});
    await page.locator('.space-drawer-scroll').evaluate(el=>el.scrollTop=400);
    await page.locator('#space-settings').click();
    assert.equal(await page.locator('#feature-help').count(),0);
    assert.equal(await page.locator('.space-drawer-scroll').evaluate(el=>getComputedStyle(el).scrollbarWidth),'none');
    const icons=await page.locator('.space-setting-icon svg').evaluateAll(nodes=>nodes.map(el=>{const r=el.getBoundingClientRect();return [r.width,r.height,getComputedStyle(el.parentElement).flexShrink];}));
    assert.ok(icons.every(([w,h,shrink])=>w===22&&h===22&&shrink==='0'),JSON.stringify(icons));
    await page.locator('#presence-style-setting').click();
    await page.locator('[data-style=capsule]').focus(); await page.locator('[data-style=capsule]').press('ArrowRight');
    assert.equal(await page.locator('[data-style=heart]').getAttribute('aria-checked'),'true');
    await page.locator('.space-back').click(); assert.ok((await page.locator('#presence-style-setting').innerText()).includes('心动按钮'));
    await page.locator('.space-back').click(); assert.ok(await page.locator('.space-drawer-scroll').evaluate(el=>el.scrollTop>=390));
    await page.locator('.space-close').click(); await page.locator('.space-drawer-overlay').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.style),'heart');
    for (const size of [{width:320,height:480},{width:393,height:390},{width:393,height:852}]) {
      await page.setViewportSize(size); await page.evaluate(()=>mount()); await page.locator('.space-drawer-overlay.is-visible').waitFor();
      await page.emulateMedia({reducedMotion:'reduce'});
      assert.ok(await page.locator('.space-drawer').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;}));
      await page.locator('[data-space="0"]').press('F2'); await page.locator('#space-rename').click();
      await page.evaluate(()=>abort.abort());
      assert.equal(await page.locator('.space-modal-overlay,.space-drawer-overlay,.space-context-overlay').count(),0);
      assert.equal(await page.locator('#background').evaluate(el=>el.closest('[inert]')!==null),false);
    }
    await page.setViewportSize({width:393,height:680});
    await page.evaluate(()=>{
      window.invitesClosed=0; window.inviteAbort=new AbortController();
      ui.mountSpaceInvite(document.querySelector('#app'),{name:'新空间',signal:inviteAbort.signal,content:'<div class="space-invite-body"><h1 id="space-invite-title">邀请对方加入</h1></div><footer class="space-invite-actions"><button>复制邀请链接</button></footer>',closed:()=>{invitesClosed++;}});
    });
    await page.locator('.space-invite-overlay.is-visible').waitFor();
    assert.ok(await page.locator('.space-invite-sheet').evaluate(el=>Math.abs(el.getBoundingClientRect().height/innerHeight-.52)<.01));
    await page.locator('#invite-close').click(); await page.locator('.space-invite-overlay').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>invitesClosed),1);
    console.log(`PASS drawer UI ${engine.name()}: preview/badges, hover, settings icons, keyboard navigation, rename focus, viewport, privacy abort, invitation geometry`);
    await browser.close(); browser=null;
  }
} finally { await browser?.close(); await vite.close(); }
