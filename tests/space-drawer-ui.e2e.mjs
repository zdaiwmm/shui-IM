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
      await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
      window.ui = await import('/src/lib/space-drawer.ts');
      window.mount = (count=12,initialSettings=false) => {
        window.abort?.abort(); window.abort = new AbortController(); window.renamed = ''; window.closed = 0;
        document.body.className='app-mode'; document.querySelector('#app').innerHTML='<main class="chat-shell"><button id="background">聊天背景</button></main>';
        const spaces = Array.from({length:count},(_,i)=>({roomId:String(i),name:i?'未选中空间 '+i:'两个人的空间',preview:['普通文字预览','[图片]','[视频]','[表情]'][i%4],unread:i===1?105:i===2?3:0}));
        ui.mountSpaceDrawer(document.querySelector('#app'),{spaces,currentRoom:'0',signal:abort.signal,initialSettings,
          actions:Object.entries(ui.spaceIcons).map(([key,icon],i)=>({id:'setting-'+i,label:'设置入口 '+i,icon,group:i<3?'当前空间':i<6?'本机':'关于',run:()=>{}})),
          select:async()=>{},create:async()=>{},rename:async(space,name)=>{window.renamed=name;},styleChanged:style=>{window.style=style;},closed:()=>{window.closed++;}});
      }; mount(); window.listStart=document.querySelector('.space-drawer').getBoundingClientRect().left;
    });
    await page.locator('.space-drawer-overlay.is-visible').waitFor();
    assert.ok(await page.evaluate(()=>window.listStart<=-392),'Space list must enter from the left');
    assert.equal(await page.locator('.space-avatar').count(),12);
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
    await page.locator('.space-drawer:not(.local-page-outgoing) > .space-drawer-scroll').evaluate(el=>{el.scrollTop=400;window.listPosition=el.scrollTop;});
    const settingsStart=await page.evaluate(()=>{mount(12,true);return document.querySelector('.space-drawer').getBoundingClientRect().top;});
    assert.ok(settingsStart>=679,'First settings entry must begin below the viewport');
    await page.locator('.space-drawer-overlay.is-visible').waitFor();
    await page.locator('.space-drawer').evaluate(async panel=>{await Promise.all(panel.getAnimations().map(animation=>animation.finished));});
    assert.equal(await page.locator('#feature-help').count(),0);
    assert.equal(await page.locator('.space-drawer:not(.local-page-outgoing) > .space-drawer-scroll').evaluate(el=>getComputedStyle(el).scrollbarWidth),'none');
    const icons=await page.locator('.space-setting-icon svg').evaluateAll(nodes=>nodes.map(el=>{const r=el.getBoundingClientRect(),tile=el.parentElement.getBoundingClientRect();return [r.width,r.height,tile.width,tile.height,getComputedStyle(el.parentElement).flexShrink];}));
    assert.ok(icons.every(([w,h,tileWidth,tileHeight,shrink])=>w===17&&h===17&&tileWidth===24&&tileHeight===24&&shrink==='0'),JSON.stringify(icons));
    assert.equal(await page.locator('.space-back').count(),0);
    assert.equal(await page.locator('.settings-sheet-handle').count(),0);
    await page.waitForFunction(()=>Math.abs(document.querySelector('.space-drawer').getBoundingClientRect().top)<1);
    await page.locator('.space-close').click(); await page.locator('.space-drawer-overlay').waitFor({state:'detached'});
    await page.evaluate(()=>mount(12,true));
    await page.locator('#presence-style-setting').click();
    await page.locator('[data-style=capsule]').focus(); await page.locator('[data-style=capsule]').press('ArrowRight');
    await page.locator('.space-drawer-overlay').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.style),'heart', 'style applies before closing');
    assert.equal(await page.locator('#space-style-done').count(),0);
    assert.equal(await page.evaluate(()=>window.style),'heart');
    await page.evaluate(()=>{
      window.removed='';
      window.abort=new AbortController();
      const createdAt=new Date(Date.now()+90_000-60*60*1000).toISOString();
      const spaces=[{roomId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'等待中的空间',waiting:true,createdAt}];
      ui.mountSpaceDrawer(document.querySelector('#app'),{spaces,currentRoom:'other',signal:abort.signal,actions:[],
        select:async()=>{},create:async()=>{},rename:async()=>{},remove:async space=>{window.removed=space.roomId;},styleChanged:()=>{},closed:()=>{}});
    });
    await page.locator('.space-drawer-overlay.is-visible').waitFor();
    assert.match(await page.locator('.space-message-preview').innerText(),/等待对方加入 · 剩余 01:/);
    const row=page.locator('[data-space="0"]');
    await row.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,button:0});
    await page.waitForTimeout(420);
    await row.dispatchEvent('pointercancel',{pointerType:'touch',isPrimary:true});
    await page.locator('#space-delete').click();
    assert.equal(await page.evaluate(()=>window.removed),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await page.evaluate(()=>abort.abort());
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
    for(const count of [0,3,40]) {
      await page.evaluate(count=>mount(count),count);
      await page.locator('.space-drawer-overlay.is-visible').waitFor();
      const create=page.locator('#space-create'); assert.equal(await create.count(),1);
      const placement=await create.evaluate(button=>({rect:button.getBoundingClientRect().toJSON(),
        footer:Boolean(button.closest('.space-drawer-footer')),header:Boolean(button.closest('header')),
        scrollBottom:document.querySelector('.space-drawer-scroll').getBoundingClientRect().bottom}));
      assert.ok(placement.footer&&!placement.header&&placement.rect.height>=48&&placement.rect.bottom<=680
        &&placement.scrollBottom<=placement.rect.top,`${count}: reachable persistent creation ${JSON.stringify(placement)}`);
    }
    await page.evaluate(()=>abort.abort());
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
