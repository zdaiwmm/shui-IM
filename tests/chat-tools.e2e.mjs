import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server=await createServer({configFile:false,appType:'custom',root:process.cwd(),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false}});
server.middlewares.use('/__tools',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="app"></div></body></html>');});
let browser;
try {
  await server.listen();
  browser=process.env.QUIET_ROOM_TEST_BROWSER==='webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  page.setDefaultTimeout(10000);
  const errors=[],downloads=[];page.on('pageerror',e=>errors.push(e.message));page.on('download',e=>downloads.push(e));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__tools`);
  await page.evaluate(async()=>{
    for(const name of ['styles','chat-layout','gallery','chat-interactions','cover','voice-messages','chat-tools']) await import(`/src/${name}.css`);
    const {QuietRoomApp}=await import('/src/app.ts');
    const vault=await import('/src/lib/vault.ts');
    const {encryptFileAttachment,encryptImageFile}=await import('/src/lib/file-crypto.ts');
    const app=new QuietRoomApp(document.querySelector('#app'));
    const own={deviceId:crypto.randomUUID(),role:'creator',status:'active',capabilities:['file-message-v1','image-album-v1']};
    const session=await vault.createVault({v:1,roomId:crypto.randomUUID(),accessToken:'tools-test',role:'creator',protocol:'legacy-v1',lastSeq:0,members:[own],identity:{publicBundle:own}},'tools-test-passphrase','password');
    app.session=session;app.privacyCovered=false;app.runtimeAbort=new AbortController();app.uiPreferencesHydrated=true;app.uiPreferences={recoveryReminderDismissed:true};
    app.updateSafetyCode=async()=>{};app.unreadCounter.markRead=async()=>{};
    Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});
    const upload={reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async()=>{},complete:async()=>{},savePlan:async()=>{}};
    const file=await encryptFileAttachment(new File(['synthetic document'],'展览导览.pdf',{type:'application/pdf'}),upload);
    const canvas=document.createElement('canvas');canvas.width=120;canvas.height=120;const ctx=canvas.getContext('2d');ctx.fillStyle='#69967f';ctx.fillRect(0,0,120,120);
    const png=await new Promise(resolve=>canvas.toBlob(resolve));const imageFile=new File([png],'测试图片.png',{type:'image/png'});
    const image=await encryptImageFile(imageFile,upload);app.cacheLocalImage(image,imageFile);
    const sentAt=new Date().toISOString();
    const record=(seq,payload)=>({seq,clientMsgId:crypto.randomUUID(),senderId:own.deviceId,payload:{v:1,...payload,sentAt},acceptedAt:sentAt,status:'delivered'});
    const messages=[record(1,{kind:'file',file}),record(2,{kind:'image-album',images:[image,image]}),record(3,{kind:'file',file})];
    for(const m of messages){await vault.saveHistoryMessage(session,m);app.messages.set(m.seq,m);}
    app.renderChat();app.renderMessages({scroll:'bottom'});
    window.fixture={app,vault,session,messages};
  });
  assert.equal(await page.locator('#record-voice,.send-button,.chat-header .call-actions,.gallery-button').count(),0);
  assert.equal(await page.locator('#open-memes').count(),1);
  await page.locator('#message-input').fill('保留草稿');
  await page.locator('#open-chat-tools').click();
  assert.equal(await page.locator('#chat-tools > button').count(),6);
  assert.equal(await page.locator('.composer').evaluate(el => getComputedStyle(el).backgroundColor), await page.evaluate(() => {
    const probe=document.createElement('div'); probe.style.background='var(--paper-pure)';document.body.append(probe);
    const color=getComputedStyle(probe).backgroundColor;probe.remove();return color;
  }));
  await page.evaluate(() => window.fixture.app.showNotice('已收藏'));
  await page.waitForTimeout(220);
  const toast=await page.locator('#notice').boundingBox();const header=await page.locator('.chat-header').boundingBox();
  assert.ok(toast.width<150 && toast.y>=header.y+header.height && toast.y<=header.y+header.height+12, JSON.stringify({toast,header}));
  const positions=await page.locator('#chat-tools > button').evaluateAll(nodes=>nodes.map(e=>({top:e.getBoundingClientRect().top,left:e.getBoundingClientRect().left})));
  assert.equal(positions[0].top,positions[3].top);assert(positions[4].top>positions[3].top);assert.equal(positions[4].left,positions[0].left);
  assert.equal(await page.locator('#image-input').getAttribute('accept'),'image/*,video/*');
  assert.equal(await page.locator('#camera-input').getAttribute('capture'),'environment');
  assert.equal(await page.locator('#file-input').getAttribute('accept'),null);
  for(const [trigger,input] of [['#open-image-picker','#image-input'],['#open-camera-picker','#camera-input'],['#open-file-picker','#file-input']]) {
    if(!await page.locator('#chat-tools').isVisible()) await page.locator('#open-chat-tools').click();
    const chooser=page.waitForEvent('filechooser');await page.locator(trigger).click();await chooser;
    assert.equal(await page.locator('#chat-tools').isVisible(),false);
    await page.locator(input).dispatchEvent('cancel');
  }
  assert.equal(await page.locator('#message-input').inputValue(),'保留草稿');
  await page.evaluate(async()=>{const f=window.fixture;await f.app.toggleMessageFavorite(f.messages[0]);await f.app.toggleMessageFavorite(f.messages[1],1);});
  const stored=await page.evaluate(async()=>{const f=window.fixture;return (await f.vault.loadUiPreferences(f.session)).attachmentFavorites;});
  assert.equal(stored.length,2);assert.equal(stored.find(r=>r.category==='images').assetIndex,1);
  await page.evaluate(()=>{
    const {app,messages}=window.fixture;const source=messages[1];
    app.openImageViewer(source.payload.images,0,document.querySelector('.image-preview'),[],
      source.payload.images.map((_,assetIndex)=>({clientMsgId:source.clientMsgId,assetIndex,source})));
  });
  await page.locator('[data-viewer-favorite][aria-pressed="false"]').waitFor();
  await page.keyboard.press('ArrowRight');
  await page.locator('[data-viewer-favorite][aria-pressed="true"]').waitFor();
  await page.locator('[data-viewer-favorite]').click();
  await page.locator('[data-viewer-favorite][aria-pressed="false"]').waitFor();
  await page.locator('[data-viewer-favorite]').click();
  await page.locator('[data-viewer-favorite][aria-pressed="true"]').waitFor();
  await page.locator('[data-viewer-close]').click();
  await page.locator('#open-chat-tools').click();await page.locator('#open-favorites').click();
  await page.locator('.gallery-tile').waitFor();assert.equal(await page.locator('.gallery-tile').count(),1);
  await page.waitForTimeout(420);
  const galleryLayout = await page.evaluate(() => {
    const tabs=document.querySelector('.gallery-tabs').getBoundingClientRect();
    const toggle=document.querySelector('#gallery-toggle-visibility').getBoundingClientRect();
    return {center:(tabs.left+tabs.right)/2, right:toggle.right, bottom:toggle.bottom, width:innerWidth, height:innerHeight};
  });
  assert.ok(Math.abs(galleryLayout.center-galleryLayout.width/2)<1, JSON.stringify(galleryLayout));
  assert.ok(galleryLayout.width-galleryLayout.right<=20 && galleryLayout.height-galleryLayout.bottom<=20, JSON.stringify(galleryLayout));
  assert.equal(await page.locator('#open-gallery-image-picker').count(),0);
  await page.locator('.gallery-tile').click();await page.locator('.gallery-tile').click();
  await page.locator('.image-viewer').waitFor();assert.equal(await page.locator('[data-viewer-download],[data-viewer-details]').count(),0);
  await page.locator('[data-viewer-close]').click();
  await page.locator('#gallery-tab-files').click();await page.locator('.gallery-file').waitFor();assert.equal(await page.locator('.gallery-file').count(),1);
  await page.locator('.gallery-file').click();await page.locator('[data-gallery-action="delete"]').waitFor();
  assert.equal(await page.locator('[data-gallery-action="delete"]').innerText(),'取消收藏');
  assert.equal(downloads.length,0);
  await page.locator('[data-gallery-action="delete"]').click();await page.locator('.gallery-empty').waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.app.messages.size),3);
  await page.locator('#gallery-back').click();
  await page.evaluate(async()=>{
    const f=window.fixture;const save=f.app.saveUiPreferencesNow;
    f.app.saveUiPreferencesNow=async()=>{throw Error('Synthetic save failure');};
    await f.app.toggleMessageFavorite(f.messages[0]);f.app.saveUiPreferencesNow=save;
  });
  assert.equal(await page.evaluate(()=>window.fixture.app.uiPreferences.attachmentFavorites.length),1);
  await page.evaluate(()=>{const f=window.fixture;f.session.vault.role='joiner';f.app.renderChat();});
  await page.locator('.peer-summary').click();assert.equal(await page.locator('.gallery-shell').count(),0);assert.equal(await page.locator('#notice').isVisible(),false);
  await page.locator('#open-chat-tools').click();await page.locator('#open-favorites').click();await page.locator('.gallery-tile').waitFor();
  await page.evaluate(async()=>{
    const {app,messages,vault,session}=window.fixture;const target=messages[1];
    const sentAt=new Date().toISOString();
    const event={seq:4,clientMsgId:crypto.randomUUID(),senderId:target.senderId,status:'delivered',acceptedAt:sentAt,
      payload:{v:1,kind:'message-delete',target:{clientMsgId:target.clientMsgId,serverSeq:target.seq,senderId:target.senderId},sentAt}};
    await vault.saveHistoryMessage(session,event);app.messageEventHistory.set(event.seq,event);app.renderGallery();
  });
  await page.locator('.gallery-empty').waitFor();
  assert.equal(await page.locator('.gallery-tile').count(),0,'A globally deleted source returned in Favorites');
  await page.locator('#gallery-back').click();
  if(process.argv[2]) await mkdir(process.argv[2],{recursive:true});
  for(const width of [320,390,768,1280]) {
    await page.setViewportSize({width,height:844});
    if(!await page.locator('#chat-tools').isVisible())await page.locator('#open-chat-tools').click();
    await page.waitForFunction(()=>{const e=document.querySelector('.composer');return e && !e.hasAttribute('data-viewport-motion') && getComputedStyle(e).visibility==='visible' && Number(getComputedStyle(e).opacity)===1;});
    await page.waitForTimeout(350);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.argv[2])await page.screenshot({path:path.join(process.argv[2],`tools-${width}.png`)});
  }
  assert.deepEqual(errors,[]);console.log('Chat tools passed: six pickers/actions, four columns, preserved draft/memes, encrypted favorites, exact assets, no downloads, rollback and creator-only Safe.');
} finally {await browser?.close();await server.close();}
