import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__memes', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__memes`);
  await page.evaluate(async () => {
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
    app.processImageBatch = async files => { sent.push(await files[0].arrayBuffer()); return true; };
    app.renderChat();
    document.querySelector('#message-input').value = '保留这份草稿';
    const realFetch = window.fetch.bind(window); const requests = [];
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url,location.href);
      if (url.pathname.endsWith('/memes/search')) {
        const body = JSON.parse(init.body); requests.push(body);
        if (body.keyword === '失败') return new Response('{}',{status:503});
        return Response.json({items:files.slice(0,6).map((file,index)=>({id:`00000000-0000-4000-8000-${String(index+body.page*10).padStart(12,'0')}`,title:file.name})),nextPage:body.page===1?2:null});
      }
      if (url.pathname.endsWith('/memes/media')) return new Response(files[0],{headers:{'Content-Type':'image/png'}});
      return realFetch(input,init);
    };
    window.fixture = { app, vault, session, controller, files, sent, msg, requests };
  });
  await page.locator('#open-memes').click();
  await page.waitForFunction(() => document.querySelectorAll('.meme-tile img[src]').length >= 3);
  assert.equal(await page.locator('[data-mode="search"]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.meme-grip').count(),0);
  assert.equal(await page.locator('.chat-shell').evaluate(el=>el.inert),true);
  assert.equal(await page.evaluate(()=>window.fixture.requests[0].keyword),'热门');
  await page.locator('[data-category="可爱"]').click();
  await page.waitForFunction(()=>window.fixture.requests.at(-1).keyword==='可爱');
  await page.locator('[data-mode="favorites"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===9);
  assert.equal(await page.locator('.meme-tile').count(),9);
  assert.equal(await page.locator('#message-input').inputValue(),'保留这份草稿');
  await page.locator('.meme-tile').first().click();
  await page.waitForFunction(()=>window.fixture.sent.length===1);
  assert.equal(await page.locator('#meme-panel').count(),1);
  await page.locator('.meme-tile').first().dispatchEvent('contextmenu');
  await page.locator('.meme-preview img').waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.sent.length),1,'Long press sent an image');
  await page.locator('.meme-preview [data-action="save"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===8);
  await page.locator('[data-mode="search"]').click();
  await page.locator('#meme-query').fill('无语'); await page.locator('#meme-query').press('Enter');
  await page.waitForFunction(()=>window.fixture.requests.at(-1).keyword==='无语');
  assert.equal(await page.getByRole('button',{name:'同意并搜索'}).count(),0);
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===6);
  await page.locator('.meme-more').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===12);
  await page.locator('#meme-query').fill('失败'); await page.locator('#meme-query').press('Enter');
  await page.getByText('网络梗图暂时不可用，请稍后重试').waitFor();
  await page.locator('[data-mode="favorites"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===8);
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
    assert.ok(geometry.left===0 && geometry.right===width && geometry.top===0 && Math.abs(geometry.bottom-height)<=1 && !geometry.overflow,JSON.stringify(geometry));
    if(out) await page.screenshot({path:path.join(out,`memes-${width}.png`)});
  }
  await page.emulateMedia({colorScheme:'dark'});
  if(out) await page.screenshot({path:path.join(out,'memes-dark.png')});
  await page.locator('[data-mode="close"]').click();
  assert.equal(await page.locator('.meme-panel').count(),0);
  assert.equal(await page.locator('.chat-shell').evaluate(el=>el.inert),false);
  assert.equal(await page.locator('#message-input').inputValue(),'保留这份草稿');
  await page.locator('#open-memes').click();
  await page.locator('[data-mode="favorites"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-tile').length===8);
  await page.evaluate(()=> {
    window.fixture.app.processImageBatch=()=>new Promise(resolve=>{window.fixture.finishSend=resolve;});
  });
  await page.locator('.meme-tile').first().click();
  await page.waitForFunction(()=>window.fixture.finishSend);
  await page.evaluate(()=>{window.fixture.app.setActiveSurface('away');window.fixture.finishSend(false);});
  await page.waitForFunction(()=>window.fixture.app.imageBatchUploading===false);
  await page.evaluate(()=>{window.fixture.app.renderChat();window.fixture.app.openMemePicker();});
  await page.locator('.meme-panel').waitFor();
  await page.evaluate(()=>window.fixture.app.obscurePrivacySurface());
  assert.equal(await page.locator('.meme-panel,.meme-preview').count(),0,'Privacy curtain retained meme UI');
  assert.deepEqual(errors,[]);
  console.log('Meme picker: encryption, originals, send, long press, default online, categories, direct search, paging, modal isolation, privacy teardown and fullscreen viewports passed.');
} finally { await browser?.close(); await server.close(); }
