import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { animatedWebp } from './fixtures/photo-fixtures.mjs';

async function assertMoving(image, message) {
  const first = await image.screenshot();
  for (let attempt = 0; attempt < 8; attempt++) {
    await image.page().waitForTimeout(90);
    if (!first.equals(await image.screenshot())) return;
  }
  assert.fail(message);
}

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__memes', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
});
let browser;
try {
  await server.listen();
  browser = process.env.MEME_WEBKIT === '1' ? await webkit.launch() : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__memes`);
  await page.evaluate(async (animation) => {
    for (const css of ['styles','chat-layout','gallery','chat-interactions','cover','call','memes']) await import(`/src/${css}.css`);
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const { encryptImageFile } = await import('/src/lib/file-crypto.ts');
    const { validateMemeFile } = await import('/src/lib/meme-media.ts');
    const own = { deviceId: crypto.randomUUID(), role: 'joiner', status: 'active', capabilities: ['image-album-v1','file-message-v1'] };
    const peer = { ...own, deviceId: crypto.randomUUID(), role: 'creator' };
    const session = await vault.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'synthetic-meme-test', role: 'joiner', protocol: 'legacy-v1', lastSeq: 1, members: [own,peer], identity: { publicBundle: own } }, 'synthetic-meme-password', 'password');
    const controller = new AbortController();
    const makeFile = async (caption, index) => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 240;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = ['#eef3e8','#f8e7b9','#eaeef4','#f5e6ec'][index % 4]; ctx.fillRect(0,0,240,240);
      ctx.fillStyle = '#fffdf8'; ctx.beginPath(); ctx.arc(120,94,64,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle = '#333a43'; ctx.lineWidth = 4; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(80,85); ctx.lineTo(105,85); ctx.moveTo(135,85); ctx.lineTo(160,85); ctx.moveTo(100,122); ctx.lineTo(140,122); ctx.stroke();
      ctx.fillStyle = '#333a43'; ctx.font = 'bold 23px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(caption,120,207);
      const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
      return new File([blob], `${caption}.png`, { type: 'image/png' });
    };
    const files = [];
    for (const [index, caption] of ['无语住了','收到','晚安','笑死','好的好的','抱抱','我先静静','好耶','辛苦了'].entries()) {
      const file = await makeFile(caption,index); files.push(file);
      await vault.saveMemeFavorite(session, await validateMemeFile(file,file.name,controller.signal),controller.signal);
    }
    const duplicate = await vault.saveMemeFavorite(session,files[0],controller.signal);
    if (duplicate !== false) throw new Error('Duplicate favorite was stored');
    const manifest = await encryptImageFile(files[0], { reserve: async()=>{}, status:async()=>({uploadedIndexes:[],completed:false}), upload:async()=>{}, complete:async()=>{}, savePlan:async()=>{} });
    const app = new QuietRoomApp(document.querySelector('#app'));
    app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = controller;
    app.uiPreferences = { recoveryReminderDismissed: true }; app.uiPreferencesHydrated = true;
    app.updateSafetyCode = async()=>{}; app.updateBackgroundNotificationControl = async()=>{};
    app.unreadCounter.markRead = async()=>{}; app.flushUiPreferencesSave = ()=>{};
    const msg = { seq:1,clientMsgId:crypto.randomUUID(),senderId:peer.deviceId,payload:{v:1,kind:'image',image:manifest,sentAt:new Date().toISOString()},acceptedAt:new Date().toISOString(),status:'delivered' };
    app.messages = new Map([[1,msg]]);
    app.imageCache.set(manifest.blobId,{blob:files[0],url:URL.createObjectURL(files[0]),bytes:files[0].size,lastUsedAt:Date.now()});
    const sent = [];
    app.processImageBatch = async (files, destination, signal, expression) => {
      if (destination !== 'chat' || expression !== true) throw new Error('Expression send lost its encrypted presentation intent');
      sent.push(await files[0].arrayBuffer()); return true;
    };
    app.renderChat();
    document.querySelector('#message-input').value = '保留这份草稿';
    const realFetch = window.fetch.bind(window); const requests = [];
    const formerPack = { id: 'synthetic-pack', title: 'Synthetic pack' };
    const networkGif = new File([new Uint8Array(animation)], 'catalog-animation.webp', { type: 'image/webp' });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url,location.href);
      if (url.pathname.endsWith('/memes/search')) {
        const body = JSON.parse(init.body); requests.push(body);
        if (body.keyword === '失败') return new Response('{}',{status:503});
        if (body.keyword === '预置') return Response.json({items:[],packs:[{...formerPack,cover:'00000000-0000-4000-8000-000000000000'}],nextPage:null});
        if (body.kind === 'stickers') return Response.json({items:[],packs:[{id:'a'.repeat(32),title:'测试合集',cover:'00000000-0000-4000-8000-000000000000'}],nextPage:null});
        return Response.json({items:files.slice(0,6).map((file,index)=>({id:`11111111-0000-4000-8000-${String(index+body.page*10).padStart(12,'0')}`,title:file.name})),nextPage:body.page===1?2:null});
      }
      if (url.pathname.endsWith('/memes/pack')) return Response.json({id:'a'.repeat(32),title:'测试合集',items:files.slice(0,3).map((file,index)=>({id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,title:file.name}))});
      if (url.pathname.endsWith('/memes/media')) { const id=JSON.parse(init.body).id; const file=id.startsWith('11111111')?networkGif:files[Number(id.slice(-2))%files.length]; return new Response(file,{headers:{'Content-Type':file.type}}); }
      if (url.pathname.startsWith('/stickers/') || url.pathname.startsWith('/gifs/')) throw new Error('Bundled media requested');
      return realFetch(input,init);
    };
    window.fixture = { app, vault, session, controller, files, sent, msg, requests, networkGif };
  }, [...animatedWebp]);
  await page.locator('#open-memes').click();
  await page.waitForFunction(() => document.querySelectorAll('.meme-tile img[src]').length >= 3);
  assert.equal(await page.locator('button[data-kind="gifs"]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.meme-grip').count(),0);
  assert.equal(await page.locator('.chat-shell').evaluate(el=>el.inert),false);
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===12);
  assert.equal(await page.evaluate(()=>window.fixture.requests.length),2);
  const firstAnimation=page.locator('.meme-tile img').first(); await firstAnimation.waitFor();
  await assertMoving(firstAnimation, 'Panel animation pixels did not move');
  const tileBounds=await page.locator('.meme-tile').first().boundingBox();
  const gridColumns = await page.locator('.meme-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert.equal(gridColumns, 5);
  const imageBounds=await firstAnimation.boundingBox();
  await page.mouse.move(tileBounds.x+tileBounds.width/2,tileBounds.y+tileBounds.height/2); await page.mouse.down();
  await page.locator('.meme-preview img').waitFor(); await page.mouse.up();
  assert.equal(await page.locator('.meme-tile').first().evaluate(el=>getComputedStyle(el).transform),'none');
  assert.ok(Math.abs((await page.locator('.meme-preview img').boundingBox()).width-imageBounds.width)<1,'Long press resized media');
  assert.equal(await page.evaluate(()=>window.fixture.sent.length),0);
  await page.locator('.meme-preview-close').click();
  await page.getByRole('button',{name:'收藏',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===9);
  assert.equal(await page.locator('.meme-tile').count(),9);
  assert.equal(await page.locator('#message-input').inputValue(),'保留这份草稿');
  await page.locator('.meme-tile').first().click();
  await page.waitForFunction(()=>window.fixture.sent.length===1);
  await page.locator('#meme-panel').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#meme-panel').count(),0);
  await page.locator('#open-memes').click(); await page.getByRole('button',{name:'收藏',exact:true}).click();
  await page.locator('.meme-tile').first().dispatchEvent('contextmenu');
  await page.locator('.meme-preview img').waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.sent.length),1,'Long press sent an image');
  await page.locator('.meme-preview [data-action="save"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===8);
  await page.locator('.meme-open-search').click();
  assert.equal(await page.locator('.chat-shell').evaluate(el=>el.inert),true);
  assert.equal(await page.locator('.meme-tabs').isVisible(),false);
  await page.waitForFunction(() => document.activeElement === document.querySelector('.meme-back'));
  await page.locator('#meme-query').fill('无语'); await page.locator('#meme-query').press('Enter');
  await page.waitForFunction(()=>window.fixture.requests.at(-1).keyword==='无语');
  assert.equal(await page.getByRole('button',{name:'同意并搜索'}).count(),0);
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===12);
  assert.ok(Math.abs((await page.locator('.meme-tile').first().boundingBox()).width-tileBounds.width)<1, 'GIF search changed tile size');
  assert.equal(await page.locator('.meme-more').isVisible(), false);
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===12);
  await page.locator('#meme-query').fill('失败'); await page.locator('#meme-query').press('Enter');
  await page.getByText('网络梗图暂时不可用，请稍后重试').waitFor();
  await page.locator('.meme-back').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===8);
  await page.locator('.meme-tile').first().dispatchEvent('contextmenu');
  await page.locator('.meme-preview [data-action="send"]').click();
  await page.waitForFunction(()=>!document.querySelector('#meme-panel'));
  assert.equal(await page.evaluate(()=>window.fixture.sent.length),2);
  await page.locator('#open-memes').click();
  await page.locator('button[data-kind="stickers"]').click();
  assert.equal(await page.locator('.meme-pack-cover').count(), 0, 'Unadded collections must only appear in search');
  assert.equal(await page.locator('.meme-pack-shortcuts img').count(),0);
  await page.locator('.meme-open-search').click();
  await page.locator('.meme-pack-cover').waitFor();
  await page.locator('.meme-pack-cover').click();
  await page.locator('.meme-pack-detail-header').waitFor();
  assert.equal(await page.locator('.meme-search-dialog').count(),1,'Default catalog detail needs a visible return path');
  await page.locator('.meme-back').click();
  await page.locator('.meme-back').click();
  await page.locator('.meme-open-search').click();
  await page.locator('#meme-query').fill('预置'); await page.locator('#meme-query').press('Enter');
  await page.waitForFunction(()=>document.querySelector('.meme-pack-add')?.textContent==='添加');
  assert.ok(Math.abs((await page.locator('.meme-pack-cover').boundingBox()).width-tileBounds.width)<1, 'Sticker search cover size differs');
  assert.equal(await page.locator('.meme-pack-add').isDisabled(),false,'A formerly bundled pack is now managed by the catalog');
  await page.locator('#meme-query').fill('合集'); await page.locator('#meme-query').press('Enter');
  await page.waitForFunction(()=>window.fixture.requests.at(-1).kind==='stickers'&&window.fixture.requests.at(-1).keyword==='合集');
  await page.locator('.meme-pack-cover').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-pack-grid .meme-tile').length===3);
  await page.locator('.meme-back').click();
  await page.locator('.meme-pack-result').waitFor();
  assert.equal(await page.locator('.meme-search-dialog').count(),1,'Pack detail back skipped search results');
  await page.locator('.meme-pack-cover').click();
  await page.locator('.meme-pack-detail-header').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.meme-pack-result').waitFor();
  assert.equal(await page.locator('.meme-search-dialog').evaluate(el=>el.inert),false,'Escape left search inert');
  await page.locator('.meme-pack-add').click();
  await page.waitForFunction(()=>document.querySelector('.meme-pack-add')?.textContent==='解除添加');
  await page.locator('.meme-pack-add').click();
  await page.waitForFunction(()=>document.querySelector('.meme-pack-add')?.textContent==='添加');
  await page.locator('.meme-pack-add').click();
  await page.waitForFunction(()=>document.querySelector('.meme-pack-add')?.textContent==='解除添加');
  assert.equal(await page.evaluate(async()=> (await window.fixture.vault.loadStickerPacks(window.fixture.session))[0].items.length),3);
  await page.locator('.meme-back').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-pack-list section').length===1);
  assert.equal(await page.locator('.meme-collapse').isVisible(), false);
  await page.locator('#open-memes').click();
  await page.locator('#meme-panel').waitFor({ state: 'detached' });
  await page.locator('#open-memes').click();
  await page.locator('.meme-pack-shortcuts img').waitFor();
  await page.locator('.meme-pack-shortcuts button[title="测试合集"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-pack-list section').length===1);
  assert.equal(await page.locator('button[data-kind="stickers"]').getAttribute('aria-selected'), 'true');
  await page.locator('.meme-pack-shortcuts').evaluate(bar => {
    window.retainedShortcut = bar.querySelector('img');
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 100, clientY: 500 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 100, clientY: 400 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 100, clientY: 400 }));
  });
  await page.locator('.meme-expanded-dialog').waitFor();
  await page.waitForFunction(() => !document.querySelector('.meme-panel').getAnimations().some(animation => animation.playState === 'running'));
  assert.equal(await page.locator('.meme-tabs').isVisible(), true);
  assert.equal(await page.locator('.meme-collapse').isVisible(), true);
  await page.locator('.meme-pack-shortcuts').evaluate(bar => {
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientX: 100, clientY: 60 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientX: 100, clientY: 180 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 100, clientY: 180 }));
  });
  await page.locator('.meme-expanded-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.retainedShortcut === document.querySelector('.meme-pack-shortcuts img')), true, 'Dragging should retain decoded shortcuts');
  assert.equal(await page.locator('.meme-collapse').isVisible(), false);
  if (process.env.MEME_WEBKIT !== '1') {
    const cdp = await page.context().newCDPSession(page);
    const pull = async distance => {
      const bar = await page.locator('.meme-pack-shortcuts').boundingBox();
      const before = await page.locator('.meme-panel').boundingBox();
      const x = bar.x + bar.width - 20, y = bar.y + bar.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 5; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * step / 5 }] });
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const during = await page.locator('.meme-panel').boundingBox();
      assert.ok(Math.abs(during.height - (before.height - distance)) < 3, `Sheet did not follow native touch: ${JSON.stringify({ before, during, distance })}`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => !document.querySelector('.meme-panel').getAnimations().some(animation => animation.playState === 'running'));
    };
    await pull(-120);
    assert.equal(await page.locator('.meme-expanded-dialog').count(), 1);
    await pull(120);
    assert.equal(await page.locator('.meme-expanded-dialog').count(), 0);
    await cdp.detach();
  }
  await page.locator('.meme-pack-shortcuts').evaluate(bar => {
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3, clientX: 100, clientY: 500 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 3, clientX: 100, clientY: 400 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, clientX: 100, clientY: 400 }));
  });
  await page.waitForTimeout(260);
  await page.locator('.meme-collapse').click();
  await page.locator('#open-memes').click();
  await page.locator('button[data-kind="stickers"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-pack-list section').length===1);
  assert.equal((await page.locator('.meme-pack-shortcuts img').first().boundingBox()).width,24);
  assert.ok(Math.abs((await page.locator('.meme-pack-grid .meme-tile').first().boundingBox()).width-tileBounds.width)<1, 'Sticker tile size differs');
  await page.evaluate(async()=> {
    const { app,msg,session,vault,controller,files }=window.fixture;
    await app.favoriteChatMeme(msg,msg.payload.image);
    app.messages.clear();
    const items=await vault.loadMemeFavorites(session);
    const item=items.find(item=>item.name===files[0].name);
    if (!item) throw new Error('Chat favorite missing');
    const saved=await vault.loadMemeFavoriteFile(session,item,controller.signal);
    if (JSON.stringify([...new Uint8Array(await saved.arrayBuffer())])!==JSON.stringify([...new Uint8Array(await files[0].arrayBuffer())])) throw new Error('Favorite bytes changed');
    const cancelled=new AbortController(); cancelled.abort();
    try { await vault.removeMemeFavorite(session,item.id,cancelled.signal); throw new Error('Cancelled write succeeded'); }
    catch(error) { if(error.message==='Cancelled write succeeded') throw error; }
    if(!(await vault.loadMemeFavorites(session)).some(row=>row.id===item.id)) throw new Error('Cancelled removal changed favorites');
    const stale={...session,stored:{...session.stored,invalid:true}};
    try { await vault.removeMemeFavorite(stale,item.id,controller.signal); throw new Error('Stale write succeeded'); }
    catch(error) { if(error.message==='Stale write succeeded') throw error; }
    const db=await new Promise(resolve=>{const req=indexedDB.open('quiet-room');req.onsuccess=()=>resolve(req.result);});
    const rows=await new Promise(resolve=>{const req=db.transaction('memeFavorites').objectStore('memeFavorites').getAll();req.onsuccess=()=>resolve(req.result);}); db.close();
    if (JSON.stringify(rows).includes(files[0].name)) throw new Error('Plaintext favorite metadata persisted');
    const { validateMemeFile }=await import('/src/lib/meme-media.ts');
    const gif=new File([Uint8Array.from(atob('R0lGODlhAQABAIAAAP8AAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),char=>char.charCodeAt(0))],'synthetic.gif',{type:'image/gif'});
    const validGif=await validateMemeFile(gif,gif.name,controller.signal);
    await vault.saveMemeFavorite(session,validGif,controller.signal);
    const gifItem=(await vault.loadMemeFavorites(session)).find(row=>row.name===gif.name);
    const restoredGif=await vault.loadMemeFavoriteFile(session,gifItem,controller.signal);
    if(restoredGif.size!==gif.size || restoredGif.type!=='image/gif') throw new Error('GIF bytes or type changed');
    await vault.removeMemeFavorite(session,gifItem.id,controller.signal);
    const installed=(await vault.loadStickerPacks(session))[0];
    const restored=await vault.loadMemeFavoriteFile(session,installed.items[0],controller.signal);
    if(restored.size!==files[0].size) throw new Error('Installed pack original changed');
    try { await vault.installStickerPack(stale,'b'.repeat(32),'Stale pack',[files[0]],controller.signal); throw new Error('Stale pack install succeeded'); }
    catch(error) { if(error.message==='Stale pack install succeeded') throw error; }
    try { await vault.removeStickerPack(session,installed.id,cancelled.signal); throw new Error('Cancelled pack removal succeeded'); }
    catch(error) { if(error.message==='Cancelled pack removal succeeded') throw error; }
    if((await vault.loadStickerPacks(session)).length!==1) throw new Error('Failed pack mutation changed index');
  });
  const out = process.argv[2];
  if(out) await mkdir(out,{recursive:true});
  for(const [width,height] of [[390,844],[320,720],[820,1000],[1440,1000]]) {
    await page.setViewportSize({width,height});
    await page.waitForFunction(()=>document.querySelector('.meme-tile img[src]')?.naturalWidth>0);
    // Viewport changes animate the composer; inspect its settled geometry.
    const geometry=await page.locator('.meme-panel').evaluate(async el=>{
      let last='', stableSince=performance.now();
      const deadline=performance.now()+5000;
      while(performance.now()<deadline) {
        await new Promise(requestAnimationFrame);
        const r=el.getBoundingClientRect();
        const current={left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};
        const key=JSON.stringify(current);
        if(key!==last) {last=key;stableSince=performance.now();}
        if(performance.now()-stableSince>=350) return current;
      }
      throw new Error('Meme panel geometry did not settle');
    });
    assert.ok(geometry.left>=0 && geometry.right<=width && geometry.top>=height*0.4 && Math.abs(geometry.bottom-height)<=1 && !geometry.overflow,JSON.stringify(geometry));
    if(out) await page.screenshot({path:path.join(out,`memes-${width}.png`)});
    const halfTileWidth=(await page.locator('.meme-tile').first().boundingBox()).width;
    await page.locator('.meme-open-search').click();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.meme-search-dialog')).opacity==='1'&&getComputedStyle(document.querySelector('.meme-panel')).opacity==='1');
    const full=await page.locator('.meme-search-dialog').boundingBox();
    const fullGridColumn=await page.locator('.meme-grid').evaluate(el=>(el.getBoundingClientRect().width-16)/5);
    assert.ok(Math.abs(fullGridColumn-halfTileWidth)<1, `Tile width changed between half/full search at ${width}px: ${halfTileWidth}/${fullGridColumn}`);
    assert.ok(Math.abs(full.height-height)<=1&&full.y===0&&full.width===width,JSON.stringify(full));
    if(out) await page.screenshot({path:path.join(out,`search-${width}.png`)});
    await page.locator('.meme-back').click();
  }
  await page.emulateMedia({colorScheme:'dark'});
  if(out) await page.screenshot({path:path.join(out,'memes-dark.png')});
  await page.locator('#open-memes').click();
  await page.locator('#meme-panel').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.meme-panel').count(),0);
  assert.equal(await page.locator('.chat-shell').evaluate(el=>el.inert),false);
  assert.equal(await page.locator('#message-input').inputValue(),'保留这份草稿');
  await page.locator('#open-memes').click();
  await page.getByRole('button',{name:'收藏',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===8);
  await page.evaluate(()=> {
    window.fixture.app.processImageBatch=()=>new Promise(resolve=>{window.fixture.finishSend=resolve;});
  });
  await page.locator('.meme-tile').first().click();
  await page.waitForFunction(()=>window.fixture.finishSend);
  await page.evaluate(()=>{window.fixture.app.setActiveSurface('away');window.fixture.finishSend(false);});
  await page.waitForFunction(()=>window.fixture.app.imageBatchUploading===false);
  // The actual chat renderer must play the same original animation that was selected.
  await page.evaluate(async()=> {
    const { app,session,networkGif }=window.fixture;
    const { encryptImageFile }=await import('/src/lib/file-crypto.ts');
    const file=networkGif;
    const manifest=await encryptImageFile(file,{reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async()=>{},complete:async()=>{},savePlan:async()=>{}});
    app.cacheLocalImage(manifest,file); app.messages.clear();
    const msg={seq:2,clientMsgId:crypto.randomUUID(),senderId:session.vault.identity.publicBundle.deviceId,payload:{v:1,kind:'image',presentation:'expression',image:manifest,sentAt:new Date().toISOString()},acceptedAt:new Date().toISOString(),status:'delivered'};
    app.messages.set(2,msg); app.renderChat();
    if ((await caches.keys()).includes('quiet-room-starter-media-v1')) throw new Error('Catalog original persisted to plaintext cache');
    const realFetch=window.fetch; window.fetch=()=>Promise.reject(new Error('offline'));
    try { app.renderChat(); }
    finally { window.fetch=realFetch; }
  });
  const chatAnimation=page.locator('.message-list .image-preview img').first();
  await chatAnimation.waitFor();
  await page.waitForFunction(()=>document.querySelector('.message-list .image-preview img')?.naturalWidth>0);
  assert.equal(await page.locator('.message-list .image-preview').first().getAttribute('data-revealed'), 'true');
  assert.equal(await page.locator('.expression-bubble').count(), 1);
  const originalWidth = await chatAnimation.evaluate(image => image.naturalWidth);
  assert.ok(Math.abs((await chatAnimation.boundingBox()).width - originalWidth * 2 / 3) < 1, 'Small expression did not shrink to two thirds');
  await page.evaluate(() => window.fixture.app.concealChatImages());
  assert.equal(await page.locator('.message-list .image-preview').first().getAttribute('data-revealed'), 'false');
  await page.locator('.message-list .image-preview').first().click();
  await assertMoving(chatAnimation, 'Sent chat animation was frozen');
  await page.locator('.message-list .image-preview').first().dispatchEvent('contextmenu');
  await page.locator('.message-action-preview img').waitFor();
  await page.waitForTimeout(350);
  assert.equal(await page.locator('[data-message-action="favorite-meme"]').innerText(), '收藏为表情');
  assert.equal(await page.locator('.message-action-preview img').evaluate(el => getComputedStyle(el).opacity), '1');
  if (out) await page.screenshot({path:path.join(out,'expression-menu.png')});
  await page.evaluate(() => window.fixture.app.closeMessageActions(false, false));
  await page.evaluate(async () => {
    const { app } = window.fixture;
    const { CHAT_KEYBOARD_LAYOUT_MS, chatKeyboardLayoutProgress } = await import('/src/lib/chat-keyboard-layout.ts');
    const verifyMotion = async property => {
      const panel = document.querySelector('.meme-panel');
      const animation = panel.getAnimations().find(item => item.effect.getKeyframes().some(frame => property in frame));
      if (!animation || animation.effect.getTiming().duration !== CHAT_KEYBOARD_LAYOUT_MS) throw Error(`${property} motion did not share keyboard timing`);
      animation.pause();
      const frames = animation.effect.getKeyframes();
      const value = frame => property === 'height' ? parseFloat(frame.height) : parseFloat(frame.transform.match(/translateY\(([-.\d]+)px\)/)[1]);
      const start = value(frames[0]), end = value(frames.at(-1));
      const expected = start + (end - start) * chatKeyboardLayoutProgress(CHAT_KEYBOARD_LAYOUT_MS / 2);
      if (Math.abs(value(frames[12]) - expected) > 0.01 || start === end) throw Error('Panel motion lost the keyboard curve or travel');
      animation.finish(); await animation.finished;
      await new Promise(requestAnimationFrame);
      return { start, end };
    };
    app.renderChat(); app.openMemePicker();
    await verifyMotion('transform');
    document.querySelector('.meme-open-search').click();
    const expansion = await verifyMotion('height');
    if (expansion.end <= expansion.start) throw Error('Search did not extend the half sheet');
    document.querySelector('.meme-back').click();
    const contraction = await verifyMotion('height');
    if (contraction.end >= contraction.start || document.querySelector('.meme-search-dialog')) throw Error('Back did not restore the half sheet');
    document.querySelector('.meme-open-search').click(); await verifyMotion('height');
    document.querySelector('.meme-close').click();
    if (!document.querySelector('.meme-panel')?.inert) throw Error('Closing panel remained interactive');
    document.querySelector('.meme-search-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await verifyMotion('transform');
    if (document.querySelector('.meme-panel') || document.querySelector('.chat-shell').inert) throw Error('Full close did not release the dialog');
    app.openMemePicker(); await verifyMotion('transform');
    document.querySelector('#open-memes').click(); await verifyMotion('transform');
    if (document.querySelector('.meme-panel')) throw Error('Half close retained the panel');
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const { app } = window.fixture; app.renderChat(); app.openMemePicker();
    document.querySelector('.meme-open-search').click();
    if (document.querySelector('.meme-panel').getAnimations().length) throw Error('Reduced motion animated search');
    document.querySelector('.meme-close').click();
    if (document.querySelector('.meme-panel')) throw Error('Reduced motion delayed closing');
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(()=>{window.fixture.app.renderChat();window.fixture.app.openMemePicker();});
  await page.locator('.meme-panel').waitFor();
  await page.evaluate(()=> {
    document.querySelector('.meme-open-search').click();
    document.querySelector('.meme-close').click();
    window.fixture.app.obscurePrivacySurface();
  });
  assert.equal(await page.locator('.meme-panel,.meme-preview').count(),0,'Privacy curtain retained meme UI');
  assert.deepEqual(errors,[]);
  console.log('Sticker picker: server catalog defaults, moving pixels, half sheet, typed fullscreen search, atomic encrypted pack install/reopen, tap/hold send closure, privacy and responsive geometry passed.');
} finally { await browser?.close(); await server.close(); }
