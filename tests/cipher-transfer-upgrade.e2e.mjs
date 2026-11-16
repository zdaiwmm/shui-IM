import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { expect } from 'playwright/test';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'cipher-worker-policy-'));
const policyServer = await startServer({ port: 0, dataDir, staticDir: path.resolve('public'), quiet: true });
let workerPolicy;
try {
  workerPolicy = (await fetch(`http://127.0.0.1:${policyServer.port}/sw.js`)).headers.get('content-security-policy');
} finally {
  await policyServer.close();
  await rm(dataDir, { recursive: true, force: true });
}

// The pre-transfer controller installs and claims pages, but ignores the new
// transport protocol. Keep the fixture independent of shallow Git history.
const legacyWorker = `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));`;
const previousSourceWorker = legacyWorker + `self.addEventListener('message',event=>{if(event.data?.type==='quiet-room-cipher-transfer-ready')event.ports[0].postMessage({version:1});});`;
const currentWorker = `
let fixtureSource;
const networkFetch = self.fetch.bind(self);
self.fetch = (input, init) => String(input)==='https://video.twimg.com/feature-probe.mp4'
  ? Promise.resolve(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Length':'3'}}))
  : fixtureSource && String(input).startsWith('https://video.twimg.com/popup-')
  ? Promise.resolve(new Response(fixtureSource, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(fixtureSource.size) } }))
  : networkFetch(input, init);
self.addEventListener('message', event => {
  if (event.data?.type === 'fixture-source') { fixtureSource = event.data.blob; event.ports[0].postMessage('ready'); }
});
` + (await readFile('public/sw.js', 'utf8')).replaceAll('__QUIET_ROOM_RELEASE_ID__', 'upgrade-current');
let upgraded = false;
let previousSource = false;
const uploaded = [];
const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use((request, response, next) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/__cipher-worker.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', workerPolicy);
    response.end(upgraded ? currentWorker : previousSource ? previousSourceWorker : legacyWorker);
    return;
  }
  if (url.pathname === '/__cipher_upgrade' || url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Isolated worker upgrade fixture</title>');
    return;
  }
  if (!url.pathname.startsWith('/api/rooms/')) { next(); return; }
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'PUT') {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { uploaded.push(Buffer.concat(chunks)); response.end('{}'); });
    return;
  }
  if (request.method === 'GET') {
    response.end(JSON.stringify({ uploadedIndexes: [], chunkCount: 1, expectedBytes: 17 }));
  } else {
    response.end(JSON.stringify({ token: 'A'.repeat(43), expiresAt: Date.now() + 3600_000 }));
  }
});

let browser;
async function popupDownload(browser, origin, engine, share) {
  upgraded = true;
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${origin}/__cipher_upgrade`);
    await page.evaluate(async () => {
      document.head.insertAdjacentHTML('beforeend', '<meta name="viewport" content="width=device-width,initial-scale=1">');
      document.body.innerHTML = '<main id="app"></main>';
      await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
      const vault = await import('/src/lib/vault.ts');
      const device = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active' };
      const session = await vault.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [device], identity: { publicBundle: device } }, 'worker-popup-fixture', 'password');
      const atom = (tag, bytes) => {
        const result = new Uint8Array(bytes.length + 8);
        new DataView(result.buffer).setUint32(0, result.length);
        result.set(new TextEncoder().encode(tag), 4); result.set(bytes, 8); return result;
      };
      const essence = new Blob([atom('ftyp',new TextEncoder().encode('isom0000')),atom('moov',[0]),atom('mdat',new Uint8Array(2 ** 20 + 7).fill(123))]);
      const source = new Blob([essence,atom('free',new Uint8Array(80))],{type:'video/mp4'});
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#8eaea5'; ctx.fillRect(0,0,240,140); ctx.fillStyle = '#466770'; ctx.fillRect(0,90,240,50);
      const poster = await new Promise(resolve => canvas.toBlob(resolve));
      const network = fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.hostname === 'api.fxtwitter.com') return Response.json({ code:200, tweet:{ id:'123', media:{ videos:[1,2].map(n=>({url:`https://video.twimg.com/popup-${n}.mp4`,duration:n*2,thumbnail_url:'https://pbs.twimg.com/fixture.png'})) } } });
        if (url.hostname === 'pbs.twimg.com') return new Response(poster,{headers:{'Content-Type':'image/png'}});
        if (url.hostname === 'video.twimg.com') {
          if (init.method !== 'HEAD') throw Error('The popup bypassed the real worker source download');
          return new Response(null,{headers:{'Content-Length':String(source.size)}});
        }
        return network(input,init);
      };
      await navigator.serviceWorker.register('/__cipher-worker.js', { scope:'/', updateViaCache:'none' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
      await new Promise((resolve,reject)=>{
        const channel = new MessageChannel();
        const timer = setTimeout(()=>reject(Error('Fixture worker initialization timed out')),5000);
        channel.port1.onmessage=()=>{clearTimeout(timer);channel.port1.close();resolve();};
        navigator.serviceWorker.controller.postMessage({type:'fixture-source',blob:source},[channel.port2]);
      });
      const post=navigator.serviceWorker.controller.postMessage.bind(navigator.serviceWorker.controller),handoffs=[];
      navigator.serviceWorker.controller.postMessage=(data,transfer)=>{
        if(data.source?.key instanceof CryptoKey)throw new DOMException('iPhone source-key clone failure','DataCloneError');
        const before=data.source?.keyBytes?.byteLength;
        post(data,transfer);
        if(before!==undefined)handoffs.push({before,after:data.source.keyBytes.byteLength});
      };
      const sent = [], sentNames = [], failedIds = [];
      const signal = new AbortController().signal;
      (await import('/src/lib/link-video-sheet.ts')).openLinkVideoSheet({root:document.querySelector('#app'),session,signal,active:()=>true,largeVideoReady:()=>true,onDispose:()=>{},send:async(file,id,_signal,progress)=>{
        if (file.size !== essence.size) throw Error('Sending changed the original media bytes');
        const actual=new Uint8Array(await file.arrayBuffer()),expected=new Uint8Array(await essence.arrayBuffer());
        if (!actual.every((byte,index)=>byte===expected[index])) throw Error('Sending changed media content');
        if (window.popupFixture.failNext) { window.popupFixture.failNext=false; failedIds.push(id); progress(.4); return false; }
        sent.push(id);sentNames.push(file.name);return true;
      }});
      window.popupFixture = {vault,session,signal,source,sent,sentNames,failedIds,handoffs};
    });
    const sheet = page.locator('.link-video-sheet');
    await sheet.getByRole('textbox').fill('https://x.com/demo/status/123');
    await sheet.locator('.link-video-choice img').first().waitFor();
    await sheet.getByRole('button',{name:'全选',exact:true}).click();
    // Re-adding the first result must keep display numbering and send order
    // consistent with the approved parsed-result order.
    await sheet.locator('.link-video-choice').first().click();
    await sheet.locator('.link-video-choice').first().click();
    const layout = await sheet.evaluate(sheet=>{
      const choices=[...sheet.querySelectorAll('.link-video-choice')].map(el=>el.getBoundingClientRect());
      return {sameRow:choices[0].top===choices[1].top,heading:getComputedStyle(sheet.querySelector('h2')).fontSize,inputRadius:getComputedStyle(sheet.querySelector('.link-video-field')).borderRadius,selected:[...sheet.querySelectorAll('.link-video-check')].map(el=>el.textContent)};
    });
    assert.deepEqual(layout,{sameRow:true,heading:'20px',inputRadius:'12px',selected:['1','2']});
    if (process.env.QUIET_ROOM_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.QUIET_ROOM_SCREENSHOT_DIR,`link-video-${engine}-${share?'send':'download'}.png`)});
    if (share) await page.evaluate(()=>{window.popupFixture.failNext=true;});
    await sheet.getByRole('button',{name:share?'下载并发送':'仅下载',exact:true}).click();
    if (share) {
      await sheet.getByRole('button',{name:'重试',exact:true}).waitFor();
      assert.equal(await sheet.locator('.link-video-batch-row').count(),2,'Failure keeps every item in the batch');
      assert.equal(await sheet.locator('.link-video-batch-row').first().getAttribute('data-phase'),'failed');
      assert.equal(await sheet.locator('.link-video-batch-row progress').first().evaluate(el=>el.value),.4,'A failure preserves acknowledged progress and stops indeterminate motion');
      await sheet.getByRole('button',{name:'重试',exact:true}).click();
    }
    await sheet.getByRole('status').filter({hasText:share?'已交给聊天发送':'已保存到我的下载'}).waitFor({timeout:20000});
    await expect.poll(() => page.evaluate(async share=>{
      const f=window.popupFixture;
      return (await f.vault.listLinkVideos(f.session,f.signal)).length===2 &&
        (await f.vault.listPendingLinkDownloads(f.session,f.signal)).length===0 && f.sent.length===(share?2:0);
    },share),{timeout:20000}).toBe(true);
    await sheet.locator('.link-video-batch-row').first().waitFor();
    const result=await page.evaluate(async()=>{
      const f=window.popupFixture,rows=await f.vault.listLinkVideos(f.session,f.signal);
      const original=new Uint8Array(await f.source.arrayBuffer());
      for(const row of rows){
        const restored=new Uint8Array(await (await f.vault.readLinkVideo(f.session,row.id,f.signal)).arrayBuffer());
        if(restored.length!==original.length||!restored.every((byte,i)=>byte===original[i]))throw Error('The private download changed bytes');
      }
      if(f.handoffs.length!==2||!f.handoffs.every(value=>value.before===32&&value.after===0))throw Error('Source grants must transfer ownership without cloning CryptoKey');
      return {private:rows.every(row=>!row.shared),sent:f.sent.length,names:f.sentNames,retriedOriginalId:f.failedIds.every(id=>f.sent.includes(id)),rows:document.querySelectorAll('.link-video-batch-row').length};
    });
    assert.deepEqual(result,{private:true,sent:share?2:0,names:share?['X-123-1.mp4','X-123-2.mp4']:[],retriedOriginalId:true,rows:2});
    assert.deepEqual(errors,[]);
    console.log(engine,share?'download and send':'download only','real worker popup passed');
  } finally {await page.close();}
}
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await engine.launch();
    // Slow language initialization can resume main.ts after window.load. The
    // release updater must still replace an existing pre-transfer controller.
    upgraded = false;
    const latePage = await browser.newPage({ serviceWorkers: 'allow' });
    await latePage.goto(`${origin}/__cipher_upgrade`);
    await latePage.evaluate(async () => {
      await navigator.serviceWorker.register('/__cipher-worker.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      window.oldController = navigator.serviceWorker.controller;
    });
    await latePage.evaluate(async () => {
      if (document.readyState !== 'complete') throw Error('Late initialization fixture must run after load');
      (await import('/src/lib/release-update.ts')).startReleaseUpdateDetection();
    });
    await latePage.waitForFunction(() => navigator.serviceWorker.controller !== window.oldController, null, { timeout: 10000 });
    console.log(name, 'late startup updated the legacy controller');
    await latePage.close();
    for (const cancelled of [false, true]) {
      upgraded = false; uploaded.length = 0;
      const page = await browser.newPage({ serviceWorkers: 'allow' });
      await page.goto(`${origin}/__cipher_upgrade`);
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/__cipher-worker.js', { scope: '/', updateViaCache: 'none' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        const transfers = await import('/src/lib/cipher-transfer.ts');
        const signal = new AbortController();
        const task = await transfers.prepareCipherTransfer({
          roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), accessToken: 'isolated-fixture', direction: 'upload', signal: signal.signal,
          manifest: { blobId: crypto.randomUUID(), originalSize: 1, chunkSize: 2097152, chunkCount: 1 },
        });
        await transfers.stageCipherPart(task, 0, new Uint8Array(17).fill(7).buffer);
        const oldController = navigator.serviceWorker.controller;
        const post = oldController.postMessage.bind(oldController);
        const messages = [];
        oldController.postMessage = (...args) => { messages.push(args[0]); post(...args); };
        window.upgradeFixture = { oldController, messages, signal, task, transfers };
        window.upgradeFixture.result = transfers.runCipherTransfer(task, signal.signal)
          .then(() => ({ outcome: 'done' }), error => ({ outcome: 'error', name: error.name, message: error.message }));
      });
      await page.waitForFunction(() => window.upgradeFixture.messages.length > 0);
      if (cancelled) await page.evaluate(async () => {
        const fixture = window.upgradeFixture;
        fixture.signal.abort(new DOMException('Explicitly cancelled during upgrade', 'AbortError'));
        await fixture.transfers.cancelCipherTransfer(fixture.task.id);
      });
      upgraded = true;
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== window.upgradeFixture.oldController);
      const result = await page.evaluate(() => window.upgradeFixture.result);
      console.log(name, cancelled ? 'cancelled upgrade' : 'active upgrade', JSON.stringify(result));
      if (cancelled) {
        assert.equal(result.name, 'AbortError');
        const state = await page.evaluate(async () => {
          const fixture = window.upgradeFixture;
          return (await fixture.transfers.readCipherTransfer(fixture.task.id)).state;
        });
        assert.equal(state, 'cancelled', 'A late controller must not resurrect the cancelled task');
        assert.equal(uploaded.length, 0, 'Cancellation during readiness must not dispatch ciphertext');
      } else {
        assert.equal(result.outcome, 'done', 'A task started under the old worker must continue after the new worker takes control');
        assert.equal(uploaded.length, 1, 'The original encrypted chunk is uploaded once');
        assert.deepEqual(uploaded[0], Buffer.alloc(17, 7));
        if (name === 'chromium') {
          let videoRequests = 0, rejectedRequests = 0;
          await page.context().route('https://video.twimg.com/worker-fixture.mp4', route => {
            videoRequests++;
            return route.fulfill({ body: 'isolated-video-source', headers: { 'Access-Control-Allow-Origin': '*' } });
          });
          await page.context().route('https://untrusted.invalid/**', route => {
            rejectedRequests++;
            return route.fulfill({ body: 'unexpected', headers: { 'Access-Control-Allow-Origin': '*' } });
          });
          const worker = page.context().serviceWorkers()[0];
          const policyResult = await worker.evaluate(async () => {
            const source = await (await fetch('https://video.twimg.com/worker-fixture.mp4', { credentials: 'omit' })).text();
            let rejected = false;
            try { await fetch('https://untrusted.invalid/video.mp4', { credentials: 'omit' }); }
            catch { rejected = true; }
            return { source, rejected };
          });
          assert.deepEqual(policyResult, { source: 'isolated-video-source', rejected: true });
          assert.equal(videoRequests, 1, 'The real worker policy admits the existing video source');
          assert.equal(rejectedRequests, 0, 'The worker policy still blocks other external origins');
        }
      }
      await page.close();
    }
    for(const sourceCancelled of [false,true]) {
    previousSource=true;upgraded=false;
    const sourcePage=await browser.newPage({serviceWorkers:'allow'});
    await sourcePage.goto(`${origin}/__cipher_upgrade`);
    await sourcePage.evaluate(async()=>{
      await navigator.serviceWorker.register('/__cipher-worker.js',{scope:'/',updateViaCache:'none'});
      await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
      const transfers=await import('/src/lib/cipher-transfer.ts');
      const task=await transfers.createSourceCipherTransfer(crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID());
      const controller=navigator.serviceWorker.controller,post=controller.postMessage.bind(controller),messages=[];
      controller.postMessage=(data,...rest)=>{messages.push(data.type);post(data,...rest);};
      const signal=new AbortController(),keyBytes=crypto.getRandomValues(new Uint8Array(32));
      window.sourceUpgrade={messages,task,transfers,signal,keyBytes,result:transfers.runCipherTransfer(task,signal.signal,undefined,{url:'https://video.twimg.com/feature-probe.mp4',keyBytes,ivPrefix:new Uint8Array(8)}).then(()=>({done:true}),error=>({name:error.name}))};
    });
    await sourcePage.waitForFunction(()=>window.sourceUpgrade.messages.includes('quiet-room-cipher-transfer-ready'));
    assert.equal(await sourcePage.evaluate(()=>window.sourceUpgrade.messages.includes('quiet-room-cipher-transfer')),false,'A v1 readiness reply alone cannot accept the new source grant');
    if(sourceCancelled)await sourcePage.evaluate(async()=>{
      const f=window.sourceUpgrade;f.signal.abort(new DOMException('Source cancelled during upgrade','AbortError'));await f.transfers.cancelCipherTransfer(f.task.id);
    });
    upgraded=true;
    const sourceResult=await sourcePage.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration()).update();return await window.sourceUpgrade.result;});
    assert.deepEqual(sourceResult,sourceCancelled?{name:'AbortError'}:{done:true});
    assert.equal(await sourcePage.evaluate(async()=> (await window.sourceUpgrade.transfers.readCipherTransfer(window.sourceUpgrade.task.id)).state),sourceCancelled?'cancelled':'done');
    assert.equal(await sourcePage.evaluate(()=>window.sourceUpgrade.keyBytes.byteLength===0||[...window.sourceUpgrade.keyBytes].every(value=>value===0)),true,'Aborted source buffers are erased; successful grants transfer ownership');
    await sourcePage.close();previousSource=false;
    console.log(name,'source grant capability',sourceCancelled?'cancelled':'upgraded');
    }
    for (const share of [false,true]) await popupDownload(browser,origin,name,share);
    await browser.close(); browser = undefined;
  }
} finally {
  await browser?.close();
  await server.close();
}
