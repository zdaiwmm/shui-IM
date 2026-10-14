import { auditP1Surface } from './helpers/p1-surface-audit.mjs';
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
let browser, page;
try {
  await server.listen();
  browser = process.env.MEME_WEBKIT === '1' ? await webkit.launch() : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 }, hasTouch: true,
  });
  if (process.env.MEME_CPU_RATE) {
    const rate = Number(process.env.MEME_CPU_RATE);
    if (!Number.isFinite(rate) || rate < 1 || rate > 8) throw new Error('Invalid MEME_CPU_RATE');
    await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate });
  }
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__memes`);
  await page.evaluate(async (animation) => {
    await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles(); await import('/src/memes.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    // Bounded synthetic-fixture diagnostics make intermittent CI navigation races actionable.
    const { MemePicker } = await import('/src/lib/meme-picker.ts');
    const events = []; window.memeTestEvents = events;
    for (const name of ['pointerdown', 'pointerup', 'click']) document.addEventListener(name, event => {
      if (event.target instanceof Element && event.target.closest('.meme-panel')) {
        events.push({ action: name, target: event.target.tagName, className: event.target.getAttribute('class') });
        if (events.length > 48) events.shift();
      }
    }, true);
    for (const key of ['local', 'clear', 'back', 'submit', 'showPack', 'togglePack', 'install', 'dispose']) {
      const original = MemePicker.prototype[key];
      MemePicker.prototype[key] = function (...args) {
        events.push({ action: key, generation: this.generation, detail: this.packDetail, overlay: Boolean(this.overlay), busy: this.busy });
        if (events.length > 48) events.shift();
        return original.apply(this, args);
      };
    }
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
    app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true }; app.uiPreferencesHydrated = true;
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
    const realFetch = window.fetch.bind(window); const requests = []; const mediaRequests = [];
    const formerPack = { id: 'synthetic-pack', title: 'Synthetic pack' };
    const packSettings = { autoHide: false };
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
      if (url.pathname.endsWith('/memes/pack')) return Response.json({id:'a'.repeat(32),title:'测试合集',autoHide:packSettings.autoHide,items:files.slice(0,3).map((file,index)=>({id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,title:file.name,autoHide:packSettings.autoHide}))});
      if (url.pathname.endsWith('/memes/media')) { const id=JSON.parse(init.body).id; mediaRequests.push(id); const file=id.startsWith('11111111')?networkGif:files[Number(id.slice(-2))%files.length]; return new Response(file,{headers:{'Content-Type':file.type}}); }
      if (url.pathname.startsWith('/stickers/') || url.pathname.startsWith('/gifs/')) throw new Error('Bundled media requested');
      return realFetch(input,init);
    };
    window.fixture = { app, vault, session, controller, files, sent, packSettings, msg, requests, mediaRequests, networkGif };
  }, [...animatedWebp]);
  await page.locator('#open-memes').click();
  await page.locator('.fluent-emoji-tile').first().waitFor();
  assert.equal(await page.locator('.fluent-emoji-tile').count(),64);
  assert.equal(await page.locator('.meme-tabs,input[type=search],.meme-open-search').count(),0);
  assert.equal(await page.locator('[data-shortcut=emoji]').count(),1);
  assert.deepEqual(await page.locator('.meme-pack-shortcuts > button').evaluateAll(buttons=>buttons.map(b=>b.dataset.shortcut)),['add','emoji']);
  assert.equal(await page.evaluate(()=>window.fixture.requests.length),0,'Opening Emoji must not query the catalog');
  const draft=await page.locator('#message-input').inputValue();
  await page.locator('.emoji-grid:not(.fluent-emoji-grid) .emoji-tile').first().click();
  assert.ok((await page.locator('#message-input').inputValue()).includes(draft),'Unicode insertion lost the chat draft');
  await page.locator('.fluent-emoji-tile').first().click();
  await page.waitForFunction(()=>window.fixture.sent.length===1);
  assert.ok(await page.evaluate(async()=>{
    const bytes=await (await fetch('/space-avatars/fluent-slightly_smiling_face.webp')).arrayBuffer();
    return JSON.stringify([...new Uint8Array(bytes)])===JSON.stringify([...new Uint8Array(window.fixture.sent[0])]);
  }),'Fluent sending must preserve the bundled animation bytes');
  await page.locator('[data-shortcut=add]').click();
  await page.locator('.meme-pack-cover').waitFor();
  assert.ok(await page.locator('.meme-search-header').isVisible());
  assert.equal(await page.locator('input[type=search]').count(),0);
  assert.ok(await page.evaluate(()=>window.fixture.requests.every(request=>request.keyword===''&&request.kind==='stickers')));
  await page.locator('.meme-pack-cover').click();
  await page.waitForFunction(()=>document.querySelector('.meme-pack-add')?.textContent==='添加');
  await page.locator('.meme-pack-add').click();
  await page.waitForFunction(()=>document.querySelector('.meme-pack-add')?.textContent==='解除添加');
  for(let attempt=0;attempt<2;attempt++) {
    await page.locator('.meme-pack-add').click(); await page.waitForFunction(()=>document.querySelector('.meme-pack-add')?.textContent==='添加');
    await page.locator('.meme-pack-add').click(); await page.waitForFunction(()=>document.querySelector('.meme-pack-add')?.textContent==='解除添加');
  }
  await page.locator('.meme-back').click(); await page.locator('.meme-pack-cover').waitFor();
  await page.locator('.meme-back').click(); await page.locator('.meme-search-dialog').waitFor({state:'detached'});
  await page.locator('[data-shortcut^="pack:"]').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-pack-list section').length===1);
  await page.waitForFunction(()=>document.querySelector('.meme-pack-grid .meme-tile img')?.naturalWidth>0);
  const expectedStickerWidth=(await page.locator('.meme-pack-grid .meme-tile').first().boundingBox()).width;
  const shortcutBounds = await page.locator('.meme-pack-shortcuts').boundingBox();
  const shortcutOverflow = await page.locator('.meme-pack-shortcuts').evaluate(bar => {
    if (bar.scrollWidth - bar.clientWidth <= 0) {
      for (let index = 0; index < 8; index++) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.syntheticShortcut = 'true'; button.dataset.shortcut = `pack:synthetic-${index}`;
        button.style.flex = '0 0 44px'; button.setAttribute('aria-label', `synthetic ${index}`); bar.append(button);
      }
    }
    return bar.scrollWidth - bar.clientWidth;
  });
  assert.ok(shortcutOverflow > 0, `Sticker shortcuts did not overflow horizontally: ${shortcutOverflow}`);
  const sampleShortcutScroll = async () => page.locator('.meme-pack-shortcuts').evaluate(async bar => {
    const values = [];
    const deadline = performance.now() + 420;
    while (performance.now() < deadline) {
      values.push(bar.scrollLeft);
      await new Promise(requestAnimationFrame);
    }
    return { values, max: bar.scrollWidth - bar.clientWidth };
  });
  const dispatchShortcutDrag = async (startX, endX, pointerId) => page.locator('.meme-pack-shortcuts').evaluate((bar, details) => {
    const button = bar.querySelector('button[data-shortcut^="pack:"]');
    if (!button) throw new Error('No sticker shortcut available for gesture test');
    const bounds = bar.getBoundingClientRect();
    const init = { bubbles: true, button: 0, pointerId: details.pointerId, isPrimary: true, pointerType: 'touch', clientY: bounds.top + bounds.height / 2 };
    button.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: details.startX }));
    for (let step = 1; step <= 8; step++) {
      window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: details.startX + (details.endX - details.startX) * step / 8 }));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: details.endX }));
  }, { startX, endX, pointerId });
  await page.locator('.meme-pack-shortcuts').evaluate(bar => { bar.scrollLeft = 0; });
  await dispatchShortcutDrag(shortcutBounds.x + shortcutBounds.width * 0.72, shortcutBounds.x + 8, 101);
  await page.waitForTimeout(120);
  const shortcutAfterDrag = await page.locator('.meme-pack-shortcuts').evaluate(bar => ({ scrollLeft: bar.scrollLeft, max: bar.scrollWidth - bar.clientWidth }));
  assert.ok(shortcutAfterDrag.scrollLeft > 0, `Sticker shortcuts did not follow the drag: ${JSON.stringify(shortcutAfterDrag)}`);
  await dispatchShortcutDrag(shortcutBounds.x + 8, shortcutBounds.x + shortcutBounds.width + 100, 102);
  const shortcutLeftSettling = await sampleShortcutScroll();
  const shortcutSettled = await page.locator('.meme-pack-shortcuts').evaluate(bar => ({ scrollLeft: bar.scrollLeft, max: bar.scrollWidth - bar.clientWidth }));
  assert.ok(Math.abs(shortcutSettled.scrollLeft) <= 1, `Sticker shortcut edge did not rebound to the start: ${JSON.stringify(shortcutSettled)}`);
  assert.ok(Math.max(...shortcutLeftSettling.values) <= 1, `Sticker shortcut moved away from the left edge while settling: ${JSON.stringify(shortcutLeftSettling)}`);
  await page.locator('.meme-pack-shortcuts').evaluate(bar => { bar.scrollLeft = bar.scrollWidth - bar.clientWidth; });
  await dispatchShortcutDrag(shortcutBounds.x + shortcutBounds.width - 8, shortcutBounds.x - 100, 103);
  const shortcutRightSettling = await sampleShortcutScroll();
  assert.ok(Math.min(...shortcutRightSettling.values) >= shortcutRightSettling.max - 1,
    `Sticker shortcut moved back from the right edge while settling: ${JSON.stringify(shortcutRightSettling)}`);
  await page.locator('.meme-pack-shortcuts').evaluate(bar => { bar.scrollLeft = bar.scrollWidth - bar.clientWidth; });
  await page.locator('.meme-pack-shortcuts').evaluate(bar => {
    const bounds = bar.getBoundingClientRect();
    const init = { bubbles: true, button: 0, pointerId: 105, isPrimary: true, pointerType: 'touch', clientY: bounds.top + bounds.height / 2 };
    const button = bar.querySelector('button[data-shortcut^="pack:"]');
    button.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: bounds.right - 8 }));
    window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: bounds.left - 100 }));
    window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: bounds.left - 80 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: bounds.left - 80 }));
  });
  await page.waitForTimeout(120);
  const sameGestureReversed = await page.locator('.meme-pack-shortcuts').evaluate(bar => ({ scrollLeft: bar.scrollLeft, max: bar.scrollWidth - bar.clientWidth }));
  assert.ok(sameGestureReversed.scrollLeft < sameGestureReversed.max - 1,
    `Sticker shortcut kept the right-edge overshoot after reversing in one gesture: ${JSON.stringify(sameGestureReversed)}`);
  await dispatchShortcutDrag(shortcutBounds.x + 8, shortcutBounds.x + shortcutBounds.width + 100, 104);
  await page.waitForTimeout(120);
  const shortcutReversed = await page.locator('.meme-pack-shortcuts').evaluate(bar => ({ scrollLeft: bar.scrollLeft, max: bar.scrollWidth - bar.clientWidth }));
  assert.ok(shortcutReversed.scrollLeft < shortcutReversed.max - 1,
    `Sticker shortcut did not reverse immediately from the right edge: ${JSON.stringify(shortcutReversed)}`);
  await page.locator('.meme-pack-shortcuts [data-synthetic-shortcut="true"]').evaluateAll(nodes => nodes.forEach(node => node.remove()));
  await page.waitForTimeout(600);
  await page.locator('.meme-pack-shortcuts button[aria-label="测试合集，长按拖动排序"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-pack-list section').length===1);
  assert.equal(await page.locator('button[data-kind]').count(), 0);
  await page.locator('.meme-pack-shortcuts').evaluate(bar => {
    window.retainedShortcut = bar.querySelector('img');
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 100, clientY: 500 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 100, clientY: 400 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 100, clientY: 400 }));
  });
  await page.locator('.meme-expanded-dialog').waitFor();
  await page.waitForFunction(() => !document.querySelector('.meme-panel').getAnimations().some(animation => animation.playState === 'running'));
  assert.equal(await page.locator('.meme-tabs').count(), 0);
  assert.equal(await page.locator('.meme-collapse').isVisible(), true);
  await page.locator('.meme-pack-shortcuts').evaluate(bar => {
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientX: 100, clientY: 60 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientX: 100, clientY: 180 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 100, clientY: 180 }));
  });
  await page.locator('.meme-expanded-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.retainedShortcut === document.querySelector('.meme-pack-shortcuts img')), true, 'Dragging should retain decoded shortcuts');
  assert.equal(await page.locator('.meme-collapse').isVisible(), true);
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
  await page.locator('[data-shortcut^="pack:"]').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('.meme-pack-list section').length===1);
  assert.equal((await page.locator('.meme-pack-shortcuts img').first().boundingBox()).width,24);
  assert.ok(Math.abs((await page.locator('.meme-pack-grid .meme-tile').first().boundingBox()).width-expectedStickerWidth)<1, 'Sticker tile size differs');
  await page.evaluate(async () => {
    const { vault, session, files, controller } = window.fixture;
    await vault.installStickerPack(session, 'b'.repeat(32), '第二合集', [files[1]], controller.signal);
    await vault.installStickerPack(session, 'c'.repeat(32), '第三合集', [files[2]], controller.signal);
  });
  await page.locator('#open-memes').click();
  await page.locator('#meme-panel').waitFor({ state: 'detached' });
  await page.locator('#open-memes').click();
  await page.locator('[data-shortcut^="pack:"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.meme-pack-shortcuts [data-shortcut^="pack:"]').length === 3);
  const initialPackOrder = await page.locator('.meme-pack-shortcuts [data-shortcut^="pack:"]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label').split('，')[0]));
  assert.deepEqual(initialPackOrder, ['测试合集', '第二合集', '第三合集']);
  await page.locator('.meme-pack-shortcuts [aria-label="第二合集，长按拖动排序"]').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const init = { bubbles: true, button: 0, pointerId: 91, isPrimary: true, pointerType: 'touch', clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
    element.dispatchEvent(new PointerEvent('pointerdown', init));
  });
  await page.waitForTimeout(540);
  assert.equal(await page.locator('.meme-pack-shortcuts').getAttribute('data-reordering'), 'true', 'Long press did not lift the sticker shortcut');
  assert.equal(await page.locator('.meme-shortcut-float').count(), 1, 'Lifted shortcut is not floating');
  await page.evaluate(() => {
    const target = document.querySelector('.meme-pack-shortcuts [aria-label="第三合集，长按拖动排序"]');
    const bounds = target.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 91, isPrimary: true, pointerType: 'touch', clientX: bounds.right + 8, clientY: bounds.top + bounds.height / 2 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 91, isPrimary: true, pointerType: 'touch', clientX: bounds.right + 8, clientY: bounds.top + bounds.height / 2 }));
  });
  await page.waitForFunction(() => !document.querySelector('.meme-shortcut-float'));
  await page.waitForFunction(async () => (await window.fixture.vault.loadStickerPacks(window.fixture.session)).map(pack => pack.title).join('|') === '测试合集|第三合集|第二合集');
  assert.deepEqual(await page.locator('.meme-pack-shortcuts [data-shortcut^="pack:"]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label').split('，')[0])), ['测试合集', '第三合集', '第二合集']);
  const unchangedButton = page.locator('.meme-pack-shortcuts [aria-label="测试合集，长按拖动排序"]');
  const unchangedBefore = await unchangedButton.boundingBox();
  await unchangedButton.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 92, isPrimary: true, pointerType: 'touch', clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }));
  });
  await page.waitForTimeout(540);
  assert.equal(await page.locator('.meme-shortcut-float').count(), 1, 'Stationary long press did not enter reorder mode');
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 92, isPrimary: true, pointerType: 'touch' })));
  await page.waitForFunction(() => !document.querySelector('.meme-shortcut-float'));
  assert.deepEqual(await page.evaluate(async () => (await window.fixture.vault.loadStickerPacks(window.fixture.session)).map(pack => pack.title)), ['测试合集', '第三合集', '第二合集'], 'Stationary release changed the saved order');
  const unchangedAfter = await unchangedButton.boundingBox();
  assert.ok(Math.abs(unchangedAfter.x - unchangedBefore.x) < 1 && Math.abs(unchangedAfter.y - unchangedBefore.y) < 1, 'Stationary release did not return the shortcut to its original slot');
  await page.locator('.meme-pack-shortcuts [aria-label="第三合集，长按拖动排序"]').press('Alt+ArrowLeft');
  await page.waitForFunction(async () => (await window.fixture.vault.loadStickerPacks(window.fixture.session)).map(pack => pack.title).join('|') === '第三合集|测试合集|第二合集');
  await page.locator('.meme-pack-shortcuts [aria-label="第三合集，长按拖动排序"]').press('Alt+ArrowRight');
  await page.waitForFunction(async () => (await window.fixture.vault.loadStickerPacks(window.fixture.session)).map(pack => pack.title).join('|') === '测试合集|第三合集|第二合集');
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
    const installed=(await vault.loadStickerPacks(session)).find(pack=>pack.id==='a'.repeat(32));
    if(!installed || installed.items.length!==3) throw new Error('Installed source pack missing');
    // Shortcut reordering and unrelated favorites do not identify an original.
    // Verify all three exact source files through their authenticated digest.
    for(const original of files.slice(0,3)) {
      const bytes=new Uint8Array(await original.arrayBuffer());
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      const member=installed.items.find(item=>item.digest===digest);
      if(!member) throw new Error(`Installed pack source missing: ${original.name}`);
      const restored=await vault.loadMemeFavoriteFile(session,member,controller.signal);
      if(restored.size!==original.size || JSON.stringify([...new Uint8Array(await restored.arrayBuffer())])!==JSON.stringify([...bytes])) throw new Error('Installed pack original changed');
    }
    try { await vault.installStickerPack(stale,'b'.repeat(32),'Stale pack',[files[0]],controller.signal); throw new Error('Stale pack install succeeded'); }
    catch(error) { if(error.message==='Stale pack install succeeded') throw error; }
    try { await vault.removeStickerPack(session,installed.id,cancelled.signal); throw new Error('Cancelled pack removal succeeded'); }
    catch(error) { if(error.message==='Cancelled pack removal succeeded') throw error; }
    if((await vault.loadStickerPacks(session)).length!==3) throw new Error('Failed pack mutation changed index');
  });
  const out=process.argv[2]; if(out) await mkdir(out,{recursive:true});
  for(const [width,height] of [[320,720],[393,852],[820,1000],[1440,1000]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(()=>{window.fixture.app.closeMemePicker(); window.fixture.app.openMemePicker();});
    await page.locator('[data-shortcut=emoji]').click(); await page.locator('.fluent-emoji-tile').first().waitFor();
    const bounds=await page.locator('.meme-panel').boundingBox();
    assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=width+1&&bounds.y>=-1,JSON.stringify(bounds));
    assert.equal(await page.locator('[data-shortcut=emoji]').count(),1);
    assert.ok(await page.locator('.meme-pack-shortcuts > button').evaluateAll(buttons=>buttons.every(b=>b.getBoundingClientRect().height>=44)));
    await page.locator('[data-shortcut=add]').click(); await page.locator('.meme-pack-cover').waitFor();
    assert.equal(await page.locator('input[type=search],.meme-tabs').count(),0);
    if(out) await page.screenshot({path:path.join(out,`catalog-${width}.png`)});
    await page.locator('.meme-back').click(); await page.locator('.meme-search-dialog').waitFor({state:'detached'});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('[data-shortcut=emoji]').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.fluent-emoji-tile img')].every(img=>img.src.endsWith('-still.webp')));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));});
  assert.equal(await page.evaluate(()=>window.fixture.app.privacyCovered),false,'Visible blur must not lock the expression panel');
  await page.evaluate(()=>window.fixture.app.lockNow());
  assert.equal(await page.locator('.meme-panel,.meme-preview,.meme-search-dialog').count(),0,'Lock retained expression surfaces');
  assert.deepEqual(errors,[]);
  console.log('MEME_PICKER_OK: consolidated rail, Fluent original-byte sends, Unicode draft, catalog install/remove, encrypted originals, ordering, responsive and privacy teardown.');
} catch (error) {
  console.error('MEME_TEST_STATE',await page?.evaluate(()=>({view:document.querySelector('.meme-panel')?.dataset.view,covered:window.fixture?.app.privacyCovered})).catch(()=>null));
  throw error;
} finally { await browser?.close(); await server.close(); }
