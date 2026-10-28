// Independent review: real app, two isolated identities, deterministic transport
// admission barrier. The compatibility producer uses real encryption/commit as pre-fix clients did.
// Only transport admission is held; crypto, IDB, HTTP, WS and MLS are real.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'qr-outbox-epoch-review-'));
let backend, vite, browser;
try {
  backend = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  vite = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error',
    plugins: [{ name: 'review-observer', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/src/main.ts')) return code.replace('void app.start();', 'window.reviewApp=app;void app.start();');
      if (id.endsWith('/src/app.ts')) return code.replace('private fatalSecurityError(cause: unknown): void {', 'private fatalSecurityError(cause: unknown): void { globalThis.reviewFatal=String(cause);');
    } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
      '/api': `http://127.0.0.1:${backend.port}`, '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true },
    } } });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  async function scenario(oldCount, freshCount) {
    const ca = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
    const cb = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
    const a = await ca.newPage(), b = await cb.newPage();
    try {
      const errors = [];
      for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
      await a.goto(origin); await a.locator('#create-room').click(); await a.locator('#copy-invite').click();
      await a.locator('.app-toast').filter({ hasText: '已复制' }).waitFor();
      const link = await a.evaluate(() => navigator.clipboard.readText());
      await b.goto(link);
      for (const page of [a, b]) await page.waitForFunction(() => reviewApp.connectionState === 'connected' && reviewApp.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input')?.disabled === false);
      await b.evaluate(() => {
        const seen=new WeakSet(),rooms=new WeakSet();
        globalThis.reviewTransport={syncCalls:0,syncFrames:0,capacityCloses:0,closeCodes:[],frames:{},syncPages:0,emptyPages:0,replayedMessages:0,closeSnapshots:[]};
        const start=performance.now();
        globalThis.reviewObserveRoom=room=>{
          if(rooms.has(room))return;rooms.add(room);
          const onSync=room.handlers.sync;
        room.handlers.sync=(messages,hasMore)=>{reviewTransport.syncPages++;if(!messages.length)reviewTransport.emptyPages++;reviewTransport.replayedMessages+=messages.filter(message=>message.seq<=reviewApp.session.vault.lastSeq).length;return onSync(messages,hasMore);};
        const observe=()=>{
          const ws=room.socket;if(!ws||seen.has(ws))return;seen.add(ws);
          ws.addEventListener('close',event=>{reviewTransport.closeCodes.push(event.code);reviewTransport.closeCodes=reviewTransport.closeCodes.slice(-8);reviewTransport.closeSnapshots.push({code:event.code,ms:Math.round(performance.now()-start),frames:{...reviewTransport.frames}});reviewTransport.closeSnapshots=reviewTransport.closeSnapshots.slice(-8);});
          const send=ws.send.bind(ws);ws.send=raw=>{if(typeof raw==='string'){const type=JSON.parse(raw).type;if(['auth','sync','receiptSync','send','receipt','presence','ping'].includes(type))reviewTransport.frames[type]=(reviewTransport.frames[type]??0)+1;if(type==='sync')reviewTransport.syncFrames++;}return send(raw);};
        };
        const connect=room.connect.bind(room);room.connect=()=>{connect();observe();};
        const sync=room.requestSync.bind(room);room.requestSync=after=>{reviewTransport.syncCalls++;return sync(after);};
        const capacity=room.reconnectForBackpressure.bind(room);room.reconnectForBackpressure=()=>{reviewTransport.capacityCloses++;capacity();};
        observe();
        };
        reviewObserveRoom(reviewApp.socket);
      });
      await b.evaluate(() => reviewApp.enqueuePayload({ v: 1, kind: 'text', text: 'epoch-control', sentAt: new Date().toISOString() }));
      await b.waitForFunction(() => reviewApp.outbox.size === 0 && reviewApp.session.vault.lastSeq >= 1);
      await a.getByText('epoch-control', { exact: true }).waitFor();
      await b.waitForFunction(() => reviewApp.session && reviewApp.connectionState==='connected');
      const roomId = await b.evaluate(() => reviewApp.session.vault.roomId);
      const before = backend.store.roomState(roomId);
      // Model transport backpressure while retaining authenticated incoming
      // membership updates. No payload or cryptographic state is injected.
      await b.evaluate(() => {
        window.reviewTransportPrototype=Object.getPrototypeOf(reviewApp.socket);
        window.reviewOriginalSend=window.reviewTransportPrototype.sendEnvelope;
        // Hold admission for every real replacement socket, retaining its own this.
        window.reviewTransportPrototype.sendEnvelope=()=>false;
      });
      if(oldCount===64){
        const replaced=await b.evaluate(async()=>{const previous=reviewApp.socket;await reviewApp.connectSocket();reviewObserveRoom(reviewApp.socket);return reviewApp.socket!==previous;});
        assert.equal(replaced,true,'Exercise a genuine socket replacement while admission is held');
        await b.waitForFunction(()=>reviewApp.socket?.connected&&reviewApp.session?.vault.mls?.phase==='active');
      }
      await b.evaluate(async count => {
        globalThis.enqueuePreviousClient = async text => {
          const v = await import('/src/lib/vault.ts'), m = await import('/src/lib/mls.ts');
          const session = reviewApp.session, clientMsgId = crypto.randomUUID();
          if(!session)throw Error('Lost compatibility producer session: '+document.body.textContent);
          const payload = {v:1,kind:'text',text,sentAt:new Date().toISOString()};
          await v.withVaultMutation(session, async lease => {
            const encrypted = await m.encryptMlsApplication(session.vault,payload,clientMsgId);
            const item = {clientMsgId,payload,createdAt:payload.sentAt,envelope:encrypted.envelope};
            await v.commitMlsSend(session,item,encrypted.nextGroupState,lease);
            reviewApp.outbox.set(clientMsgId,item);
            reviewApp.pending.set(clientMsgId,{clientMsgId,payload,senderId:item.envelope.senderId,seq:Number.MAX_SAFE_INTEGER,acceptedAt:payload.sentAt,status:'pending'});
          });
        };
        for (let i=0;i<count;i++) await enqueuePreviousClient(`old-${i}`);
      }, oldCount);
      // The other active device performs an ordinary authenticated MLS update.
      await a.evaluate(() => reviewApp.ensureMessageWindow(true));
      await b.waitForFunction(seq => reviewApp.session.vault.mls.lastEventSeq > seq && reviewApp.session.vault.mls.window.generated === 0, before.nextMlsEventSeq);
      await b.evaluate(async count => {
        for (let i = 0; i < count; i++) await enqueuePreviousClient(`fresh-${i}`);
      }, freshCount);
      const queued = await b.evaluate(async () => {
        const v = await import('/src/lib/vault.ts');
        const entries = await v.loadOutbox(reviewApp.session);
        return { ids: entries.map(x => x.clientMsgId), count: entries.length, encrypted: entries.filter(x => x.envelope).length, intentsOnly: entries.filter(x => !x.envelope).length,
          generation: reviewApp.session.vault.mls.window.generated, senderSequence: reviewApp.session.vault.mls.sendSequence };
      });
      assert.equal(queued.count, oldCount + freshCount); assert.equal(queued.encrypted, queued.count); assert.equal(queued.intentsOnly, 0);
      await b.waitForFunction(()=>reviewApp.socket?.connected&&reviewApp.session?.vault.mls?.phase==='active');
      const start = backend.store.roomState(roomId);
      const recoveryStartedAt = Date.now();
      await b.evaluate(() => { window.reviewTransportPrototype.sendEnvelope=window.reviewOriginalSend; void reviewApp.resumeOutbox(); });
      // Bound both total work and lack of accepted-message progress. Crypto and
      // IndexedDB speed varies on shared CI hosts; a stuck queue still fails fast.
      const deadline = Date.now() + 180_000;
      let progressAt = Date.now(), lastAccepted = 0;
      const preparedIds=new Set();
      let final, accepted;
      while (Date.now() < deadline) {
        final = backend.store.roomState(roomId);
        accepted = queued.ids.filter(id => backend.store.getMessageByClientId(roomId, id)).length;
        if (accepted === oldCount + freshCount) break;
        // Stale generated ciphertext must first become a durable intent. Those
        // authenticated preparations can advance before the first acceptance.
        const preparing=await b.evaluate(ids=>ids.filter(id=>{const item=reviewApp.outbox.get(id);return item?.intent&&!item.envelope;}),queued.ids);
        let advanced=accepted>lastAccepted;
        for(const id of preparing)if(!preparedIds.has(id)){preparedIds.add(id);advanced=true;}
        if(advanced)progressAt=Date.now();
        lastAccepted=Math.max(lastAccepted,accepted);
        if (Date.now() - progressAt >= 30_000) break;
        // Several signed self-updates with zero accepted application progress
        // prove the bounded-window scheduling cycle without a long stress run.
        if (final.nextMlsEventSeq >= start.nextMlsEventSeq + 3 && accepted === 0) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (accepted === oldCount + freshCount) {
        await b.waitForFunction(() => reviewApp.outbox.size === 0, undefined, { timeout: 15_000 });
        final = backend.store.roomState(roomId);
      }
      const runtime = await b.evaluate(() => ({ queued: reviewApp.outbox.size, connection: reviewApp.connectionState,
        localLastSeq: reviewApp.session?.vault.lastSeq, generated: reviewApp.session?.vault.mls?.window?.generated,
        senderSequence: reviewApp.session?.vault.mls?.sendSequence, accessFailure: reviewApp.accessFailure,
        fatal:globalThis.reviewFatal,body:document.querySelector('#fatal-message')?.textContent,notice: [...document.querySelectorAll('.app-toast')].map(element => element.textContent),
        transport:globalThis.reviewTransport,serverQueue:reviewApp.serverQueue.size,sending:reviewApp.sending.size,draining:!!reviewApp.outboxDrain,
        syncWaiting:{request:reviewApp.socket.syncRequestInFlight,pages:reviewApp.socket.syncResponsesPending},retryTimers:reviewApp.retryTimers.size }));
      if(accepted === oldCount + freshCount) await a.waitForFunction(count => [...reviewApp.messages.values()].filter(x=>x.payload.kind==='text' && /^(old|fresh)-/.test(x.payload.text)).length===count,oldCount+freshCount,{timeout:15000});
      const receiver = await a.evaluate(() => [...reviewApp.messages.values()].filter(x => x.payload.kind === 'text' && /^(old|fresh)-/.test(x.payload.text)).length);
      const { ids, ...queueSummary } = queued;
      const result = { oldCount, freshCount, preparedCount:preparedIds.size, recoveryMs:Date.now()-recoveryStartedAt, before: { nextSeq: start.nextSeq, eventSeq: start.nextMlsEventSeq }, queued: queueSummary,
        after: { nextSeq: final.nextSeq, eventSeq: final.nextMlsEventSeq, accepted }, runtime, receiver, errors };
      console.log(JSON.stringify(result));
      assert.deepEqual(errors, []);
      return result;
    } finally { await ca.close(); await cb.close(); }
  }
  const control = await scenario(16, 17);
  assert.equal(control.after.accepted, 33); assert.equal(control.runtime.queued, 0); assert.equal(control.receiver, 33);
  assert.ok(control.runtime.transport.frames.send >= control.queued.count, 'Transport observation must include every accepted logical send');
  assert.ok(control.runtime.transport.frames.send <= 2 * control.queued.count + 8, 'A rejected epoch must not amplify the queue into repeated stale sends');
  const boundary = await scenario(64, 65);
  assert.equal(boundary.after.accepted, 129, 'All 129 accepted queued messages must drain after a peer epoch update');
  assert.equal(boundary.runtime.queued, 0);
  assert.ok(boundary.runtime.transport.frames.send >= boundary.queued.count, 'Replacement socket sends must remain observable');
  assert.ok(boundary.runtime.transport.frames.send <= 2 * boundary.queued.count + 8, 'Epoch repair must not amplify this bounded queue into repeated stale sends');
  console.log('PASS cross-epoch queue control and >128 mixed ciphertext drain');
} finally { await browser?.close(); await vite?.close(); await backend?.close(); await rm(dataDir, { recursive: true, force: true }); }
