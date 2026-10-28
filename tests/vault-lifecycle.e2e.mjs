import assert from 'node:assert/strict';
let setup; let teardown; const cases = [];
const beforeAll = callback => { setup = callback; };
const afterAll = callback => { teardown = callback; };
const describe = (_name, callback) => callback();
const it = (name, run) => cases.push({ name, run });
const expect = actual => ({ toEqual: expected => assert.deepEqual(actual, expected) });
import { chromium } from 'playwright';
import { createServer } from 'vite';
let server;
let browser;
let page;
beforeAll(async () => {
  server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
  server.middlewares.use('/__vault_regression', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Vault regression</title>'); });
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  page = await browser.newPage({locale: 'zh-CN'});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
  await page.goto(`http://localhost:${server.httpServer.address().port}/__vault_regression`);
}, 30_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

describe('actual IndexedDB vault lifecycle and MLS mutations', () => {
  it('preserves simultaneous sender/receiver ratchets and their atomic records', async () => {
    const result = await page.evaluate(async () => {
      const importBrowser = new Function('path', 'return import(path)');
      const { generateIdentity } = await importBrowser('/src/lib/crypto.ts');
      const { createVault, withVaultMutation, commitMlsSend, commitMlsReceive, unlockVault, loadOutbox, loadHistory } = await importBrowser('/src/lib/vault.ts');
      const { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, encryptMlsApplication, decryptMlsApplication } = await importBrowser('/src/lib/mls.ts');
      const [aIdentity, bIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
      const roomId = crypto.randomUUID();
      const members = [{ ...aIdentity.publicBundle, role: 'creator', joinProof: null }, { ...bIdentity.publicBundle, role: 'joiner', joinProof: 'proof' }];
      const common = { v: 3, roomId, accessToken: 'a'.repeat(43), pairingSecret: '', creatorFingerprint: 'fingerprint', members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' };
      const a = { ...common, identity: aIdentity, role: 'creator', mls: await createCreatorMlsState(roomId, aIdentity, members) };
      a.mls = await prepareCreatorWelcome(a);
      const b = { ...common, identity: bIdentity, role: 'joiner', mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
      b.mls = await joinMlsGroup(b, a.mls.pendingWelcome);
      a.mls.pendingWelcome = undefined;
      const session = await createVault(a);
      const payload = text => ({ v: 1, kind: 'text', text, sentAt: new Date().toISOString() });
      const incoming = await encryptMlsApplication(b, payload('incoming'), crypto.randomUUID());
      b.mls.groupState = incoming.nextGroupState;
      const events = [];
      const [outgoing] = await Promise.all([
        withVaultMutation(session, async mutation => {
          events.push('send-read');
          const content = payload('first');
          const next = await encryptMlsApplication(session.vault, content, crypto.randomUUID());
          await new Promise(resolve => setTimeout(resolve, 30));
          await commitMlsSend(session, { clientMsgId: next.envelope.clientMsgId, payload: content, createdAt: content.sentAt, envelope: next.envelope }, next.nextGroupState, mutation);
          events.push('send-write'); return next;
        }),
        withVaultMutation(session, async mutation => {
          events.push('receive-read');
          const next = await decryptMlsApplication(session.vault, incoming.envelope);
          await commitMlsReceive(session, { seq: 1, clientMsgId: incoming.envelope.clientMsgId, senderId: bIdentity.publicBundle.deviceId, payload: next.payload, acceptedAt: next.payload.sentAt, status: 'delivered' }, next.nextGroupState, undefined, mutation);
          events.push('receive-write');
        }),
      ]);
      b.mls.groupState = (await decryptMlsApplication(b, outgoing.envelope)).nextGroupState;
      const reopened = await unlockVault();
      const second = await encryptMlsApplication(reopened.vault, payload('second'), crypto.randomUUID());
      let replayRejected = false;
      try { await decryptMlsApplication(reopened.vault, incoming.envelope); } catch { replayRejected = true; }
      return { events, second: (await decryptMlsApplication(b, second.envelope)).payload.text, replayRejected, outbox: (await loadOutbox(reopened)).length, history: (await loadHistory(reopened)).map(message => message.payload.text) };
    });
    expect(result).toEqual({ events: ['send-read', 'send-write', 'receive-read', 'receive-write'], second: 'second', replayRejected: true, outbox: 1, history: ['incoming'] });
  }, 30_000);

  it('keeps the old retry envelope when re-encryption cannot commit', async () => {
    const result = await page.evaluate(async () => {
      const importBrowser = new Function('path', 'return import(path)');
      const { QuietRoomApp } = await importBrowser('/src/app.ts');
      const { unlockVault, loadOutbox, readStoredVault } = await importBrowser('/src/lib/vault.ts');
      const session = await unlockVault();
      const item = (await loadOutbox(session))[0];
      const beforeStored = JSON.stringify(await readStoredVault());
      const beforeEnvelope = JSON.stringify(item.envelope);
      const beforeGroup = session.vault.mls.groupState;
      const root = document.createElement('div'); document.body.append(root);
      const app = new QuietRoomApp(root);
      app.session = session; app.privacyCovered = false;
      app.outbox = new Map([[item.clientMsgId, item]]);
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      let failed = false;
      Object.defineProperty(crypto.subtle, 'encrypt', { configurable: true, value: async (...args) => {
        if (new TextDecoder().decode(args[0].additionalData) === 'quiet-room-vault-payload-v2') {
          failed = true;
          throw new DOMException('Simulated durable vault encryption failure', 'OperationError');
        }
        return encrypt(...args);
      } });
      let rejected = false;
      try { await app.reencryptOutboxItem(item.clientMsgId, item.envelope); } catch { rejected = true; }
      Object.defineProperty(crypto.subtle, 'encrypt', { configurable: true, value: encrypt });
      const result = { failed, rejected, sameItem: app.outbox.get(item.clientMsgId) === item, sameEnvelope: JSON.stringify(item.envelope) === beforeEnvelope, sameGroup: session.vault.mls.groupState === beforeGroup, sameStored: JSON.stringify(await readStoredVault()) === beforeStored };
      app.lockNow(); root.remove();
      return result;
    });
    expect(result).toEqual({ failed: true, rejected: true, sameItem: true, sameEnvelope: true, sameGroup: true, sameStored: true });
  });

  it('clears a replayed outbox row when its acknowledged history is already durable', async () => {
    const result = await page.evaluate(async () => {
      const importBrowser = new Function('path', 'return import(path)');
      const { QuietRoomApp } = await importBrowser('/src/app.ts');
      const { unlockVault, loadOutbox, saveHistoryMessage, saveVault, withVaultMutation } = await importBrowser('/src/lib/vault.ts');
      const first = await unlockVault();
      const item = (await loadOutbox(first))[0];
      await withVaultMutation(first, async mutation => {
        await saveHistoryMessage(first, {
          seq: 2,
          clientMsgId: item.clientMsgId,
          senderId: first.vault.identity.publicBundle.deviceId,
          payload: item.payload,
          acceptedAt: item.createdAt,
          status: 'stored',
        }, mutation);
        first.vault.lastSeq = 2;
        await saveVault(first, mutation);
      });

      const session = await unlockVault();
      const stranded = (await loadOutbox(session))[0];
      const root = document.createElement('div'); document.body.append(root);
      const app = new QuietRoomApp(root);
      app.session = session;
      app.privacyCovered = false;
      app.runtimeEpoch++;
      app.runtimeAbort = new AbortController();
      app.renderMessages = () => undefined;
      app.outbox = new Map([[stranded.clientMsgId, stranded]]);
      app.pending = new Map([[stranded.clientMsgId, {
        seq: Number.MAX_SAFE_INTEGER,
        clientMsgId: stranded.clientMsgId,
        senderId: session.vault.identity.publicBundle.deviceId,
        payload: stranded.payload,
        acceptedAt: stranded.createdAt,
        status: 'pending',
      }]]);
      let syncRequests = 0;
      const roomSocket = { requestSync: () => { syncRequests++; } };
      app.socket = roomSocket;
      await app.reconcileMessageAck(stranded.clientMsgId, 2, roomSocket, app.runtimeEpoch, session);
      const durableOutbox = await loadOutbox(session);
      const response = {
        durable: durableOutbox.length,
        memory: app.outbox.size,
        pending: app.pending.size,
        syncRequests,
      };
      app.runtimeAbort.abort();
      app.session = null;
      root.remove();
      return response;
    });
    expect(result).toEqual({ durable: 0, memory: 0, pending: 0, syncRequests: 0 });
  });

  it('unlocks after pending crypto and rejects stale and cross-room session writes', async () => {
    const result = await page.evaluate(async () => {
      const importBrowser = new Function('path', 'return import(path)');
      const { withVaultMutation, unlockVault, saveVault, createVault, readStoredVault } = await importBrowser('/src/lib/vault.ts');
      const first = await unlockVault();
      let release; let started;
      const startedPromise = new Promise(resolve => { started = resolve; });
      const delayed = withVaultMutation(first, async mutation => {
        started(); await new Promise(resolve => { release = resolve; });
        first.vault.lastSeq = 41; await saveVault(first, mutation);
      });
      await startedPromise;
      let unlockedEarly = false;
      const reopen = unlockVault().then(session => { unlockedEarly = true; return session; });
      await new Promise(resolve => setTimeout(resolve, 25));
      const waited = !unlockedEarly;
      release(); await delayed;
      const reopened = await reopen;
      const readCommittedSeq = reopened.vault.lastSeq;
      await withVaultMutation(reopened, async mutation => { reopened.vault.lastSeq = 42; await saveVault(reopened, mutation); });
      let staleRejected = false;
      try { await saveVault(first); } catch { staleRejected = true; }
      const newVault = structuredClone(reopened.vault); newVault.roomId = crypto.randomUUID();
      const next = await createVault(newVault);
      let crossRoomRejected = false;
      try { await saveVault(reopened); } catch { crossRoomRejected = true; }
      return { waited, readCommittedSeq, staleRejected, crossRoomRejected, retained: JSON.stringify(await readStoredVault()) === JSON.stringify(next.stored) };
    });
    expect(result).toEqual({ waited: true, readCommittedSeq: 41, staleRejected: true, crossRoomRejected: false, retained: true });
  }, 30_000);

  it('keeps password guessing delays and does not apply them to passkey vault failures', async () => {
    const result = await page.evaluate(async () => {
      const importBrowser = new Function('path', 'return import(path)');
      const { unlockVault, createVault } = await importBrowser('/src/lib/vault.ts');
      const readThrottle = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('quiet-room');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const tx = database.transaction('security', 'readonly');
          const get = tx.objectStore('security').get('unlock-throttle');
          get.onsuccess = () => { database.close(); resolve(get.result ?? null); };
          get.onerror = () => reject(get.error);
        };
      });
      const writeThrottle = record => new Promise((resolve, reject) => {
        const request = indexedDB.open('quiet-room');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const tx = database.transaction('security', 'readwrite');
          tx.objectStore('security').put(record, 'unlock-throttle');
          tx.oncomplete = () => { database.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
      const stamp = { failures: 9, nextAllowedAt: Date.now() + 60_000 };
      await writeThrottle(stamp);
      let stage = null;
      try {
        await unlockVault('', Promise.resolve(crypto.getRandomValues(new Uint8Array(32))));
      } catch (error) {
        stage = { name: error.name, stage: error.stage, code: error.code, message: error.message };
      }
      const afterFailure = await readThrottle();
      await unlockVault();
      const afterSuccess = await readThrottle();
      const session = await unlockVault();
      const passwordVault = structuredClone(session.vault);
      passwordVault.roomId = crypto.randomUUID();
      await createVault(passwordVault, 'correct-password', 'password');
      const passwordMessages = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await unlockVault('wrong-password'); }
        catch (error) { passwordMessages.push(error.message); }
      }
      return {
        stage,
        failureCount: afterFailure?.failures,
        failureWait: afterFailure?.nextAllowedAt,
        successCount: afterSuccess?.failures,
        passwordMessages,
      };
    });
    assert.equal(result.stage.name, 'UnlockStageError');
    assert.equal(result.stage.stage, 'S4');
    assert.match(result.stage.code, /^S4-\d+$/);
    assert.equal(result.stage.message.includes('无法用这次验证结果打开'), true);
    assert.equal(result.failureCount, 9);
    assert.equal(result.successCount, 9);
    assert.deepEqual(result.passwordMessages.slice(0, 4).map(message => message.startsWith('密码不正确')), [true, true, true, true]);
    assert.equal(result.passwordMessages[4].startsWith('尝试次数过多'), true);
  }, 30_000);
});

it('persists the first legacy envelope before sending and reuses it after retry and vault reopen', async () => {
  const result = await page.evaluate(async () => {
    const importBrowser = new Function('path', 'return import(path)');
    const { generateIdentity } = await importBrowser('/src/lib/crypto.ts');
    const { createVault, withVaultMutation, loadOutbox, unlockVault } = await importBrowser('/src/lib/vault.ts');
    const { QuietRoomApp } = await importBrowser('/src/app.ts');
    const [identity, peer] = await Promise.all([generateIdentity(), generateIdentity()]);
    const members = [{ ...identity.publicBundle, role: 'creator', joinProof: null }, { ...peer.publicBundle, role: 'joiner', joinProof: 'proof' }];
    const session = await createVault({ v: 3, roomId: crypto.randomUUID(), accessToken: 'a'.repeat(43), pairingSecret: 'p'.repeat(43),
      creatorFingerprint: 'fingerprint', members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'legacy-v1', identity, role: 'creator' });
    const root = document.createElement('div'); document.body.append(root);
    const app = new QuietRoomApp(root), sent = [], durableReads = [];
    app.session = session; app.privacyCovered = false; app.connectionState = 'connected'; app.runtimeAbort = new AbortController();
    app.renderMessages = () => {}; app.trackChatViewport = () => {}; app.scheduleRetry = () => {};
    app.socket = { close() {}, setChatPresence() {}, sendEnvelope(envelope) {
      sent.push(JSON.stringify(envelope));
      durableReads.push(loadOutbox(app.session).then(rows => JSON.stringify(rows.find(row => row.clientMsgId === envelope.clientMsgId)?.envelope) === JSON.stringify(envelope)));
    } };
    try {
      const payload = { v: 1, kind: 'text', text: 'synthetic legacy retry', sentAt: new Date().toISOString() };
      // Use the public submit boundary: network draining now starts after the
      // local mutation lease is released, while first-ciphertext durability
      // and identical-byte retries remain the asserted contract.
      await app.sendPayload(payload);
      await app.outboxDrain;
      const [item] = await loadOutbox(session);
      // Neither an ACK nor an own echo is applied: retry must keep the stored bytes.
      await app.attemptSend(item.clientMsgId);
      const reopened = await unlockVault();
      app.session = reopened; app.outbox = new Map((await loadOutbox(reopened)).map(row => [row.clientMsgId, row]));
      await app.attemptSend(item.clientMsgId);
      return { sent: sent.length, identical: sent.every(envelope => envelope === sent[0]), durableBeforeSend: (await Promise.all(durableReads)).every(Boolean) };
    } finally { app.lockNow(); root.remove(); }
  });
  expect(result).toEqual({ sent: 3, identical: true, durableBeforeSend: true });
});

it('upgrades payload-only legacy retries once and never sends when their ciphertext cannot persist', async () => {
  // Each independent vault fixture owns its target and virtual authenticator.
  await page.close();
  page = await browser.newPage({locale: 'zh-CN'});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
  await page.goto(`http://localhost:${server.httpServer.address().port}/__vault_regression`);
  const result = await page.evaluate(async () => {
    const importBrowser = new Function('path', 'return import(path)');
    const { generateIdentity } = await importBrowser('/src/lib/crypto.ts');
    const { createVault, saveOutboxItem, loadOutbox, prepareLegacyOutboxItem } = await importBrowser('/src/lib/vault.ts');
    const { QuietRoomApp } = await importBrowser('/src/app.ts');
    const [identity, peer] = await Promise.all([generateIdentity(), generateIdentity()]);
    const session = await createVault({ v: 3, roomId: crypto.randomUUID(), accessToken: 'a'.repeat(43), pairingSecret: 'p'.repeat(43),
      creatorFingerprint: 'fingerprint', members: [{ ...identity.publicBundle, role: 'creator', joinProof: null }, { ...peer.publicBundle, role: 'joiner', joinProof: 'proof' }],
      lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'legacy-v1', identity, role: 'creator' });
    const payload = { v: 1, kind: 'text', text: 'older payload-only retry', sentAt: new Date().toISOString() };
    const item = { clientMsgId: crypto.randomUUID(), payload, createdAt: payload.sentAt };
    await saveOutboxItem(session, item);
    const root = document.createElement('div'); document.body.append(root);
    const app = new QuietRoomApp(root), sent = [];
    app.session = session; app.privacyCovered = false; app.connectionState = 'connected'; app.runtimeAbort = new AbortController();
    app.outbox = new Map([[item.clientMsgId, item]]);
    app.renderMessages = () => {}; app.showNotice = () => {}; app.scheduleRetry = () => {};
    let syncRequests = 0;
    app.socket = { close() {}, setChatPresence() {}, requestSync() { syncRequests++; }, sendEnvelope(envelope) { sent.push(JSON.stringify(envelope)); } };
    app.legacyRetrySyncTarget = 1;
    await app.attemptSend(item.clientMsgId);
    const deferredBeforeSync = sent.length === 0 && !(await loadOutbox(session))[0].envelope;
    app.legacyRetrySyncTarget = 0;
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle); let injected = false;
    Object.defineProperty(crypto.subtle, 'encrypt', { configurable: true, value: async (...args) => {
      if (new TextDecoder().decode(args[0].additionalData).startsWith('quiet-room-outbox-v1:')) {
        injected = true; throw new DOMException('Synthetic outbox persistence failure', 'OperationError');
      }
      return encrypt(...args);
    } });
    try {
      await app.attemptSend(item.clientMsgId);
      const before = { sent: sent.length, hasEnvelope: Boolean((await loadOutbox(session))[0].envelope) };
      Object.defineProperty(crypto.subtle, 'encrypt', { configurable: true, value: encrypt });
      const upgraded = await Promise.all([prepareLegacyOutboxItem(session, item.clientMsgId), prepareLegacyOutboxItem(session, item.clientMsgId)]);
      await app.attemptSend(item.clientMsgId);
      await app.attemptSend(item.clientMsgId);
      const missing = await prepareLegacyOutboxItem(session, crypto.randomUUID());
      return { injected, before, deferredBeforeSync, syncRequests, samePendingItem: app.outbox.get(item.clientMsgId) === item, sent: sent.length, oneEnvelope: JSON.stringify(upgraded[0].envelope) === JSON.stringify(upgraded[1].envelope)
        && sent.every(envelope => envelope === JSON.stringify(upgraded[0].envelope)), missingDoesNotRecreate: missing === undefined };
    } finally { Object.defineProperty(crypto.subtle, 'encrypt', { configurable: true, value: encrypt }); app.lockNow(); root.remove(); }
  });
  expect(result).toEqual({ injected: true, before: { sent: 0, hasEnvelope: false }, deferredBeforeSync: true, syncRequests: 1, samePendingItem: true, sent: 2, oneEnvelope: true, missingDoesNotRecreate: true });
});

it('preserves bounded large vaults and rejects oversized ordinary and atomic writes without partial records', async () => {
  const result = await page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { createCreatorMlsState } = await import('/src/lib/mls.ts');
    const { deriveNumericPasswordCredential } = await import('/src/lib/password-protection.ts');
    const identity = await generateIdentity(), roomId = crypto.randomUUID();
    const members = [{ ...identity.publicBundle, role: 'creator', joinProof: null, status: 'active' }];
    const base = { v: 3, roomId, accessToken: 'a'.repeat(43), role: 'creator', pairingSecret: '', creatorFingerprint: 'synthetic',
      identity, members, lastSeq: 0, lastReceiptSeq: 0, pairingState: 'ready', createdAt: new Date().toISOString(), protocol: 'mls-rfc9420',
      mls: await createCreatorMlsState(roomId, identity, members) };
    const session = await v.createVault(base, '', 'password', await deriveNumericPasswordCredential('012345'));
    const writeRaw = stored => new Promise((resolve, reject) => {
      const request = indexedDB.open('quiet-room');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('vault', 'readwrite');
        tx.objectStore('vault').put(stored, v.vaultSpaceId(session.stored));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    session.vault.archiveState = { cursor: 0, revision: 0, preparing: { itemId: 'synthetic', media: [], next: {
      v: 2, archiveId: 'A'.repeat(43), id: crypto.randomUUID(), enc: 'A'.repeat(43), signature: 'A'.repeat(86), ciphertext: '',
    } } };
    // Fill an authenticated payload to the exact supported base64url ceiling.
    // The padding is synthetic; real chunk/signature validation is covered by
    // room-archive-lifecycle using an actual multi-chunk PNG and real service.
    const maximum = 8 * 1024 * 1024;
    const overhead = new TextEncoder().encode(JSON.stringify(session.vault)).length;
    session.vault.archiveState.preparing.next.ciphertext = 'A'.repeat(maximum * 3 / 4 - 16 - overhead);
    await v.saveVault(session);
    const stored = await v.readStoredVault(), before = JSON.stringify(stored);
    if (stored.payload.ciphertext.length !== maximum) throw new Error('Fixture missed the exact ciphertext boundary');
    let wrongPassword = false;
    try { await v.unlockVault('111111', undefined, stored); } catch { wrongPassword = true; }
    const reopened = await v.unlockVault('012345', undefined, stored);
    const tampered = structuredClone(stored);
    tampered.payload.ciphertext = (tampered.payload.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.payload.ciphertext.slice(1);
    await writeRaw(tampered);
    let tamperingRejected = false;
    try { await v.unlockVault('012345'); } catch { tamperingRejected = true; }
    const tamperingPreserved = JSON.stringify(await v.readStoredVault()) === JSON.stringify(tampered);
    await writeRaw(stored);
    const invalidRecords = [
      { ...stored, payload: { ...stored.payload, ciphertext: stored.payload.ciphertext + 'A' } },
      { ...stored, spaceId: 'another-slot' },
      { ...stored, wrappedKey: { ...stored.wrappedKey, ciphertext: stored.wrappedKey.ciphertext + 'A' } },
    ];
    let invalidRejected = true;
    for (const invalid of invalidRecords) { await writeRaw(invalid); invalidRejected &&= await v.readStoredVault() === null; }
    await writeRaw(stored);
    // One extra ASCII byte and one extra multibyte code point each exceed the
    // same reader ceiling; neither can replace the valid durable checkpoint.
    const padding = reopened.vault.archiveState.preparing.next.ciphertext;
    const failures = [];
    for (const extra of ['A', '密']) {
      reopened.vault.archiveState.preparing.next.ciphertext = extra === '密' ? padding.slice(0, -1) + extra : padding + extra;
      try { await v.saveVault(reopened); failures.push('accepted'); }
      catch (cause) { failures.push(cause.message); }
    }
    const sentAt = new Date().toISOString(), clientMsgId = crypto.randomUUID();
    const payload = { v: 1, kind: 'text', text: 'synthetic capacity guard', sentAt };
    for (const operation of [
      mutation => v.commitMlsSend(reopened, { clientMsgId, payload, createdAt: sentAt }, reopened.vault.mls.groupState, mutation),
      mutation => v.commitMlsReceive(reopened, { seq: 1, clientMsgId, senderId: identity.publicBundle.deviceId, payload, acceptedAt: sentAt, status: 'stored' }, reopened.vault.mls.groupState, undefined, mutation),
    ]) {
      try { await v.withVaultMutation(reopened, operation); failures.push('accepted'); }
      catch (cause) { failures.push(cause.message); }
    }
    const atomic = { sameStored: JSON.stringify(await v.readStoredVault()) === before, sameSessionStored: JSON.stringify(reopened.stored) === before,
      outbox: (await v.loadOutbox(reopened)).length, history: (await v.loadHistory(reopened)).length, receipts: (await v.loadPendingReceipts(reopened)).length };
    reopened.vault.archiveState.preparing.next.ciphertext = padding;
    const stale = { ...reopened };
    delete reopened.vault.archiveState;
    await v.saveVault(reopened);
    let staleRejected = false;
    try { await v.saveVault(stale); } catch (cause) { staleRejected = cause.message.includes('其它窗口'); }
    const reopenedSameRoom = (await v.unlockVault('012345')).vault.roomId === roomId;
    const platform = await v.createVault({ ...base, archiveState: { cursor: 0, revision: 0, preparing: {
      itemId: 'platform-capacity', media: [], next: { ...session.vault.archiveState.preparing.next, ciphertext: 'A'.repeat(2 * 1024 * 1024) },
    } } });
    const platformStored = await v.readStoredVault();
    const platformReopened = await v.unlockVault();
    const exported = await v.prepareRecoveryPackage(platformReopened);
    await v.importRecoveryPackage(new File([exported.blob], 'synthetic-recovery.json', { type: 'application/json' }));
    const recoveryStored = await v.readStoredVault(), recovered = await v.unlockRecoveryVault(exported.recoveryCode);
    return { boundary: stored.payload.ciphertext.length === maximum, wrongPassword, tamperingRejected, tamperingPreserved, invalidRejected,
      limitRejected: failures.length === 4 && failures.every(message => message.includes('容量超过支持上限')), atomic, staleRejected,
      reopened: reopenedSameRoom,
      platformReopened: platformStored.payload.ciphertext.length > 2 * 1024 * 1024 && platformReopened.vault.roomId === platform.vault.roomId,
      recoveryReopened: recoveryStored.payload.ciphertext.length > 2 * 1024 * 1024 && recovered.vault.roomId === platform.vault.roomId };
  });
  expect(result).toEqual({ boundary: true, wrongPassword: true, tamperingRejected: true, tamperingPreserved: true, invalidRejected: true, limitRejected: true,
    atomic: { sameStored: true, sameSessionStored: true, outbox: 0, history: 0, receipts: 0 }, staleRejected: true, reopened: true, platformReopened: true, recoveryReopened: true });
});

it('isolates independently keyed new-room endpoints without losing the original encrypted history', async () => {
  const result = await page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts'), b = await import('/src/lib/browser-room-key.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { newArchiveKey } = await import('/src/lib/room-archive-crypto.ts');
    const identity = await generateIdentity(), roomId = crypto.randomUUID();
    const vault = { v: 3, roomId, accessToken: 'a'.repeat(43), creatorFingerprint: 'scope-regression', identity, role: 'joiner',
      pairingSecret: '', members: [], lastSeq: 0, createdAt: new Date().toISOString(), roomArchiveV2: { key: newArchiveKey() } };
    const original = await v.createVault(vault, '', 'platform', await b.automaticRoomCredential());
    const message = { seq: 161, clientMsgId: crypto.randomUUID(), senderId: identity.publicBundle.deviceId,
      payload: { v: 1, kind: 'text', text: 'original-history', sentAt: new Date().toISOString() }, acceptedAt: new Date().toISOString(), status: 'delivered' };
    await v.saveHistoryMessage(original, message);
    const before = JSON.stringify(original.stored);
    const replacement = await v.createVault({ ...vault, identity: await generateIdentity(), lastSeq: 161, historyUnavailableBeforeSeq: 161 }, '', 'platform', await b.automaticRoomCredential());
    await v.loadMessageEventHistory(replacement);
    return { replacement: (await v.loadHistory(replacement)).length, original: (await v.loadHistory(original))[0].payload.text,
      preserved: JSON.stringify((await v.unlockVault(await b.browserRoomKey(), undefined, original.stored)).stored) === before };
  });
  expect(result).toEqual({ replacement: 0, original: 'original-history', preserved: true });
});

it('authenticates the original history owner and forks a repaired session while preserving every source slot', async () => {
  const result = await page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts'), b = await import('/src/lib/browser-room-key.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts'), { newArchiveKey } = await import('/src/lib/room-archive-crypto.ts');
    const identity = await generateIdentity(), replacementIdentity = await generateIdentity(), roomId = crypto.randomUUID();
    const base = { v: 3, roomId, accessToken: 'a'.repeat(43), creatorFingerprint: 'retained-owner', identity, role: 'joiner', pairingSecret: '',
      members: [], lastSeq: 162, historyUnavailableBeforeSeq: 160, createdAt: new Date().toISOString(), roomArchiveV2: { key: newArchiveKey() } };
    const owner = await v.createVault(base, '', 'platform', await b.automaticRoomCredential());
    delete owner.vault.localDataScope; await v.saveVault(owner); // Pre-fix shared-room namespace.
    const id = crypto.randomUUID(), sentAt = new Date().toISOString();
    for (const message of [{ seq: 161, clientMsgId: id, payload: { v: 1, kind: 'text', text: 'retained-history', sentAt } },
      { seq: 162, clientMsgId: crypto.randomUUID(), payload: { v: 1, kind: 'message-delete', target: { clientMsgId: id, serverSeq: 161, senderId: identity.publicBundle.deviceId }, sentAt } }]) {
      await v.saveHistoryMessage(owner, { ...message, senderId: identity.publicBundle.deviceId, acceptedAt: sentAt, status: 'delivered' });
    }
    await v.saveUiPreferences(owner, { composerDraft: 'retained-draft' });
    const ownerBefore = JSON.stringify(owner.stored);
    const broken = await v.createVault({ ...base, identity: replacementIdentity, lastSeq: 162, historyUnavailableBeforeSeq: 162,
      members: [{ ...identity.publicBundle, role: 'joiner', status: 'revoked' }, { ...replacementIdentity.publicBundle, role: 'joiner', status: 'active' }] }, '', 'platform', await b.automaticRoomCredential());
    delete broken.vault.localDataScope; await v.saveVault(broken); // Already-installed pre-fix replacement.
    const brokenBefore = JSON.stringify(broken.stored), secret = await b.browserRoomKey();
    let integrityRejected = false;
    try { await v.loadMessageEventHistory(broken); } catch (cause) { integrityRejected = cause instanceof v.HistoryIntegrityError; }
    const found = await v.findArchiveHistoryOwner(broken.vault, secret, () => true);
    const repaired = await v.createArchiveRepairVault(broken.vault, found, await b.automaticRoomCredential(), () => true, broken);
    const events = await v.loadMessageEventHistory(repaired);
    const reread = async stored => JSON.stringify((await v.unlockVault(secret, undefined, stored)).stored);
    const preserved = await reread(owner.stored) === ownerBefore && await reread(broken.stored) === brokenBefore;
    let cancelled = false, stale = false, wrongRole = false;
    try { await v.createArchiveRepairVault(repaired.vault, found, await b.automaticRoomCredential(), () => false); } catch (cause) { cancelled = cause.name === 'AbortError'; }
    try { await v.createArchiveRepairVault({ ...repaired.vault, role: 'creator' }, found, await b.automaticRoomCredential(), () => true); } catch { wrongRole = true; }
    const raced = { ...broken }; await v.saveVault(broken);
    try { await v.createArchiveRepairVault(repaired.vault, found, await b.automaticRoomCredential(), () => true, raced); } catch (cause) { stale = cause.message.includes('其它窗口'); }
    const wrongCreator = await v.findArchiveHistoryOwner({ ...broken.vault, creatorFingerprint: 'different-creator' }, secret, () => true) === null;
    const otherActive = await v.findArchiveHistoryOwner({ ...broken.vault, members: broken.vault.members.map(member => ({ ...member, status: 'active' })) }, secret, () => true, crypto.randomUUID()) === null;
    const db = await new Promise(resolve => { const r = indexedDB.open('quiet-room'); r.onsuccess = () => resolve(r.result); });
    const count = () => new Promise(resolve => { const tx = db.transaction('vault'), r = tx.objectStore('vault').count(); tx.oncomplete = () => resolve(r.result); });
    const countBefore = await count();
    let live = true, lateRejected = false;
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, 'encrypt', { configurable: true, value: async (...args) => {
      const result = await encrypt(...args);
      if (new TextDecoder().decode(args[0].additionalData) === 'quiet-room-vault-payload-v2') live = false;
      return result;
    } });
    try { await v.createArchiveRepairVault(repaired.vault, found, await b.automaticRoomCredential(), () => live); } catch (cause) { lateRejected = cause.name === 'AbortError'; }
    finally { Object.defineProperty(crypto.subtle, 'encrypt', { configurable: true, value: encrypt }); }
    const noPartialSlot = await count() === countBefore;
    const controller = new AbortController(), put = IDBObjectStore.prototype.put;
    let transactionCancelled = false;
    IDBObjectStore.prototype.put = function (...args) {
      const result = put.apply(this, args);
      if (this.name === 'vault' && args[0].spaceId !== owner.stored.spaceId) controller.abort();
      return result;
    };
    try { await v.createArchiveRepairVault(repaired.vault, found, await b.automaticRoomCredential(), () => true, undefined, controller.signal); }
    catch (cause) { transactionCancelled = cause.name === 'AbortError'; }
    finally { IDBObjectStore.prototype.put = put; }
    transactionCancelled &&= await count() === countBefore;
    await v.createArchiveRepairVault({ ...repaired.vault, lastSeq: 161, historyUnavailableBeforeSeq: 160 }, found, await b.automaticRoomCredential(), () => true);
    await new Promise(resolve => { const tx = db.transaction('history', 'readwrite'), store = tx.objectStore('history'), r = store.get(`${roomId}:162`);
      r.onsuccess = () => { const record = r.result; record.ciphertext = (record.ciphertext[0] === 'A' ? 'B' : 'A') + record.ciphertext.slice(1); store.put(record); }; tx.oncomplete = resolve; });
    let tombstoneRejected = false;
    try { await v.loadMessageEventHistory(repaired); } catch (cause) { tombstoneRejected = cause instanceof v.HistoryIntegrityError; }
    const noUnverifiedFallback = await v.findArchiveHistoryOwner(broken.vault, secret, () => true) === null;
    await new Promise(resolve => { const tx = db.transaction('history', 'readwrite'); tx.objectStore('history').delete(`${roomId}:162`); tx.oncomplete = resolve; });
    const noOlderCheckpointBypass = await v.findArchiveHistoryOwner(broken.vault, secret, () => true) === null; db.close();
    return { integrityRejected, found: found.stored.spaceId === owner.stored.spaceId, preserved, separateSlot: ![owner.stored.spaceId, broken.stored.spaceId].includes(repaired.stored.spaceId),
      text: (await v.loadHistory(repaired))[0].payload.text, tombstone: events.some(message => message.payload.kind === 'message-delete'),
      draft: (await v.loadUiPreferences(repaired)).composerDraft, archive: repaired.vault.roomArchiveV2.key.descriptor.id === owner.vault.roomArchiveV2.key.descriptor.id,
      currentIdentity: repaired.vault.identity.publicBundle.deviceId === replacementIdentity.publicBundle.deviceId, cancelled, stale, wrongRole,
      wrongCreator, otherActive, lateRejected, noPartialSlot, transactionCancelled, tombstoneRejected, noUnverifiedFallback, noOlderCheckpointBypass };
  });
  expect(result).toEqual({ integrityRejected: true, found: true, preserved: true, separateSlot: true, text: 'retained-history', tombstone: true,
    draft: 'retained-draft', archive: true, currentIdentity: true, cancelled: true, stale: true, wrongRole: true,
    wrongCreator: true, otherActive: true, lateRejected: true, noPartialSlot: true, transactionCancelled: true, tombstoneRejected: true, noUnverifiedFallback: true, noOlderCheckpointBypass: true });
});

it('finds only authenticated same-history local successors and fences selection changes', async () => {
  const result = await page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts'), b = await import('/src/lib/browser-room-key.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { newArchiveKey } = await import('/src/lib/room-archive-crypto.ts');
    const identity = await generateIdentity(), replacement = await generateIdentity();
    const base = { v: 3, roomId: crypto.randomUUID(), accessToken: 'c'.repeat(43), creatorFingerprint: 'reentry-owner',
      identity, role: 'joiner', pairingSecret: '', members: [{ ...identity.publicBundle, role: 'joiner', status: 'active' }],
      lastSeq: 0, createdAt: new Date().toISOString(), pairingState: 'ready', protocol: 'mls-rfc9420',
      mls: { protocol: 'mls-rfc9420', phase: 'active' }, roomArchiveV2: { key: newArchiveKey() } };
    const owner = await v.createVault(base, '', 'platform', await b.automaticRoomCredential());
    const oldBytes = JSON.stringify(owner.stored), nextVault = { ...owner.vault, identity: replacement,
      members: [{ ...identity.publicBundle, role: 'joiner', status: 'revoked' }, { ...replacement.publicBundle, role: 'joiner', status: 'active' }] };
    const next = await v.createArchiveRepairVault(nextVault, owner, await b.automaticRoomCredential(), () => true);
    const secret = await b.browserRoomKey();
    const candidates = await v.findLocalArchiveSuccessors(owner, secret, () => true);
    const one = candidates.length === 1 && candidates[0].stored.spaceId === next.stored.spaceId;
    const database = await new Promise(resolve => { const r = indexedDB.open('quiet-room'); r.onsuccess = () => resolve(r.result); });
    const put = value => new Promise((resolve, reject) => {
      const tx = database.transaction('vault', 'readwrite'); tx.objectStore('vault').put(value, value.spaceId);
      tx.oncomplete = resolve; tx.onabort = reject;
    });
    const ciphertext = next.stored.payload.ciphertext;
    await put({ ...next.stored, payload: { ...next.stored.payload, ciphertext: (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1) } });
    let sameMasterCorruptionRejected = false;
    try { await v.findLocalArchiveSuccessors(owner, secret, () => true); }
    catch (cause) { sameMasterCorruptionRejected = cause.message.includes('同历史保险库无法验证'); }
    finally { await put(next.stored); database.close(); }
    const wrongSecret = (await v.findLocalArchiveSuccessors(owner, 'wrong secret', () => true)).length === 0;
    const wrongRole = (await v.findLocalArchiveSuccessors({ ...owner, vault: { ...owner.vault, role: 'creator' } }, secret, () => true)).length === 0;
    const wrongCreator = (await v.findLocalArchiveSuccessors({ ...owner, vault: { ...owner.vault, creatorFingerprint: 'other' } }, secret, () => true)).length === 0;
    const wrongScope = (await v.findLocalArchiveSuccessors({ ...owner, vault: { ...owner.vault, localDataScope: crypto.randomUUID() } }, secret, () => true)).length === 0;
    let cancelled = false, stale = false;
    const selected = v.currentSpaceId();
    try { await v.selectVerifiedArchiveSuccessor(owner, candidates[0], () => false); } catch (cause) { cancelled = cause.name === 'AbortError'; }
    const noLateSelection = v.currentSpaceId() === selected;
    await v.saveVault(next);
    try { await v.selectVerifiedArchiveSuccessor(owner, candidates[0], () => true); } catch (cause) { stale = cause.message.includes('其它窗口'); }
    const fresh = (await v.findLocalArchiveSuccessors(owner, secret, () => true))[0];
    await v.selectVerifiedArchiveSuccessor(owner, fresh, () => true);
    const selection = v.currentSpaceId() === next.stored.spaceId && sessionStorage.getItem('quiet-room:space') === next.stored.spaceId;
    const old = await v.unlockVault(secret, undefined, owner.stored);
    return { one, sameMasterCorruptionRejected, wrongSecret, wrongRole, wrongCreator, wrongScope, cancelled, noLateSelection, stale, selection,
      originalBytes: JSON.stringify(old.stored) === oldBytes };
  });
  expect(result).toEqual({ one: true, sameMasterCorruptionRejected: true, wrongSecret: true, wrongRole: true, wrongCreator: true, wrongScope: true,
    cancelled: true, noLateSelection: true, stale: true, selection: true, originalBytes: true });
});

try {
  await setup();
  for (const test of cases) { await test.run(); console.log(`PASS ${test.name}`); }
} finally { await teardown(); }
