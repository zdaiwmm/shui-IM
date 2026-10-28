import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir=await mkdtemp(path.join(tmpdir(),'link-preview-browser-'));
let backend,vite;
try{
  backend=await startServer({host:'127.0.0.1',port:0,dataDir,quiet:true});
  vite=await createServer({root:process.cwd(),configFile:false,logLevel:'error',plugins:[{name:'preview-test-app',transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});
  await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  for(const [name,engine] of Object.entries({chromium,webkit})){
    const browser=await engine.launch(name==='chromium'&&!process.env.CI?{channel:'chrome'}:{});
    const contexts=[];
    try{
      for(let i=0;i<2;i++){
        const context=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
        await context.addInitScript(()=>{
          Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedLink=text;}}});
          const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);window.previewUrls=new Set();
          URL.createObjectURL=blob=>{const url=create(blob);window.previewUrls.add(url);return url;};
          URL.revokeObjectURL=url=>{window.previewUrls.delete(url);revoke(url);};
        });contexts.push(context);
      }
      const source=await contexts[0].newPage(),peer=await contexts[1].newPage();
      await source.goto(origin);await source.locator('#create-room').click();await source.locator('#copy-invite').click();
      await source.waitForFunction(()=>!!window.copiedLink);await peer.goto(await source.evaluate(()=>window.copiedLink));
      await source.locator('#message-input:not([disabled])').waitFor();await peer.locator('#message-input:not([disabled])').waitFor();
      await source.waitForFunction(()=>window.app.session.vault.members.filter(m=>m.status==='active').length===2&&window.app.session.vault.members.filter(m=>m.status==='active').every(m=>m.capabilities.includes('link-preview-v1')));
      const image=await source.evaluate(()=>{const c=document.createElement('canvas');c.width=800;c.height=400;const ctx=c.getContext('2d');ctx.fillStyle='#2e7146';ctx.fillRect(0,0,800,400);ctx.fillStyle='#e0efdf';ctx.font='70px sans-serif';ctx.fillText('Preview',40,200);return c.toDataURL('image/png').split(',')[1];});
      let requests=0,peerRequests=0;
      await contexts[0].route('**/api/rooms/*/link-preview',async route=>{
        requests++;const {url}=route.request().postDataJSON();
        if(url.includes('/slow'))await new Promise(resolve=>setTimeout(resolve,1400));
        if(url.includes('/fail')){await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Unavailable'})});return;}
        const packet={url,siteName:'Example',title:url.includes('/new')?'New title':'Preview title',description:'A safe static preview',image:{mimeType:'image/png',data:Buffer.from(image,'base64').toString('base64url'),source:url.includes('/icon')?'icon':'content',width:800,height:400}};
        try{await route.fulfill({contentType:'application/json',body:JSON.stringify(packet)});}catch{/* Superseded/aborted request. */}
      });
      await contexts[1].route('**/api/rooms/*/link-preview',async route=>{peerRequests++;await route.abort();});
      const input=source.locator('#message-input'),row=source.locator('.link-preview-draft');
      await input.fill('https://preview.example/article');await row.filter({hasText:'Preview title'}).waitFor();
      if(process.env.QUIET_ROOM_PREVIEW_QA){await mkdir(process.env.QUIET_ROOM_PREVIEW_QA,{recursive:true});await source.screenshot({path:path.join(process.env.QUIET_ROOM_PREVIEW_QA,`${name}-input.png`)});}
      assert.equal(requests,1);
      await row.locator('.link-preview-close').click();await input.fill('https://preview.example/article 还有一些文字');await source.waitForTimeout(650);
      assert.equal(requests,1,'Dismissed URL must not reopen');assert.equal(await row.isVisible(),false);
      await input.fill('https://preview.example/slow-old');await row.filter({hasText:'正在获取'}).waitFor();
      await input.fill('https://preview.example/new');await row.filter({hasText:'New title'}).waitFor();await source.waitForTimeout(1500);
      assert.ok((await row.innerText()).includes('New title'),'Late old metadata cannot replace current draft');
      await source.locator('#send-text').click();await peer.locator('.message-link-preview').waitFor();
      const card=peer.locator('.message-link-preview').first();assert.equal(await card.getAttribute('data-layout'),'large');
      await peer.waitForFunction(()=>document.querySelector('.message-link-preview img')?.naturalWidth>0);
      assert.ok(await card.evaluate(c=>c.parentElement.querySelector('.message-meta').getBoundingClientRect().top>=c.getBoundingClientRect().bottom),'Message time must remain below the preview image');
      assert.equal(await card.getAttribute('target'),'_blank');assert.equal(await card.getAttribute('rel'),'noopener noreferrer');
      assert.equal(peerRequests,0,'Receiving a card must not fetch metadata');
      const snapshot=await peer.evaluate(()=>[...window.app.messages.values()].find(m=>m.payload.kind==='text'&&m.payload.preview)?.payload);
      assert.equal(snapshot.v,3);assert.ok(snapshot.preview.image.data.length<22000);
      await input.fill('https://preview.example/slow-send');await row.filter({hasText:'正在获取'}).waitFor();await source.locator('#send-text').click();
      await peer.locator('.message-web-link').filter({hasText:'slow-send'}).waitFor();await source.waitForTimeout(1500);
      assert.equal(await peer.locator('.message-link-preview').count(),1,'Sending while loading stays plain');
      await input.fill('https://preview.example/fail');await row.filter({hasText:'暂时无法'}).waitFor();const failedCount=requests;
      await row.locator('.link-preview-retry').click();await source.waitForFunction(()=>document.querySelector('.link-preview-draft')?.dataset.state==='failed');
      assert.equal(requests,failedCount+1);await input.fill('');assert.equal(await row.isVisible(),false);
      await input.fill('https://preview.example/icon');await row.filter({hasText:'Preview title'}).waitFor();await source.locator('#send-text').click();
      await peer.locator('.message-link-preview[data-layout=compact]').waitFor();
      await input.fill('https://preview.example/compat');await row.filter({hasText:'Preview title'}).waitFor();
      await source.evaluate(()=>{for(const m of window.app.session.vault.members)m.capabilities=m.capabilities.filter(c=>c!=='link-preview-v1');});
      await source.locator('#send-text').click();await peer.locator('.message-web-link').filter({hasText:'compat'}).waitFor();
      assert.equal(await peer.locator('.message-link-preview').count(),2,'Known older clients get plain text');
      await peer.reload();await peer.locator('.message-link-preview').first().waitFor();assert.equal(peerRequests,0,'History reload must not refetch');
      await contexts[1].route('https://preview.example/**',route=>route.fulfill({contentType:'text/html',body:'<title>Preview destination</title>'}));
      const original=peer.url();const [popup]=await Promise.all([contexts[1].waitForEvent('page'),peer.locator('.message-link-preview').first().click()]);
      await popup.waitForLoadState();assert.equal(peer.url(),original);assert.ok(popup.url().startsWith('https://preview.example/'));await popup.close();
      const overflow=await peer.locator('.message-link-preview').evaluateAll(cards=>cards.some(c=>c.scrollWidth>c.clientWidth+1));assert.equal(overflow,false);
      await peer.evaluate(()=>window.app.obscurePrivacySurface());
      assert.equal(await peer.evaluate(()=>window.previewUrls.size),0,'Privacy concealment revokes card object URLs even when the runtime remains');
      await peer.evaluate(()=>window.app.revealPrivacySurface());
      await peer.waitForFunction(()=>document.querySelector('.message-link-preview img')?.naturalWidth>0);
      if(process.env.QUIET_ROOM_PREVIEW_QA){
        await mkdir(process.env.QUIET_ROOM_PREVIEW_QA,{recursive:true});
        await peer.screenshot({path:path.join(process.env.QUIET_ROOM_PREVIEW_QA,`${name}-implemented.png`)});
      }
      await peer.evaluate(()=>window.app.lockNow());await peer.waitForFunction(()=>window.previewUrls.size===0);
      await input.fill('https://preview.example/slow-lock');await row.filter({hasText:'正在获取'}).waitFor();await source.evaluate(()=>window.app.lockNow());
      const afterLockRequests=requests;
      await source.waitForTimeout(1500);assert.equal(await source.locator('.link-preview-draft:visible').count(),0,'A new empty composer shell may mount, but a late preview must remain hidden');
      assert.equal(await source.locator('.link-preview-draft').allTextContents().then(values=>values.join('')),'');
      assert.equal(requests,afterLockRequests,'Restored drafts must not trigger fresh requests after lock');
      console.log(`${name}: input preview, dismiss, stale result, encrypted large/compact cards, old-client fallback, reload, new tab and privacy cleanup passed`);
      if(process.env.QUIET_ROOM_PREVIEW_QA){await mkdir(process.env.QUIET_ROOM_PREVIEW_QA,{recursive:true});}
    }finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
  }
}finally{await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true});}
