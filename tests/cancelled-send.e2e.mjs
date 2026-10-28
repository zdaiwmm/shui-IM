// Real-server cancellation regression. Only transport timing is controlled; all identities are disposable.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'quiet-cancel-accepted-'));
const output = process.env.QR_CANCEL_RESULT ? path.resolve(process.env.QR_CANCEL_RESULT) : null;
const save = () => output ? writeFile(output, JSON.stringify(results, null, 2) + '\n') : Promise.resolve();
const results = { fixtureRevision: 'V2', startedAt: new Date().toISOString(),
  scope: 'synthetic local application, server, MLS and IndexedDB', cases: [] };
let service, vite, browser, stage = 'setup';

const ready = page => page.waitForFunction(() => window.auditApp?.connectionState === 'connected'
  && auditApp.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input')?.disabled === false,
undefined, { timeout: 20000, polling: 100 });
const submit = async (page, text) => {
  await page.locator('#message-input').fill(text);
  await page.locator('#composer').evaluate(form => form.requestSubmit());
};
const local = page => page.evaluate(async () => {
  const vault = await import('/src/lib/vault.ts');
  const stored = await vault.readStoredVault();
  // A fatal error disposes the live runtime. Independently reopen the automatic
  // local wrapper for readback only; never install this session into the app.
  const runtimePresent = Boolean(auditApp.session);
  const session = auditApp.session ?? (stored ? await vault.unlockVault(
    await (await import('/src/lib/browser-room-key.ts')).browserRoomKey(), undefined, stored) : null);
  return { fatal: document.querySelector('#fatal-message')?.textContent ?? null,
    runtimePresent, session: Boolean(session), lastSeq: session?.vault.lastSeq ?? null,
    history: session ? (await vault.loadHistory(session)).map(message => ({ id: message.clientMsgId, text: message.payload.text })) : [],
    outbox: session ? (await vault.loadOutbox(session)).map(item => item.clientMsgId) : [],
    hidden: session ? (await vault.loadUiPreferences(session)).hiddenChatMessageIds ?? [] : [],
    stored: Boolean(stored) };
});
const cancelThroughUI = async (page, id) => {
  const row = page.locator(`.message[data-client-msg-id="${id}"]`);
  await row.dispatchEvent('contextmenu');
  await page.locator('[data-message-action="delete"]').click();
  await page.getByRole('menuitem', { name: '删除并取消发送', exact: true }).click();
  await page.waitForFunction(id => !auditApp.outbox.has(id) && !auditApp.cancellingOutbox.has(id), id, { polling: 100 });
};

try {
  service = await startServer({ port: 0, host: '127.0.0.1', dataDir: directory, quiet: true });
  vite = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error', cacheDir: path.join(directory, 'vite'),
    plugins: [{ name: 'cancel-validation-observer', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/src/main.ts')) return code.replace('void app.start();', 'window.auditApp=app;void app.start();');
    } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
      '/api': `http://127.0.0.1:${service.port}`, '/ws': { target: `ws://127.0.0.1:${service.port}`, ws: true },
    } } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    browser = await engine.launch(engineName === 'chromium' && !process.env.CI ? { channel: 'chrome' } : {});
    for (const mode of ['delayed-no-cancel', 'cancel-before-submit', 'cancel-accepted-release', 'cancel-accepted-reload', 'cancel-accepted-reconnect', 'cancel-accepted-conflict']) {
      stage = `${engineName}/${mode}: pair`;
      const contexts = await Promise.all([browser.newContext({locale: 'zh-CN'}), browser.newContext({locale: 'zh-CN'})]);
      try {
        for (const context of contexts) await context.addInitScript(() => {
          localStorage.setItem('quiet-room:auto-lock-seconds', '0');
          localStorage.setItem('quiet-room:lock-on-hidden', '0');
        });
        const [peer, sender] = await Promise.all(contexts.map(context => context.newPage()));
        const errors = [];
        for (const page of [peer, sender]) { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); }
        const gate = { armed: false, id: null, held: [], submitted: 0, cancelled: false, afterCancelSubmissions: 0 };
        const incoming = raw => {
          if (mode !== 'cancel-accepted-conflict') return raw;
          const frame = JSON.parse(String(raw));
          const targets = frame.type === 'message' ? [frame] : frame.type === 'sync' ? frame.messages ?? [] : [];
          for (const message of targets) if (message.envelope.clientMsgId === gate.id) message.envelope.signature += 'A';
          return JSON.stringify(frame);
        };
        await sender.routeWebSocket('**/ws', route => {
          const server = route.connectToServer();
          route.onMessage(raw => {
            const frame = JSON.parse(String(raw));
            if (gate.armed && frame.type === 'send' && !gate.id) gate.id = frame.envelope.clientMsgId;
            if (frame.type === 'send' && frame.envelope.clientMsgId === gate.id) {
              gate.submitted++;
              if (gate.cancelled) gate.afterCancelSubmissions++;
            }
            server.send(raw);
          });
          server.onMessage(raw => {
            const frame = JSON.parse(String(raw));
            const target = gate.id && (frame.type === 'ack' && frame.clientMsgId === gate.id
              || frame.type === 'message' && frame.envelope.clientMsgId === gate.id
              || frame.type === 'sync' && frame.messages?.some(message => message.envelope.clientMsgId === gate.id));
            if (gate.armed && target) gate.held.push({ route, raw, type: frame.type });
            else route.send(incoming(raw));
          });
        });
        await peer.goto(origin); await peer.locator('#create-room').click(); await peer.locator('#copy-invite').waitFor();
        const invite = await peer.evaluate(() => auditApp.participantInviteUrl(auditApp.session));
        await sender.goto(invite); await ready(peer); await ready(sender);
        // A real message establishes the authenticated window before the narrow race.
        await submit(sender, 'SYNTHETIC warmup'); await peer.getByText('SYNTHETIC warmup', { exact: true }).waitFor();
        await sender.waitForFunction(() => auditApp.outbox.size === 0 && !auditApp.outboxDrain, undefined, { polling: 100 });
        const roomId = await sender.evaluate(() => auditApp.session.vault.roomId);
        const before = await local(sender);
        stage = `${engineName}/${mode}: submit`;
        if (mode === 'cancel-before-submit') await sender.evaluate(() => {
          window.originalSend = auditApp.socket.sendEnvelope;
          auditApp.socket.sendEnvelope = () => false;
        });
        else gate.armed = true;
        await submit(sender, 'SYNTHETIC target');
        await sender.waitForFunction(() => [...auditApp.outbox.values()].some(item => item.payload.text === 'SYNTHETIC target' && item.envelope), undefined, { polling: 100 });
        const id = await sender.evaluate(() => [...auditApp.outbox.values()].find(item => item.payload.text === 'SYNTHETIC target').clientMsgId);
        const beforeCancel = await local(sender);
        assert.ok(beforeCancel.outbox.includes(id)); assert.equal(beforeCancel.fatal, null);
        const accepted = mode !== 'cancel-before-submit';
        if (accepted) {
          await peer.getByText('SYNTHETIC target', { exact: true }).waitFor();
          assert.equal(service.store.messagesAfter(roomId, 0).filter(message => message.envelope.clientMsgId === id).length, 1);
          assert.ok(gate.held.some(item => item.type === 'ack'));
          assert.ok(gate.held.some(item => item.type === 'message' || item.type === 'sync'));
          const targetSeq = service.store.getMessageByClientId(roomId, id).seq;
          assert.equal(beforeCancel.history.some(message => message.id === id), false, 'The held target must not be durable');
          assert.ok(beforeCancel.lastSeq < targetSeq, 'The receive cursor must not cross the held target');
        }
        stage = `${engineName}/${mode}: cancel/release`;
        let rollback = null;
        if (mode === 'cancel-before-submit') {
          rollback = await sender.evaluate(async id => {
            const v = await import('/src/lib/vault.ts'), session = auditApp.session;
            const original = IDBDatabase.prototype.transaction;
            let injected = false, rejected = false;
            IDBDatabase.prototype.transaction = function(stores, ...args) {
              const tx = original.call(this, stores, ...args);
              if (args[0] === 'readwrite' && Array.isArray(stores) && stores.includes('outbox') && stores.includes('preferences')) {
                injected = true; IDBDatabase.prototype.transaction = original; queueMicrotask(() => tx.abort());
              }
              return tx;
            };
            try { await v.cancelOutboxItem(session, id); } catch { rejected = true; }
            finally { IDBDatabase.prototype.transaction = original; }
            const kept = (await v.loadOutbox(session)).find(item => item.clientMsgId === id);
            window.cancelStaleSession = { ...session, stored: structuredClone(session.stored), vault: structuredClone(session.vault) };
            window.cancelStaleItem = kept;
            return { injected, rejected, outboxKept: Boolean(kept),
              noJournal: !await v.loadCancelledSend(session, id), noHidden: !(await v.loadUiPreferences(session)).hiddenChatMessageIds?.includes(id) };
          }, id);
          assert.deepEqual(rollback, { injected: true, rejected: true, outboxKept: true, noJournal: true, noHidden: true });
        }
        if (mode !== 'delayed-no-cancel') {
          await cancelThroughUI(sender, id); gate.cancelled = true;
          const cancelled = await local(sender);
          assert.equal(cancelled.outbox.includes(id), false);
          assert.ok(cancelled.hidden.includes(id));
          assert.equal(cancelled.history.some(message => message.id === id), false);
          assert.equal(await sender.evaluate(async id => Boolean(await (await import('/src/lib/vault.ts')).loadCancelledSend(auditApp.session, id)), id), true);
          if (mode === 'cancel-before-submit') {
            const staleRejected = await sender.evaluate(async () => {
              try { await (await import('/src/lib/vault.ts')).saveOutboxItem(window.cancelStaleSession, window.cancelStaleItem); return false; }
              catch { return true; }
            });
            assert.equal(staleRejected, true, 'An old writer must not recreate cancelled sending work');
          }
          if (mode === 'cancel-accepted-release') {
            const targetSeq = service.store.getMessageByClientId(roomId, id).seq;
            rollback = await sender.evaluate(async ({ id, seq }) => {
              const v = await import('/src/lib/vault.ts'), session = auditApp.session;
              const item = await v.loadCancelledSend(session, id), before = session.vault.lastSeq;
              const original = IDBDatabase.prototype.transaction;
              let injected = false, rejected = false;
              IDBDatabase.prototype.transaction = function(stores, ...args) {
                const tx = original.call(this, stores, ...args);
                if (args[0] === 'readwrite' && Array.isArray(stores) && stores.includes('history') && stores.includes('preferences')) {
                  injected = true; IDBDatabase.prototype.transaction = original; queueMicrotask(() => tx.abort());
                }
                return tx;
              };
              try {
                await v.withVaultMutation(session, async mutation => {
                  session.vault.lastSeq = seq;
                  try { await v.commitMlsReceive(session, { seq, clientMsgId: id, senderId: item.envelope.senderId,
                    payload: item.payload, acceptedAt: item.createdAt, status: 'stored' }, session.vault.mls.groupState, undefined, mutation); }
                  catch (cause) { session.vault.lastSeq = before; throw cause; }
                });
              } catch { rejected = true; }
              finally { IDBDatabase.prototype.transaction = original; }
              const reopened = await v.unlockVault(await (await import('/src/lib/browser-room-key.ts')).browserRoomKey());
              return { injected, rejected, historyAbsent: !(await v.loadHistoryMessage(reopened, seq)),
                journalKept: Boolean(await v.loadCancelledSend(reopened, id)), cursorKept: reopened.vault.lastSeq === before };
            }, { id, seq: targetSeq });
            assert.deepEqual(rollback, { injected: true, rejected: true, historyAbsent: true, journalKept: true, cursorKept: true });
            await sender.evaluate(() => {
              const original = IDBDatabase.prototype.transaction;
              window.emptyOutboxWrites = 0;
              window.restoreOutboxTransactions = () => { IDBDatabase.prototype.transaction = original; };
              IDBDatabase.prototype.transaction = function(stores, ...args) {
                const tx = original.call(this, stores, ...args);
                if (args[0] === 'readwrite' && Array.isArray(stores) && stores.includes('outbox') && !stores.includes('history') && !stores.includes('preferences')) {
                  window.emptyOutboxWrites++; queueMicrotask(() => tx.abort());
                }
                return tx;
              };
            });
          }
        }
        const heldTypes = gate.held.map(item => item.type);
        gate.armed = false;
        if (mode === 'cancel-accepted-reload' || mode === 'cancel-before-submit') {
          gate.held = [];
          await sender.reload();
        } else if (mode === 'cancel-accepted-reconnect') {
          gate.held = [];
          await sender.evaluate(() => auditApp.socket.socket.close());
        } else {
          for (const item of gate.held.splice(0)) item.route.send(incoming(item.raw));
        }
        await sender.waitForFunction(() => document.querySelector('#fatal-message')
          || auditApp.session && !auditApp.outbox.size && [...auditApp.messages.values()].some(message => message.payload.text === 'SYNTHETIC target')
          || document.querySelector('#message-input')?.disabled === false && window.auditApp?.connectionState === 'connected' && window.auditApp?.session && !auditApp.outbox.size,
        undefined, { polling: 100 });
        // For accepted scenarios, wait for the actual durable receive or failure, not only socket readiness.
        if (accepted) await sender.waitForFunction(id => document.querySelector('#fatal-message')
          || [...auditApp.messages.values()].some(message => message.clientMsgId === id), id, { polling: 100 });
        if (mode === 'cancel-accepted-release') {
          const emptyWrites = await sender.evaluate(() => { window.restoreOutboxTransactions(); return window.emptyOutboxWrites; });
          assert.equal(emptyWrites, 0, 'A cancelled echo must not depend on a redundant outbox write after durable receive');
        }
        let snapshot = await local(sender);
        const conflict = mode === 'cancel-accepted-conflict';
        let bidirectional = false, blockedAfterPeerSend = false;
        stage = `${engineName}/${mode}: subsequent delivery`;
        if (!snapshot.fatal && !conflict) {
          await ready(sender);
          await submit(sender, 'SYNTHETIC after sender'); await peer.getByText('SYNTHETIC after sender', { exact: true }).waitFor();
          await submit(peer, 'SYNTHETIC after peer'); await sender.getByText('SYNTHETIC after peer', { exact: true }).waitFor();
          bidirectional = true; snapshot = await local(sender);
        } else {
          // Peer can still persist/send; the failed endpoint remains unable to consume it.
          await submit(peer, 'SYNTHETIC after peer');
          await peer.waitForFunction(() => auditApp.outbox.size === 0, undefined, { polling: 100 });
          blockedAfterPeerSend = await sender.getByText('SYNTHETIC after peer', { exact: true }).count() === 0;
        }
        const row = { engine: engineName, mode, acceptedBeforeCancel: accepted, peerDecryptedTarget: accepted,
          heldTypes, serverTargetCopies: service.store.messagesAfter(roomId, 0).filter(message => message.envelope.clientMsgId === id).length,
          durableTargetOutboxRemoved: !snapshot.outbox.includes(id), localHidden: snapshot.hidden.includes(id),
          targetDurable: snapshot.history.some(message => message.id === id), priorCursor: before.lastSeq, finalCursor: snapshot.lastSeq,
          runtimePresent: snapshot.runtimePresent, fatal: snapshot.fatal, bidirectional, blockedAfterPeerSend, afterCancelSubmissions: gate.afterCancelSubmissions,
          pageErrors: [...errors], rollback };
        const journal = await sender.evaluate(async id => {
          const v = await import('/src/lib/vault.ts');
          const session = auditApp.session ?? await v.unlockVault(await (await import('/src/lib/browser-room-key.ts')).browserRoomKey());
          return Boolean(await v.loadCancelledSend(session, id));
        }, id);
        row.journalRetained = journal;
        if (mode === 'cancel-before-submit') {
          assert.equal(row.serverTargetCopies, 0); assert.equal(await peer.getByText('SYNTHETIC target', { exact: true }).count(), 0);
          assert.equal(row.localHidden, true); assert.equal(row.targetDurable, false);
        } else assert.equal(row.serverTargetCopies, 1);
        if (!conflict) {
          assert.equal(row.fatal, null); assert.equal(row.bidirectional, true);
          assert.equal(journal, mode === 'cancel-before-submit', 'Only an unresolved cancelled send keeps receive-only material');
          if (mode !== 'delayed-no-cancel') {
            assert.equal(row.localHidden, true);
            assert.equal(await sender.locator(`.message[data-client-msg-id="${id}"]`).count(), 0, 'Accepted cancellation must stay hidden');
          }
        } else {
          assert.equal(row.fatal, '本机 MLS 待发记录与服务器消息不一致');
          assert.equal(row.targetDurable, false); assert.equal(journal, true);
        }
        assert.equal(row.afterCancelSubmissions, 0); assert.deepEqual(errors, []);
        results.cases.push(row);
        await save();
        console.log(JSON.stringify(row));
      } finally { for (const context of contexts) await context.close(); }
    }
    await browser.close(); browser = null;
  }
  results.completedAt = new Date().toISOString();
  results.expectedConflictRejections = results.cases.filter(row => row.mode === 'cancel-accepted-conflict' && row.fatal).length;
  assert.equal(results.cases.length, 12); assert.equal(results.expectedConflictRejections, 2);
  console.log(`PASS cancelled sends: 10 continued bidirectional scenarios, 2 authenticated conflict rejections, atomic rollback and stale-writer fences.`);
} catch (error) {
  results.harnessFailure = { stage, name: error.name, message: error.message };
  throw error;
} finally {
  await save();
  await browser?.close(); await vite?.close(); await service?.close();
  await rm(directory, { recursive: true, force: true });
}
