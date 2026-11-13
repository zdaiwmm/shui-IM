import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server=await createServer({configFile:false,appType:'custom',root:process.cwd(),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false}});
server.middlewares.use('/__video_download',(_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app"></main>');});
let browser;
try{
  await server.listen();
  for(const engine of [chromium,webkit]){
    browser=await engine.launch();
    const page=await browser.newPage({locale:'zh-CN',viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__video_download`);
    await page.evaluate(async()=>{
      await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
      const {QuietRoomApp}=await import('/src/app.ts');
      const app=new QuietRoomApp(document.querySelector('#app'));
      app.updateSafetyCode=async()=>{};app.flushUiPreferencesSave=()=>{};app.saveUiPreferencesNow=async()=>{};
      const own={deviceId:crypto.randomUUID(),role:'creator',status:'active',capabilities:['file-message-v1','video-preview-v1','media-dimensions-v1']};
      const peer={...own,deviceId:crypto.randomUUID(),role:'joiner'};
      app.session={vault:{roomId:crypto.randomUUID(),role:'creator',protocol:'legacy-v1',members:[own,peer],identity:{publicBundle:own}}};
      app.privacyCovered=false;app.runtimeEpoch++;app.runtimeAbort=new AbortController();
      app.uiPreferences={recoveryReminderDismissed:true,entranceCardDismissed:true};
      app.renderChat();
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=48;const ctx=canvas.getContext('2d');ctx.fillStyle='#f68';ctx.fillRect(0,0,64,48);
      const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg'));
      const data=(await import('/src/lib/base64.ts')).toBase64Url(await jpeg.arrayBuffer());
      const manifest={v:1,blobId:crypto.randomUUID(),key:'A'.repeat(43),ivPrefix:'A'.repeat(11),chunkSize:2097152,chunkCount:15,
        originalSize:30*1024**2,originalName:'manual.mp4',mimeType:'video/mp4',lastModified:1,sha256:'a'.repeat(64),width:64,height:48};
      const payload={v:3,kind:'file',file:manifest,sentAt:new Date().toISOString(),videoPreview:{durationMs:48000,image:{mimeType:'image/jpeg',data,width:64,height:48}}};
      const message={seq:1,clientMsgId:crypto.randomUUID(),senderId:peer.deviceId,status:'delivered',acceptedAt:payload.sentAt,payload};
      let downloads=0,viewers=0;const state={pause:false};
      app.openImageViewer=()=>{viewers++;};
      app.loadImage=async(_manifest,_preview,_original,_network,signal)=>{
        downloads++;
        if(state.pause)await new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
        signal?.throwIfAborted();app.cacheLocalImage(manifest,new Blob(['verified-fixture'],{type:'video/mp4'}));
        const cached=app.imageCache.get(manifest.blobId);cached.posterUrl=URL.createObjectURL(jpeg);cached.width=64;cached.height=48;cached.durationMs=48000;return cached;
      };
      app.messages=new Map([[1,message]]);app.renderMessages({scroll:'bottom'});
      window.videoFixture={app,manifest,state,get downloads(){return downloads;},get viewers(){return viewers;}};
      // Native cover clicks before asynchronous IDB/cache checks are consent-free too.
      const cover=document.querySelector('.video-cover-control');cover.click();cover.click();
      if(downloads!==0)throw Error('Early cover click downloaded a large original');
    });
    const card=page.locator('.image-preview.video-preview');
    // The center belongs to the independent download/cancel button. Exercise
    // the real surrounding cover hit area, without bypassing pointer checks.
    const clickCover=()=>card.locator('.video-cover-control').click({position:{x:8,y:8}});
    await page.locator('.video-download-control').waitFor();
    await page.waitForFunction(()=>document.querySelector('.video-preview[data-image-state="waiting"] > .video-download-control'));
    const downloadBounds=await card.locator('.video-download-control').boundingBox();
    assert.equal(downloadBounds.width,48,'Download keeps its own 48px hit target instead of covering the surrounding cover');
    assert.equal(downloadBounds.height,48,'Generic media loading styles must not stretch the download hit target');
    assert.equal(await card.locator('.video-duration').textContent(),'00:48');
    assert.equal(await page.evaluate(()=>videoFixture.downloads),0,'history loading must not download a 30 MiB original');
    assert.equal(await card.locator('button button').count(),0,'cover and download are independent native controls');
    await clickCover();assert.equal(await card.getAttribute('data-revealed'),'true');
    await card.locator('.video-cover-control').press('Enter');assert.equal(await card.getAttribute('data-revealed'),'false');
    assert.equal(await page.evaluate(()=>videoFixture.downloads),0,'cover reveal and conceal must not download the original');
    const before=await card.boundingBox();
    await page.evaluate(()=>videoFixture.state.pause=true);
    await card.locator('.video-download-control').click();
    await page.getByRole('button',{name:'取消下载',exact:true}).waitFor();
    await clickCover();assert.equal(await card.getAttribute('data-revealed'),'true');
    await clickCover();assert.equal(await card.getAttribute('data-revealed'),'false');
    await page.getByRole('button',{name:'取消下载',exact:true}).click();
    await page.getByRole('button',{name:'下载视频',exact:true}).waitFor();
    assert.equal(await card.getAttribute('data-image-state'),'waiting');
    await page.evaluate(()=>videoFixture.state.pause=false);
    await card.locator('.video-download-control').click();
    await page.waitForFunction(()=>document.querySelector('.image-preview.video-preview').dataset.imageState==='loaded');
    assert.equal(await page.evaluate(()=>videoFixture.downloads),2);
    assert.equal(await page.evaluate(()=>videoFixture.viewers),0,'download completion never auto-plays');
    const after=await card.boundingBox();assert.ok(Math.abs(before.width-after.width)<1&&Math.abs(before.height-after.height)<1,'manual download keeps bubble geometry');
    assert.equal(await card.locator('.video-download-control').count(),0);assert.equal(await card.locator('.video-play').count(),1);
    const generationFence=await page.evaluate(async()=>{
      const transfers=await import('/src/lib/cipher-transfer.ts');
      const owner=videoFixture.app.session.vault;
      const task={id:transfers.cipherTransferId(owner.roomId,owner.identity.publicBundle.deviceId,crypto.randomUUID(),'download'),roomId:owner.roomId,
        deviceId:owner.identity.publicBundle.deviceId,blobId:crypto.randomUUID(),direction:'download',originalSize:32*1024**2,chunkSize:2097152,
        chunkCount:16,token:'a'.repeat(43),expiresAt:Date.now()+60000,state:'paused',updated:Date.now()};
      // Use a matching opaque ID; the real worker validates this binding too.
      task.id=transfers.cipherTransferId(task.roomId,task.deviceId,task.blobId,'download');
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room-cipher-transfers-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      await new Promise((resolve,reject)=>{const tx=db.transaction('tasks','readwrite');tx.objectStore('tasks').put(task);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
      Object.defineProperty(navigator.serviceWorker,'controller',{configurable:true,value:{postMessage(){}}});
      const originalFetch=window.fetch;let requests=0;
      window.fetch=async(input,init)=>{
        if(String(input).endsWith('/transfer')){
          if(init?.method==='POST'){requests++;await transfers.cancelCipherTransfer(task.id);return Response.json({token:'b'.repeat(43),expiresAt:Date.now()+60000});}
          if(init?.method==='DELETE')return Response.json({ok:true});
        }
        return originalFetch(input,init);
      };
      let rejected=false;
      try{await transfers.prepareCipherTransfer({roomId:task.roomId,deviceId:task.deviceId,accessToken:'fixture',manifest:task,direction:'download',signal:new AbortController().signal,expectedTaskId:task.id});}
      catch{rejected=true;}
      finally{window.fetch=originalFetch;delete navigator.serviceWorker.controller;}
      const rows=await transfers.listCipherTransfers(task.roomId,task.deviceId);
      return {rejected,requests,matching:rows.filter(row=>row.blobId===task.blobId).map(row=>({id:row.id,state:row.state})),id:task.id};
    });
    assert.equal(generationFence.rejected,true,'recovery rejects a cancellation committed during grant renewal');
    assert.equal(generationFence.requests,1);
    assert.deepEqual(generationFence.matching,[{id:generationFence.id,state:'cancelled'}],'recovery never creates a replacement for a cancelled generation');
    assert.deepEqual(errors,[]);await page.close();await browser.close();browser=undefined;
  }
  console.log('Video download consent, encrypted cover, duration and stable geometry passed in Chromium/WebKit.');
}finally{await browser?.close();await server.close();}
