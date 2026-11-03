import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

// Real independent keys, MLS, HTTP/WS and encrypted IDB. Presentation is
// enabled on the returning endpoint so entry, typing and the backlog share the real timeline.
for (const engine of [chromium, webkit]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'qr-old-device-'));
  let backend, vite, browser;
  try {
    backend = await startServer({ dataDir, port: 0, host: '127.0.0.1', quiet: true });
    vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
        '/api': { target: `http://127.0.0.1:${backend.port}`, changeOrigin: true },
        '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true },
      } } });
    vite.middlewares.use('/__catchup', (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div id="app"></div>');
    });
    await vite.listen();
    browser = await engine.launch(engine === chromium && !process.env.CI ? { channel: 'chrome' } : {});
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext({ locale: 'zh-CN' });
      const page = await context.newPage(); pages.push(page);
      await page.goto(`http://localhost:${vite.httpServer.address().port}/__catchup`);
      await page.evaluate(async () => {
        window.c = await import('/src/lib/crypto.ts'); window.api = await import('/src/lib/api.ts');
        window.m = await import('/src/lib/mls.ts'); window.v = await import('/src/lib/vault.ts');
        window.identity = await c.generateIdentity();
        window.install = async vault => {
          const { QuietRoomApp } = await import('/src/app.ts');
          window.app = new QuietRoomApp(document.querySelector('#app'));
          app.session = await v.createVault(vault, 'synthetic-catchup-password', 'password');
          app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
          window.failures = [];
          app.operationalError = error => failures.push(String(error));
          app.fatalSecurityError = error => { failures.push(String(error)); app.privacyCovered = true; app.socket?.close(); };
          for (const name of ['renderMessages', 'updateConnectionStatus', 'updatePeerStatus', 'updateCallControls',
            'paintInviteProgress', 'showNotice', 'closeViewerIfProjectionDeleted']) app[name] = () => {};
          app.ensureCallController = () => {}; app.presenceCircuit = null;
        };
      });
    }
    const [old, peer, added] = pages;
    const room = await old.evaluate(async () => {
      const room = await api.createRoom(identity.publicBundle, 'a'.repeat(43), 'i'.repeat(43), 'old', ['message-window-v1']);
      return { ...room, fingerprint: await c.bundleFingerprint(identity.publicBundle) };
    });
    await peer.evaluate(async room => api.joinRoom(room.roomId, 'i'.repeat(43), identity.publicBundle,
      await c.createJoinProof('p'.repeat(43), identity.publicBundle), 'b'.repeat(43), 'peer', ['message-window-v1']), room);
    for (const [i, page] of [old, peer].entries()) await page.evaluate(async ({ room, i }) => {
      const token = (i ? 'b' : 'a').repeat(43), state = await api.getRoomState(room.roomId, token);
      const vault = { v: 3, roomId: room.roomId, accessToken: token, role: i ? 'joiner' : 'creator',
        pairingSecret: 'p'.repeat(43), creatorFingerprint: room.fingerprint, identity, members: state.members,
        lastSeq: 0, lastReceiptSeq: 0, protocol: 'mls-rfc9420', createdAt: room.createdAt, pairingState: 'ready' };
      if (!i) {
        vault.mls = await m.createCreatorMlsState(room.roomId, identity, state.members);
        vault.mls = await m.prepareCreatorWelcome(vault);
        await api.publishMlsWelcome(room.roomId, token, vault.mls.pendingWelcome); vault.mls.pendingWelcome = undefined;
      } else vault.mls = await m.joinMlsGroup(vault, state.mlsWelcome);
      await install(vault); await app.connectSocket();
    }, { room, i });
    const healthy = async page => assert.deepEqual(await page.evaluate(() => failures), []);
    const caughtUp = async (page, seq) => {
      await page.waitForFunction(seq => app.session.vault.lastSeq >= seq || failures.length, seq, { timeout: 60_000 });
      await healthy(page);
    };
    const send = async (page, text) => {
      await page.evaluate(text => app.enqueuePayload({ v: 1, kind: 'text', text, sentAt: new Date().toISOString() }), text);
      const row = await page.waitForFunction(text => [...app.messages.values()].find(row =>
        row.senderId === identity.publicBundle.deviceId && row.payload.text === text), text);
      const { seq } = await row.jsonValue(); await row.dispose();
      await caughtUp(page, seq); return seq;
    };
    await send(old, 'before admission'); await caughtUp(peer, 1);
    const link = await old.evaluate(async () => {
      const linkId = crypto.randomUUID(), secret = 's'.repeat(43);
      await api.createDeviceLink(app.session.vault.roomId, app.session.vault.accessToken,
        identity.publicBundle.deviceId, linkId, secret, new Date(Date.now() + 600000).toISOString());
      return { linkId, secret };
    });
    const targetId = await added.evaluate(async link => {
      await api.claimDeviceLink(link.linkId, link.secret, identity.publicBundle, 'c'.repeat(43), 'added', ['message-window-v1']);
      return identity.publicBundle.deviceId;
    }, link);
    const admission = await old.evaluate(async targetId => {
      const session = app.session;
      const state = await api.getRoomState(session.vault.roomId, session.vault.accessToken);
      return v.withVaultMutation(session, async mutation => {
        await app.applyRoomState(state, mutation);
        session.vault.mls.pendingMembership = await m.prepareMlsMembership(session.vault, 'add', state.members.find(m => m.deviceId === targetId));
        await v.saveVault(session, mutation);
        const result = await api.publishMlsMembership(session.vault.roomId, session.vault.accessToken, session.vault.mls.pendingMembership.event);
        await app.applyRoomState(result.state, mutation);
        return result.state;
      });
    }, targetId);
    await added.evaluate(async ({ room, admission }) => {
      const own = admission.members.find(member => member.deviceId === identity.publicBundle.deviceId);
      const event = admission.mlsEvents.find(item => item.event.targetId === own.deviceId);
      const vault = { v: 3, roomId: room.roomId, accessToken: 'c'.repeat(43), role: 'creator', pairingSecret: '',
        creatorFingerprint: room.fingerprint, identity, members: admission.members, lastSeq: own.joinSeq,
        lastReceiptSeq: own.joinReceiptSeq, historyUnavailableBeforeSeq: own.joinSeq, protocol: 'mls-rfc9420',
        createdAt: room.createdAt, pairingState: 'ready', mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: event.eventSeq - 1 } };
      vault.mls = await m.joinMlsMembership(vault, event.event, event.eventSeq);
      await install(vault); await app.connectSocket();
    }, { room, admission });
    await old.evaluate(() => app.socket.close());
    // At 4,000 CJK characters a signed epoch spans multiple real 1 MiB pages.
    // A control beyond page one must not be mistaken for a retention gap.
    for (let index = 0; index < 140; index++) {
      await send(added, `${index}:` + '测'.repeat(3995));
      if (index % 20 === 19) { await caughtUp(peer, backend.store.roomState(room.roomId).nextSeq); await send(peer, `reply ${index}`); }
      if (index === 100) {
        await added.evaluate(async () => {
          const first = app.messages.get(2);
          await app.enqueuePayload({ v: 1, kind: 'message-delete', sentAt: new Date().toISOString(),
            target: { clientMsgId: first.clientMsgId, serverSeq: first.seq, senderId: first.senderId } });
        });
        await caughtUp(added, backend.store.roomState(room.roomId).nextSeq);
      }
    }
    const tail = backend.store.roomState(room.roomId).nextSeq;
    await old.evaluate(async tail => {
      await import('/src/styles.css'); await import('/src/chat-layout.css');
      delete app.renderMessages;
      window.entryStart = performance.now();
      await app.openSession();
      const first = document.querySelector('#message-list .message');
      if (!first) throw Error('First local message unavailable at chat entry');
      window.firstRowMs = performance.now() - entryStart;
      await new Promise((resolve, reject) => {
        const sample = () => {
          const seq = app.session.vault.lastSeq;
          if (seq >= tail || performance.now() - entryStart > 30000) return reject(Error('Did not observe partial catch-up'));
          if (seq > 1) resolve(); else requestAnimationFrame(sample);
        };
        sample();
      });
      const input = document.querySelector('#message-input');
      input.value = 'synthetic local draft';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, tail);
    await caughtUp(old, tail);
    await old.waitForFunction(seq => {
      const id = app.messages.get(seq)?.clientMsgId;
      return id && document.querySelector(`.message[data-client-msg-id="${id}"]`);
    }, tail);
    const entry = await old.evaluate(() => ({ firstRowMs, finalRowMs: performance.now() - entryStart, draft: document.querySelector('#message-input').value }));
    assert.equal(entry.draft, 'synthetic local draft');
    console.log(`ENTRY ${engine.name()}: first local row ${Math.round(entry.firstRowMs)} ms, backlog visible ${Math.round(entry.finalRowMs)} ms`);
    const result = await old.evaluate(async tail => {
      const rows = []; let cursor = 0;
      while (true) {
        const page = await v.loadHistoryPageAfter(app.session, { afterSeq: cursor, limit: 200 });
        if (!page.length) break; rows.push(...page); cursor = page.at(-1).seq;
      }
      return { seqs: rows.map(row => row.seq), trailing: rows.filter(row => row.seq > tail).map(row => row.payload.kind), gaps: app.session.vault.expiredMessageRanges ?? [],
        deletes: rows.filter(row => row.payload.kind === 'message-delete').length };
    }, tail);
    assert.ok(result.seqs.length >= tail && result.trailing.every(kind => kind === 'message-read'));
    assert.deepEqual(result.seqs, Array.from({ length: result.seqs.length }, (_, i) => i + 1));
    assert.deepEqual(result.gaps, []); assert.equal(result.deletes, 1);
    assert.equal(await added.evaluate(() => app.messages.has(1)), false, 'Admission cannot grant earlier history');
    const sent = await send(old, 'old endpoint sends after catch-up');
    await caughtUp(added, sent); await caughtUp(peer, sent);
    await old.evaluate(() => app.socket.close());
    for (let i = 0; i < 4; i++) await send(added, `interrupted catch-up ${i}`);
    await added.evaluate(() => app.ensureMessageWindow(true));
    const retryTail = await send(added, 'after interrupted epoch');
    let networkFailed = false;
    await old.route('**/window-sync?*', route => {
      if (!networkFailed) { networkFailed = true; return route.abort('connectionreset'); }
      return route.continue();
    });
    await old.evaluate(() => {
      window.transientFailures = []; window.writeAborted = false; let writesUntilAbort = 2;
      app.operationalError = error => transientFailures.push(String(error));
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const request = original.apply(this, args);
        if (this.name === 'history' && !writeAborted && --writesUntilAbort === 0) {
          request.addEventListener('success', () => { writeAborted = true; this.transaction.abort(); }, { once: true });
        }
        return request;
      };
    });
    await old.evaluate(() => app.connectSocket());
    await caughtUp(old, retryTail);
    // lastSeq is staged before commitMlsReceive finishes. The receiver only
    // publishes the row to messages after that transaction has committed.
    await old.waitForFunction(seq => app.messages.has(seq), retryTail, { timeout: 60_000 });
    assert.equal(networkFailed, true);
    const retried = await old.evaluate(async tail => {
      const rows = await v.loadHistoryPageAfter(app.session, { afterSeq: 0, limit: 200 });
      return { aborted: writeAborted, errors: transientFailures.length, seqs: rows.map(row => row.seq),
        trailing: rows.filter(row => row.seq > tail).map(row => row.payload.kind), gaps: app.session.vault.expiredMessageRanges ?? [] };
    }, retryTail);
    assert.equal(retried.aborted, true); assert.ok(retried.errors >= 2);
    assert.ok(retried.seqs.length >= retryTail && retried.trailing.every(kind => kind === 'message-read'));
    assert.deepEqual(retried.seqs, Array.from({ length: retried.seqs.length }, (_, i) => i + 1));
    assert.deepEqual(retried.gaps, []);
    await old.unroute('**/window-sync?*');
    const finalText = 'old endpoint sends after automatic retries';
    await send(old, finalText);
    // A read-control event can take the next sequence before or after the text.
    // Check the message actually accepted, including its identity after reload.
    const finalMessage = await (await old.waitForFunction(text => {
      const row = [...app.messages.values()].find(item => item.payload.text === text && item.seq <= app.session.vault.lastSeq);
      return row && { seq: row.seq, clientMsgId: row.clientMsgId };
    }, finalText)).jsonValue();
    await caughtUp(added, finalMessage.seq); await caughtUp(peer, finalMessage.seq);
    await old.reload();
    const durable = await old.evaluate(async finalMessage => {
      const v = await import('/src/lib/vault.ts'); const session = await v.unlockVault('synthetic-catchup-password');
      const [row] = await v.loadHistoryPageAfter(session, { afterSeq: finalMessage.seq - 1, limit: 1 });
      return { seq: session.vault.lastSeq, id: row?.clientMsgId, text: row?.payload.text, gaps: session.vault.expiredMessageRanges ?? [] };
    }, finalMessage);
    assert.equal(durable.id, finalMessage.clientMsgId); assert.equal(durable.text, finalText);
    assert.ok(durable.seq >= finalMessage.seq); assert.deepEqual(durable.gaps, []);
    for (const page of [peer, added]) await healthy(page);
    console.log(`PASS ${engine.name()}: three-device admission, multipage epochs, network/IDB interruption retries, complete history, send and durable reload`);
  } finally {
    await browser?.close(); await vite?.close(); await backend?.close(); await rm(dataDir, { recursive: true, force: true });
  }
}
