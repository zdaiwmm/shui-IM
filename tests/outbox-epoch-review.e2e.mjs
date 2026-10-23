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
    const ca = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const cb = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const a = await ca.newPage(), b = await cb.newPage();
    try {
      const errors = [];
      for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
      await a.goto(origin); await a.locator('#create-room').click(); await a.locator('#copy-invite').click();
      await a.locator('.app-toast').filter({ hasText: '已复制' }).waitFor();
      const link = await a.evaluate(() => navigator.clipboard.readText());
      await b.goto(link);
      for (const page of [a, b]) await page.waitForFunction(() => reviewApp.connectionState === 'connected' && reviewApp.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input')?.disabled === false);
      await b.evaluate(() => reviewApp.enqueuePayload({ v: 1, kind: 'text', text: 'epoch-control', sentAt: new Date().toISOString() }));
      await b.waitForFunction(() => reviewApp.outbox.size === 0 && reviewApp.session.vault.lastSeq >= 1);
      await a.getByText('epoch-control', { exact: true }).waitFor();
      await b.waitForFunction(() => reviewApp.session && reviewApp.connectionState==='connected');
      const roomId = await b.evaluate(() => reviewApp.session.vault.roomId);
      const before = backend.store.roomState(roomId);
      // Model transport backpressure while retaining authenticated incoming
      // membership updates. No payload or cryptographic state is injected.
      await b.evaluate(() => {
        window.reviewOriginalSend = reviewApp.socket.sendEnvelope.bind(reviewApp.socket);
        reviewApp.socket.sendEnvelope = () => false;
      });
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
      await a.evaluate(async () => {
        const v = await import('/src/lib/vault.ts');
        await v.withVaultMutation(reviewApp.session, mutation => reviewApp.ensureMessageWindow(mutation, true));
      });
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
      const start = backend.store.roomState(roomId);
      await b.evaluate(() => { reviewApp.socket.sendEnvelope = window.reviewOriginalSend; void reviewApp.resumeOutbox(); });
      const deadline = Date.now() + 90_000;
      let final, accepted;
      while (Date.now() < deadline) {
        final = backend.store.roomState(roomId);
        accepted = queued.ids.filter(id => backend.store.getMessageByClientId(roomId, id)).length;
        if (accepted === oldCount + freshCount) break;
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
        fatal:globalThis.reviewFatal,body:document.querySelector('#fatal-message')?.textContent,notice: [...document.querySelectorAll('.app-toast')].map(element => element.textContent) }));
      if(accepted === oldCount + freshCount) await a.waitForFunction(count => [...reviewApp.messages.values()].filter(x=>x.payload.kind==='text' && /^(old|fresh)-/.test(x.payload.text)).length===count,oldCount+freshCount,{timeout:15000});
      const receiver = await a.evaluate(() => [...reviewApp.messages.values()].filter(x => x.payload.kind === 'text' && /^(old|fresh)-/.test(x.payload.text)).length);
      const { ids, ...queueSummary } = queued;
      const result = { oldCount, freshCount, before: { nextSeq: start.nextSeq, eventSeq: start.nextMlsEventSeq }, queued: queueSummary,
        after: { nextSeq: final.nextSeq, eventSeq: final.nextMlsEventSeq, accepted }, runtime, receiver, errors };
      console.log(JSON.stringify(result));
      assert.deepEqual(errors, []);
      return result;
    } finally { await ca.close(); await cb.close(); }
  }
  const control = await scenario(16, 17);
  assert.equal(control.after.accepted, 33); assert.equal(control.runtime.queued, 0); assert.equal(control.receiver, 33);
  const boundary = await scenario(64, 65);
  assert.equal(boundary.after.accepted, 129, 'All 129 accepted queued messages must drain after a peer epoch update');
  assert.equal(boundary.runtime.queued, 0);
  console.log('PASS cross-epoch queue control and >128 mixed ciphertext drain');
} finally { await browser?.close(); await vite?.close(); await backend?.close(); await rm(dataDir, { recursive: true, force: true }); }
