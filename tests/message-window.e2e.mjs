import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
const dataDir = await mkdtemp(path.join(tmpdir(), 'qr-window-browser-'));
const backend = await startServer({ dataDir, port: 0, host: '127.0.0.1', quiet: true, maxMessagesPerRoom: 12 });
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false,
  proxy: { '/api': { target: `http://127.0.0.1:${backend.port}`, changeOrigin: true }, '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true } } } });
server.middlewares.use('/__window', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta id="system-chrome-color"><div id="app"></div>'); });
let browser;
try {
  await server.listen(); browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({locale: 'zh-CN'}); const page = await context.newPage(); pages.push(page);
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/__window`);
  }
  const [a, b] = pages;
  const room = await a.evaluate(async () => {
    const c = await import('/src/lib/crypto.ts'); const api = await import('/src/lib/api.ts');
    window.identity = await c.generateIdentity();
    const room = await api.createRoom(identity.publicBundle, 'a'.repeat(43), 'i'.repeat(43), 'a', ['message-window-v1']);
    return { ...room, fingerprint: await c.bundleFingerprint(identity.publicBundle) };
  });
  await b.evaluate(async room => {
    const c = await import('/src/lib/crypto.ts'); const api = await import('/src/lib/api.ts');
    window.identity = await c.generateIdentity();
    const proof = await c.createJoinProof('p'.repeat(43), identity.publicBundle);
    await api.joinRoom(room.roomId, 'i'.repeat(43), identity.publicBundle, proof, 'b'.repeat(43), 'b', ['message-window-v1']);
  }, room);
  for (const [i, page] of pages.entries()) await page.evaluate(async ({ room, i }) => {
    const api = await import('/src/lib/api.ts'); const mls = await import('/src/lib/mls.ts'); const v = await import('/src/lib/vault.ts'); const { QuietRoomApp } = await import('/src/app.ts');
    const accessToken = (i ? 'b' : 'a').repeat(43), role = i ? 'joiner' : 'creator';
    const state = await api.getRoomState(room.roomId, accessToken);
    const vault = { v: 3, roomId: room.roomId, accessToken, role, pairingSecret: 'p'.repeat(43), creatorFingerprint: room.fingerprint, identity,
      members: state.members, lastSeq: 0, lastReceiptSeq: 0, protocol: 'mls-rfc9420', createdAt: new Date().toISOString(), pairingState: 'ready' };
    if (!i) { vault.mls = await mls.createCreatorMlsState(room.roomId, identity, state.members); vault.mls = await mls.prepareCreatorWelcome(vault); await api.publishMlsWelcome(room.roomId, accessToken, vault.mls.pendingWelcome); vault.mls.pendingWelcome = undefined; }
    else { vault.mls = { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' }; vault.mls = await mls.joinMlsGroup(vault, state.mlsWelcome); }
    window.app = new QuietRoomApp(document.querySelector('#app')); app.session = await v.createVault(vault); app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
    window.failures = []; app.operationalError = e => failures.push(String(e)); app.fatalSecurityError = e => { failures.push(String(e)); app.privacyCovered = true; };
    for (const name of ['renderMessages', 'updateConnectionStatus', 'updatePeerStatus', 'updateCallControls', 'paintInviteProgress', 'showNotice', 'closeViewerIfProjectionDeleted']) app[name] = () => {};
    app.ensureCallController = () => {}; app.presenceCircuit = null;
    await app.connectSocket();
  }, { room, i });
  for (const page of pages) await page.waitForFunction(() => app.connectionState === 'connected');
  async function send(text) {
    await a.evaluate(text => app.enqueuePayload({ v: 1, kind: 'text', text, sentAt: new Date().toISOString() }), text);
  }
  // Old clients persisted the prepared Add before transport. Model a dropped
  // request with the original vault format and a real server-side reservation.
  const stageDeviceAdd = lifetime => a.evaluate(async lifetime => {
    const api = await import('/src/lib/api.ts');
    const cryptoLib = await import('/src/lib/crypto.ts');
    const { randomBase64Url } = await import('/src/lib/base64.ts');
    const { prepareMlsMembership } = await import('/src/lib/mls.ts');
    const { saveVault, withVaultMutation } = await import('/src/lib/vault.ts');
    const session = app.session, vault = session.vault;
    const linkId = crypto.randomUUID(), secret = randomBase64Url(32);
    const admissionSecret = randomBase64Url(32);
    const expiresAt = new Date(Date.now() + lifetime).toISOString();
    await api.createDeviceLink(vault.roomId, vault.accessToken, identity.publicBundle.deviceId, linkId, secret, expiresAt);
    const candidate = await cryptoLib.generateIdentity();
    const proof = await cryptoLib.createJoinProof(admissionSecret, candidate.publicBundle);
    const claim = await api.claimDeviceLink(linkId, secret, candidate.publicBundle, randomBase64Url(32), 'PC', ['message-window-v1'], undefined, proof);
    const target = claim.state.members.find(member => member.deviceId === candidate.publicBundle.deviceId);
    await withVaultMutation(session, async mutation => {
      vault.pendingDeviceLinks = [{ linkId, secret, admissionSecret, expiresAt, createdAt: new Date().toISOString() }];
      vault.mls.pendingMembership = await prepareMlsMembership(vault, 'add', target);
      await saveVault(session, mutation);
    });
    return { expiresAt, targetId: target.deviceId };
  }, lifetime);
  const { expiresAt } = await stageDeviceAdd(8000);
  assert.match(await a.evaluate(() => app.ensureMessageWindow(true).then(() => '', e => e.message)), /设备变更尚未确认/);
  // Leave the original intent in the outbox before expiry, then let normal
  // retries deliver it. No refresh or manual resubmission on either endpoint.
  assert.ok(Date.now() < Date.parse(expiresAt));
  await send('kept locally');
  for (const page of pages) await page.waitForFunction(() => app.session.vault.lastSeq === 1 || failures.length);
  assert.deepEqual(await a.evaluate(() => failures), []); assert.deepEqual(await b.evaluate(() => failures), []);
  const first = await a.evaluate(() => ({ clientMsgId: app.messages.get(1).clientMsgId, serverSeq: 1, senderId: identity.publicBundle.deviceId }));
  await b.evaluate(() => { app.socket.close(); });
  // Exercise real outbox retries, full-window rekey, signed control retention and ordering.
  await a.evaluate(target => app.enqueuePayload({ v: 1, kind: 'message-delete', target, sentAt: new Date().toISOString() }), first);
  await a.waitForFunction(() => app.session.vault.lastSeq === 2 || failures.length);
  for (let seq = 3; seq <= 70; seq++) {
    await send(`message ${seq}`);
    await a.waitForFunction(seq => app.session.vault.lastSeq === seq || failures.length, seq);
    const failures = await a.evaluate(() => window.failures); assert.deepEqual(failures, [], `sender seq ${seq}`);
  }
  await b.evaluate(() => app.connectSocket());
  await b.waitForFunction(() => app.session.vault.lastSeq === 70 || failures.length, null, { timeout: 30_000 });
  const offline = await b.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    const events = await v.loadMessageEventHistory(app.session);
    return { failures, lastSeq: app.session.vault.lastSeq, gaps: app.session.vault.expiredMessageRanges?.length ?? 0, deletion: events.some(m => m.payload.kind === 'message-delete'), lastText: app.messages.get(70)?.payload.text };
  });
  assert.deepEqual(offline.failures, []); assert.equal(offline.lastSeq, 70); assert.ok(offline.gaps > 0); assert.equal(offline.deletion, true); assert.equal(offline.lastText, 'message 70');
  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(pages.map((page, index) => page.evaluate(({batch, index}) => app.enqueuePayload({ v: 1, kind: 'text', text: `concurrent-${batch}-${index}`, sentAt: new Date().toISOString() }), {batch, index})));
    for (const page of pages) {
      await page.waitForFunction(seq => app.session.vault.lastSeq === seq || failures.length, 72 + batch * 2, { timeout: 15_000 });
      assert.deepEqual(await page.evaluate(() => failures), []);
    }
  }
  // Commit another Add without consuming its HTTP response or broadcast on
  // the authorizer. Recovery must install the exact saved successor instead.
  await a.evaluate(() => app.socket.close());
  const { targetId } = await stageDeviceAdd(600_000);
  const recovered = await a.evaluate(async targetId => {
    const api = await import('/src/lib/api.ts');
    const vault = app.session.vault, pending = vault.mls.pendingMembership;
    await api.publishMlsMembership(vault.roomId, vault.accessToken, pending.event);
    await app.ensureMessageWindow(false);
    return !vault.mls.pendingMembership && vault.mls.groupState === pending.nextGroupState &&
      vault.members.some(member => member.deviceId === targetId && member.status === 'active');
  }, targetId);
  assert.ok(recovered, 'A committed Add with a lost response installs its saved group state');
  await b.reload();
  const durable = await b.evaluate(async () => {
    const v = await import('/src/lib/vault.ts'); const session = await v.unlockVault();
    const events = await v.loadMessageEventHistory(session);
    return { lastSeq: session.vault.lastSeq, gaps: session.vault.expiredMessageRanges.length, deletion: events.some(m => m.payload.kind === 'message-delete') };
  });
  assert.equal(durable.lastSeq, 90); assert.ok(durable.gaps > 0); assert.equal(durable.deletion, true);
  console.log('PASS two real browser vaults: full-window writes, automatic rekey/retry, offline gap and deletion catch-up, atomic reload');
} finally { await browser?.close(); await server.close(); await backend.close(); await rm(dataDir, { recursive: true, force: true }); }
