// Run from the repository root: node tests/offline-outbox.e2e.mjs
// Local temporary server, disposable browser identities; no production access.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dir = await mkdtemp(path.join(tmpdir(), 'qr-functional-offline-'));
let service, vite, browser;
const result = { regression: 'durable offline intent and sender ordering' };
try {
  service = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true });
  vite = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error',
    plugins: [{ name: 'audit-observer', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/src/main.ts')) return code.replace('void app.start();', 'window.auditApp=app;void app.start();');
      if (id.endsWith('/src/app.ts')) return code.replace('this.outbox = new Map(activeOutbox.map((item) => [item.clientMsgId, item]));',
        'this.outbox = new Map(activeOutbox.map((item) => [item.clientMsgId, item])); globalThis.auditHydration = activeOutbox.map(item => ({id:item.clientMsgId,sequence:item.envelope?.retention?.sendSequence}));');
    } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
      '/api': `http://127.0.0.1:${service.port}`, '/ws': { target: `ws://127.0.0.1:${service.port}`, ws: true },
    } } });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : process.env.CI ? {} : {channel:'chrome'});
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const contextA = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
  const contextB = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
  const a = await contextA.newPage(), b = await contextB.newPage();
  const errors = [];
  for (const page of [a, b]) page.on('pageerror', e => errors.push(e.message));
  await a.goto(origin); await a.locator('#create-room').click(); await a.locator('#copy-invite').click();
  await a.locator('.app-toast').filter({ hasText: '已复制' }).waitFor();
  const link = await a.evaluate(() => navigator.clipboard.readText());
  await b.goto(link); await b.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  await a.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  const ready = async page => page.waitForFunction(() => auditApp.connectionState === 'connected' && auditApp.session?.vault.mls?.phase === 'active');
  await ready(a); await ready(b);
  const local = async page => page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    return { outbox: (await v.loadOutbox(auditApp.session)).map(x => ({ id: x.clientMsgId, text: x.payload.text, sequence: x.envelope?.retention?.sendSequence })),
      pending: [...auditApp.pending.values()].filter(x => x.payload.kind === 'text').map(x => ({ id: x.clientMsgId, text: x.payload.text, status: x.status })),
      generated: auditApp.session.vault.mls.window?.generated ?? null,
      draft: document.querySelector('#message-input')?.value,
      toasts: [...document.querySelectorAll('.app-toast')].map(x => x.textContent),
      text: [...auditApp.messages.values()].filter(x => x.payload.kind === 'text').map(x => x.payload.text) };
  });
  // Natural first-message boundary: active MLS group with no message window yet.
  assert.equal((await local(b)).generated, null);
  // Complete the real close handshake before HTTP offline emulation: toggling
  // offline first can strand a graceful close until the browser's 30s timeout.
  // Retain RoomSocket's own reconnect path and observe state without RAF.
  const disconnectB = async () => {
    await b.evaluate(() => auditApp.socket.socket?.close());
    await b.waitForFunction(() => auditApp.connectionState !== 'connected', undefined, {polling:100});
    await contextB.setOffline(true);
  };
  await disconnectB();
  await b.locator('#message-input').fill('AUDIT first offline message');
  await b.locator('#composer').evaluate(form => form.requestSubmit());
  await b.waitForFunction(() => !auditApp.sendingTextDrafts.size);
  result.firstOffline = await local(b);
  assert.equal(result.firstOffline.outbox.length, 1);
  assert.equal(result.firstOffline.draft, '');
  await contextB.setOffline(false); await ready(b);
  await b.waitForFunction(() => auditApp.outbox.size === 0, undefined, {polling:100});
  result.firstOfflineAfterReconnect = await local(b);
  assert.equal(result.firstOfflineAfterReconnect.outbox.length, 0);
  assert.equal(result.firstOfflineAfterReconnect.text.includes('AUDIT first offline message'), true);
  // The accepted intent resumes without a second user submission.
  await a.getByText('AUDIT first offline message', { exact: true }).waitFor();
  await b.waitForFunction(() => auditApp.outbox.size === 0);
  result.onlineControl = (await local(b)).text.includes('AUDIT first offline message');

  // The production enqueue method accepts an existing logical ID for retries.
  // Pick valid descending UUIDs to make the otherwise ~50% ordering deterministic.
  // No MLS, IndexedDB, socket or server behavior is replaced.
  const ids = ['ffffffff-ffff-4fff-bfff-fffffffffff1', '11111111-1111-4111-8111-111111111112'];
  await disconnectB();
  await b.evaluate(async ids => {
    for (let i = 0; i < ids.length; i++) await auditApp.enqueuePayload({ v: 1, kind: 'text', text: `AUDIT queued ${i + 1}`, sentAt: new Date().toISOString() }, ids[i]);
  }, ids);
  result.beforeReload = await local(b);
  assert.equal(result.beforeReload.outbox.length, 2);
  // Discard the offline document before restoring HTTP, preventing its old
  // socket from racing a reload. The observer records hydration order without
  // changing native WebSocket construction, handlers, timing or protocol.
  await b.goto('about:blank');
  await contextB.setOffline(false); await b.goto(origin);
  await ready(b);
  result.afterHydration = await b.evaluate(() => auditHydration);
  assert.deepEqual(result.afterHydration.map(x => x.id), ids);
  await b.waitForFunction(() => auditApp.outbox.size === 0);
  await a.getByText('AUDIT queued 1', { exact: true }).waitFor();
  await a.getByText('AUDIT queued 2', { exact: true }).waitFor();
  const roomId = await b.evaluate(() => auditApp.session.vault.roomId);
  assert.deepEqual(service.store.messagesAfter(roomId, 0).filter(x => ids.includes(x.envelope.clientMsgId)).map(x => x.envelope.clientMsgId), ids);
  // Cross a real 128-generation boundary while disconnected, without injecting MLS state.
  await disconnectB();
  await b.evaluate(async () => {
    for (let i=0;i<130;i++) await auditApp.enqueuePayload({v:1,kind:'text',text:`WINDOW offline ${i}`,sentAt:new Date().toISOString()});
    const v=await import('/src/lib/vault.ts');const queued=await v.loadOutbox(auditApp.session);
    if(queued.length!==130 || !queued.some(item=>!item.envelope && item.intent))throw new Error('Boundary intents were not durably saved');
  });
  await b.goto('about:blank'); await contextB.setOffline(false); await b.goto(origin); await ready(b);
  try {
    // This is a correctness gate, not a runner-speed benchmark. Allow a slow
    // CI host to finish cryptographic writes, but fail a stalled queue sooner.
    const deadline = Date.now() + 180_000;
    let remaining = 130, progressedAt = Date.now();
    while (true) {
      const queued = await b.evaluate(() => auditApp.outbox.size);
      if (queued === 0) break;
      if (queued < remaining) { remaining = queued; progressedAt = Date.now(); }
      assert.ok(Date.now() - progressedAt < 30_000, 'Offline queue made no durable progress for 30 seconds');
      assert.ok(Date.now() < deadline, 'Offline queue exceeded its bounded 180 second recovery budget');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    // Synthetic fixture metadata only: no credentials, payloads or ciphertext.
    console.error('OFFLINE_WINDOW_TIMEOUT', JSON.stringify(await b.evaluate(() => ({
      queued: auditApp.outbox.size, sending: auditApp.sending.size, draining: !!auditApp.outboxDrain,
      retries: auditApp.retryTimers.size, connection: auditApp.connectionState,
      covered: auditApp.privacyCovered, errors: [...auditApp.pending.values()].filter(x => x.status === 'failed').length,
      lastSeq: auditApp.session?.vault.lastSeq, window: auditApp.session?.vault.mls?.window,
      lastEventSeq: auditApp.session?.vault.mls?.lastEventSeq,
      intentCount: [...auditApp.outbox.values()].filter(x => !x.envelope).length,
    }))));
    throw error;
  }
  await a.getByText('WINDOW offline 129',{exact:true}).waitFor({timeout:30000});
  const received=await a.evaluate(()=>[...auditApp.messages.values()].filter(m=>m.payload.kind==='text'&&m.payload.text.startsWith('WINDOW offline')).map(m=>m.payload.text));
  assert.equal(received.length,130); assert.deepEqual(received,Array.from({length:130},(_,i)=>`WINDOW offline ${i}`));
  result.windowBoundaryReceived=received.length;
  // Drop only the transport submission after real MLS ciphertext has committed.
  // Cancellation must preserve that advanced ratchet, and the next generation
  // must still decrypt after a real browser reload and reconnect.
  await b.waitForFunction(()=>!auditApp.outboxDrain&&!auditApp.sending.size);
  await b.evaluate(()=>{window.heldSend=auditApp.socket.sendEnvelope;auditApp.socket.sendEnvelope=()=>false;});
  await b.locator('#message-input').fill('CANCEL generated but unsubmitted');
  await b.locator('#composer').evaluate(form=>form.requestSubmit());
  await b.waitForFunction(()=>[...auditApp.outbox.values()].some(item=>item.payload.text==='CANCEL generated but unsubmitted'&&item.envelope));
  const cancelled=await b.evaluate(async()=>{
    const v=await import('/src/lib/vault.ts'),item=[...auditApp.pending.values()].find(item=>item.payload.text==='CANCEL generated but unsubmitted');
    const sequence=auditApp.outbox.get(item.clientMsgId).envelope.retention.sendSequence;
    await auditApp.cancelPendingMessage(item);
    auditApp.socket.sendEnvelope=window.heldSend;
    return {id:item.clientMsgId,durable:(await v.loadOutbox(auditApp.session)).some(x=>x.clientMsgId===item.clientMsgId),sequence,ratchetPreserved:auditApp.session.vault.mls.sendSequence>=sequence};
  });
  assert.equal(cancelled.durable,false);assert.equal(cancelled.ratchetPreserved,true);
  await disconnectB();await b.goto('about:blank');await contextB.setOffline(false);await b.goto(origin);await ready(b);
  assert.equal((await local(b)).outbox.some(x=>x.id===cancelled.id),false);
  await b.locator('#message-input').fill('AFTER cancellation still decrypts');
  await b.locator('#composer').evaluate(form=>form.requestSubmit());
  await a.getByText('AFTER cancellation still decrypts',{exact:true}).waitFor();
  assert.equal(await a.getByText('CANCEL generated but unsubmitted',{exact:true}).count(),0);
  const serverMessages=service.store.messagesAfter(roomId,0);
  assert.equal(serverMessages.some(x=>x.envelope.clientMsgId===cancelled.id),false);
  await b.waitForFunction(()=>[...auditApp.messages.values()].some(m=>m.payload.text==='AFTER cancellation still decrypts'));
  const nextId=await b.evaluate(()=>[...auditApp.messages.values()].find(m=>m.payload.text==='AFTER cancellation still decrypts').clientMsgId);
  assert.ok(serverMessages.find(x=>x.envelope.clientMsgId===nextId).envelope.retention.sendSequence>cancelled.sequence);
  result.cancelledGeneratedCiphertext={durableRemoved:true,ratchetPreserved:true,reloadNoRetry:true,nextMessageDecrypted:true,serverNeverAccepted:true};
  // A network blackhole inside the vault lease must be cancelled by locking.
  // Route only the real window-refresh GET; retain the actual fetch/abort path.
  let releaseHeld, reachedHeld;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const reached = new Promise(resolve => { reachedHeld = resolve; });
  await b.route(`**/api/rooms/${roomId}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    reachedHeld(); await held; await route.abort().catch(() => {});
  });
  await b.evaluate(() => {
    globalThis.auditWindowTask = auditApp.ensureMessageWindow(true).catch(() => {});
  });
  await Promise.race([reached, new Promise((_,reject)=>setTimeout(()=>reject(Error('Window refresh not reached')),5000))]);
  await b.locator('#message-input').fill('BLACKHOLE local message');
  await b.locator('#composer').evaluate(form=>form.requestSubmit());
  await b.waitForFunction(()=>document.querySelector('#message-input').value===''&&[...auditApp.pending.values()].some(m=>m.payload.text==='BLACKHOLE local message'),undefined,{timeout:3000});
  await b.getByText('BLACKHOLE local message',{exact:true}).waitFor();
  await b.locator('#message-input').fill('next draft remains editable');
  assert.equal(await b.locator('#message-input').inputValue(),'next draft remains editable');
  result.blackholeLocalCommitAndEditableDraft=true;
  await b.evaluate(async () => {
    auditApp.lockNow();
    await Promise.race([Promise.all([globalThis.auditWindowTask, import('/src/lib/vault.ts').then(v => v.readStoredVault())]),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('Vault lease remained blocked after lock')),3000))]);
    if(auditApp.outboxDrain!==null)throw Error('Old drain still owns the new lifecycle');
  });
  releaseHeld(); await b.unrouteAll({behavior:'wait'});
  result.lockCancelsWindowBlackhole=true;
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify(result, null, 2));
  console.log('BROWSER_PAGE_ERRORS', JSON.stringify(errors));
} finally { await browser?.close(); await vite?.close(); await service?.close(); await rm(dir, { recursive: true, force: true }); }
