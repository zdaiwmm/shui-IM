import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir=await mkdtemp(path.join(tmpdir(),'link-preview-browser-'));
let backend,vite;
const xRequests = [];
let xCover, xPortraitCover, articleImage, sentPreviewGate;
const articleTitle = '雨后的旧书店';
const articleAuthor = '林照 · @public_author';
const articleUrl = 'https://x.com/public_author/status/223456';
const sendArticleUrl = 'https://x.com/public_author/status/223457';
const noDraftArticleUrl = 'https://x.com/public_author/status/223458';
const articleDescription = '雨停以后，桥下的旧书店还开着。';
const postUrl = 'https://x.com/public_author/status/123456';
const fullPost = '这个公开帖子有两段视频。' + '这是展开之后呈现的正文段落。\n'.repeat(12);
const ticket = 'https://aix.shui.click/v1/x/media/' + 't'.repeat(43);
try{
  backend=await startServer({host:'127.0.0.1',port:0,dataDir,quiet:true,xPostGatewayToken:'t'.repeat(43),
    xPostGatewayFetch:async (_url, request) => {
      const packet = JSON.parse(request.body);
      xRequests.push(packet);
      if (['223456', '223457', '223458'].includes(packet.postId)) {
        if (packet.action === 'article') return Response.json({ title: articleTitle, author: articleAuthor, blocks: [
          { kind: 'paragraph', runs: [{ text: articleDescription, bold: true }] },
          { kind: 'image', alt: '桥下的旧书店', caption: '雨天的书店', image: articleImage },
          { kind: 'heading', level: 2, runs: [{ text: '桥下的散步' }] },
          { kind: 'quote', runs: [{ text: '雨停就开。', italic: true }] },
          { kind: 'list-item', ordered: true, depth: 0, runs: [{ text: '第一条路' }] },
          { kind: 'list-item', ordered: true, depth: 1, runs: [{ text: '从桥下经过' }] },
          ...Array.from({ length: 18 }, () => ({ kind: 'paragraph', runs: [{ text: articleDescription.repeat(3) }] })),
        ] });
        if (packet.postId === '223457') await sentPreviewGate.promise;
        return Response.json({ title: articleAuthor, description: articleDescription, canRead: true, videos: [],
          article: { title: articleTitle, author: articleAuthor } });
      }
      if (packet.postId !== '123456') return Response.json({}, { status: 404 });
      if (packet.action === 'text') return Response.json({ text: fullPost });
      if (packet.action === 'playback') return Response.json({ url: ticket });
      return Response.json({ title: '@public_author', description: '这个公开帖子有两段视频。', canRead: true,
        videos: [{ id: '7_001', cover: xCover }, { id: '7_002', cover: xPortraitCover }] });
    },
  });
  vite=await createServer({root:process.cwd(),configFile:false,logLevel:'error',plugins:[{name:'preview-test-app',transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':{target:`http://127.0.0.1:${backend.port}`,changeOrigin:false},'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});
  await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  for(const [name,engine] of Object.entries({chromium,webkit})){
    const browser=await engine.launch(name==='chromium'&&!process.env.CI?{channel:'chrome'}:{});
    const contexts=[];
    const engineStart = xRequests.length;
    const lookupsFor = id => xRequests.slice(engineStart).filter(request => request.postId === id);
    sentPreviewGate = Promise.withResolvers();
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
      const peerXRequests = [];
      await contexts[1].route('**/api/rooms/*/x-post', async route => {
        peerXRequests.push(route.request().postDataJSON());
        await route.continue();
      });
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
      await row.locator('.link-preview-close').click();assert.equal(await input.evaluate(n=>document.activeElement===n),true,'Closing a preview keeps editing focus');await input.fill('https://preview.example/article 还有一些文字');await source.waitForTimeout(650);
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
      xCover = { mimeType: 'image/png', data: Buffer.from(image, 'base64').toString('base64url') };
      const testJpeg = async (width, height) => Buffer.from(await source.evaluate(([width, height]) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = '#347b58';
        context.fillRect(0, 0, width, height);
        return canvas.toDataURL('image/jpeg').split(',')[1];
      }, [width, height]), 'base64').toString('base64url');
      xPortraitCover = { mimeType: 'image/jpeg', data: await testJpeg(300, 400) };
      articleImage = { mimeType: 'image/jpeg', data: await testJpeg(360, 240), width: 360, height: 240 };
      const beforeX = xRequests.length;
      let mediaRequests = 0;
      await contexts[1].route(ticket, async route => {
        mediaRequests++;
        await route.abort();
      });
      await input.fill(postUrl);
      await row.filter({ hasText: '@public_author' }).waitFor();
      await source.locator('#send-text').click();
      const xCard = peer.locator('.x-post-card');
      await xCard.waitFor();
      await peer.waitForFunction(() => document.querySelector('.x-post-poster')?.naturalWidth > 0);
      assert.deepEqual(xRequests.slice(beforeX), [{ action: 'preview', postId: '123456' }]);
      assert.equal(mediaRequests, 0, 'Receiving a card only loads its encrypted snapshot');
      assert.equal(await xCard.locator('video').count(), 0);
      assert.equal(await xCard.locator('.x-post-page').innerText(), '1 / 2');
      const videoTrack = xCard.locator('.x-post-track');
      const trackRatio = () => videoTrack.evaluate(node => node.clientWidth / node.clientHeight);
      assert.ok(Math.abs(await trackRatio() - 2) < 0.02, 'The first cover sets the wide ratio');
      assert.ok(await xCard.locator('.x-post-page').evaluate(node => {
        const style = getComputedStyle(node);
        return style.position === 'absolute' && style.backgroundColor === 'rgba(0, 0, 0, 0)';
      }), 'Pagination is a bare overlay inside the cover');
      await xCard.getByRole('button', { name: '查看全文' }).click();
      await xCard.getByText('这是展开之后呈现的正文段落。', { exact: false }).waitFor();
      assert.equal(await peer.getByRole('dialog').count(), 0, 'Full text stays within the bubble');
      await xCard.getByRole('button', { name: '收起全文' }).click();
      assert.equal(await xCard.getByText('这是展开之后呈现的正文段落。', { exact: false }).count(), 0);
      await xCard.getByRole('button', { name: '下一个视频' }).click();
      await peer.waitForFunction(() => document.querySelector('.x-post-page')?.textContent === '2 / 2');
      assert.ok(Math.abs(await trackRatio() - 0.75) < 0.02, 'The second cover sets its own portrait ratio');
      assert.equal(mediaRequests, 0, 'Switching covers does not preload videos');
      if (process.env.QUIET_ROOM_PREVIEW_QA) {
        await xCard.screenshot({ path: path.join(process.env.QUIET_ROOM_PREVIEW_QA, `${name}-x-post-card.png`) });
      }
      await xCard.locator('.x-post-stage:not([inert])').getByRole('button', { name: '播放视频' }).click();
      await xCard.getByText('媒体载入失败，请重试').waitFor();
      assert.ok(mediaRequests > 0);
      assert.deepEqual(xRequests.slice(beforeX), [
        { action: 'preview', postId: '123456' }, { action: 'text', postId: '123456' },
        { action: 'playback', postId: '123456', mediaId: '7_002' },
      ]);
      assert.equal(await xCard.locator('video').count(), 0, 'The failed stream is released');
      await input.fill('https://x.com/public_author/status/123457');
      await row.filter({ hasText: '暂时无法' }).waitFor();
      await source.locator('#send-text').click();
      await peer.locator('.message-web-link[href$="/123457"]').waitFor();
      assert.equal(await peer.locator('.x-post-card').count(), 1, 'An unavailable post sends a regular link');
      await source.locator('.x-post-after-send').filter({ hasText: '暂时无法生成卡片' }).waitFor();

      await input.fill(articleUrl);
      await row.filter({ hasText: articleTitle }).waitFor();
      await source.locator('#send-text').click();
      const articleCard = peer.locator('.x-post-card').filter({ hasText: articleTitle });
      await articleCard.waitFor();
      const articleButton = articleCard.getByRole('button', { name: '查看全文' });
      assert.equal(await articleButton.getAttribute('aria-haspopup'), 'dialog');
      assert.equal(lookupsFor('223456').length, 1, 'No lookup merely on receipt');
      await articleButton.click();
      const reader = peer.getByRole('dialog', { name: 'X Article' });
      await reader.locator('h1').filter({ hasText: articleTitle }).waitFor();
      await peer.waitForFunction(() => document.querySelector('.x-article-reader figure img')?.naturalWidth === 360);
      assert.equal(await reader.getByRole('img', { name: '桥下的旧书店' }).getAttribute('src').then(url => url.startsWith('blob:')), true);
      assert.equal(await reader.locator('figure figcaption').textContent(), '雨天的书店');
      assert.equal(await reader.locator('blockquote em').textContent(), '雨停就开。');
      assert.equal(await reader.locator('ol > li > ol > li').textContent(), '从桥下经过');
      const scroll = reader.locator('.x-article-reader-scroll');
      const beforeReading = await peer.evaluate(() => window.app.chatScrollTop);
      await scroll.evaluate(node => { node.scrollTop = 480; });
      assert.ok(await scroll.evaluate(node => node.scrollTop) > 300, 'Only the reader scrolls through the article');
      assert.equal(await peer.evaluate(() => window.app.chatScrollTop), beforeReading);
      if (process.env.QUIET_ROOM_PREVIEW_QA) await peer.screenshot({ path: path.join(process.env.QUIET_ROOM_PREVIEW_QA, `${name}-x-article-reader.png`) });
      const articleImageUrl = await reader.locator('figure img').getAttribute('src');
      await reader.getByRole('button', { name: '关闭阅读器' }).click();
      await reader.waitFor({ state: 'detached' });
      assert.equal(await articleButton.evaluate(node => node === document.activeElement), true);
      assert.equal(await peer.evaluate(url => window.previewUrls.has(url), articleImageUrl), false);
      await articleButton.click();
      await reader.locator('h1').waitFor();
      await peer.evaluate(() => window.app.obscurePrivacySurface());
      await reader.waitFor({ state: 'detached' });
      assert.equal(await peer.evaluate(() => window.previewUrls.size), 0);
      await peer.evaluate(() => window.app.revealPrivacySurface());

      await input.fill(sendArticleUrl);
      await row.filter({ hasText: '正在获取链接预览' }).waitFor();
      await source.locator('#send-text').click();
      const sent = source.locator('.message.outgoing').filter({ has: source.locator('.message-web-link[href$="/223457"]') });
      await sent.locator('.x-post-after-send').filter({ hasText: '正在解析链接' }).waitFor();
      const pendingRow = await sent.elementHandle();
      const sentId = await pendingRow.getAttribute('data-client-msg-id');
      await peer.locator('.message-web-link[href$="/223457"]').waitFor();
      assert.equal(await peer.locator('.x-post-card').count(), 2);
      sentPreviewGate.resolve();
      const resolved = source.locator(`.message[data-client-msg-id="${sentId}"]`);
      await resolved.locator('.x-post-card').filter({ hasText: articleTitle }).waitFor();
      assert.equal(await resolved.evaluate((node, before) => node === before, pendingRow), true, 'Update the existing outgoing row');
      assert.equal(await resolved.locator('.x-post-original').getAttribute('href'), sendArticleUrl);
      assert.equal(lookupsFor('223457').length, 1, 'The sent message takes over the in-flight draft lookup');
      assert.equal(peerXRequests.some(request => request.postId === '223457'), false, 'The recipient performs no automatic lookup');
      await source.evaluate(async () => {
        const { loadLocalXPreviews } = await import('/src/lib/vault.ts');
        return new Promise((resolve, reject) => {
          let attempts = 0;
          const tick = async () => {
            if ((await loadLocalXPreviews(window.app.session)).size) resolve();
            else if (++attempts === 25) reject(new Error('Local preview was not sealed'));
            else setTimeout(() => void tick(), 30);
          };
          void tick();
        });
      });
      await source.reload();
      await resolved.locator('.x-post-card').filter({ hasText: articleTitle }).waitFor();
      assert.equal(lookupsFor('223457').length, 1, 'The sealed snapshot restores without a new disclosure');
      await source.evaluate(url => {
        const input = document.querySelector('#message-input');
        input.value = url;
        input.dispatchEvent(new Event('input'));
        document.querySelector('#send-text').click();
      }, noDraftArticleUrl);
      await source.locator(`.x-post-original[href="${noDraftArticleUrl}"]`).waitFor();
      await peer.locator('.message-web-link[href$="/223458"]').waitFor();
      assert.equal(lookupsFor('223458').length, 1, 'Send starts lookup when the draft timer never ran');
      assert.equal(peerXRequests.some(request => request.postId === '223458'), false);
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
      console.log(`${name}: input preview, dismiss, stale result, encrypted large/compact cards, old-client fallback, X Article, inline X text, scoped video, after-send enrichment, reload and privacy cleanup passed`);
      if(process.env.QUIET_ROOM_PREVIEW_QA){await mkdir(process.env.QUIET_ROOM_PREVIEW_QA,{recursive:true});}
    }finally{sentPreviewGate.resolve();await Promise.all(contexts.map(c=>c.close()));await browser.close();}
  }
}finally{await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true});}
