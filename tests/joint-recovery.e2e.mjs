import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-joint-browser-'));
let service, vite, browser;
try {
  service = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: {
    host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': `http://127.0.0.1:${service.port}` } }, plugins: [{ name: 'joint-fixture', configureServer(server) {
      server.middlewares.use('/__joint', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>'); });
    } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await context.newPage(); pages.push(page);
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
    await page.goto(`http://localhost:${vite.httpServer.address().port}/__joint`);
    await page.evaluate(async () => { window.v = await import('/src/lib/vault.ts'); window.m = await import('/src/lib/mls.ts'); window.j = await import('/src/lib/joint-recovery.ts'); window.b = await import('/src/lib/cloud-backup.ts'); window.api = await import('/src/lib/api.ts'); window.c = await import('/src/lib/crypto.ts'); window.signal = new AbortController().signal; });
  }
  const [a, b] = pages;
  const peer = await a.evaluate(async () => {
    const [ai, bi] = await Promise.all([c.generateIdentity(), c.generateIdentity()]);
    const { randomBase64Url } = await import('/src/lib/base64.ts');
    const at = randomBase64Url(32), bt = randomBase64Url(32), invite = randomBase64Url(32), pairingSecret = randomBase64Url(32);
    const room = await api.createRoom(ai.publicBundle, at, invite, 'A', ['joint-recovery-v1']);
    const state = await api.joinRoom(room.roomId, invite, bi.publicBundle, await c.createJoinProof(pairingSecret, bi.publicBundle), bt, 'B', ['joint-recovery-v1']);
    const common = { v: 3, roomId: room.roomId, pairingSecret: '', creatorFingerprint: await c.bundleFingerprint(ai.publicBundle), members: state.members, lastSeq: 0, lastReceiptSeq: 0, createdAt: room.createdAt, protocol: 'mls-rfc9420', pairingState: 'ready' };
    const av = { ...common, role: 'creator', identity: ai, accessToken: at, mls: await m.createCreatorMlsState(room.roomId, ai, state.members) };
    av.mls = await m.prepareCreatorWelcome(av);
    const bv = { ...common, role: 'joiner', identity: bi, accessToken: bt }; bv.mls = await m.joinMlsGroup(bv, av.mls.pendingWelcome);
    await api.publishMlsWelcome(room.roomId, at, av.mls.pendingWelcome); delete av.mls.pendingWelcome;
    av.mls.lastEventSeq = bv.mls.lastEventSeq = 0;
    window.session = await v.createVault(av); return bv;
  });
  await b.evaluate(async peer => { window.session = await v.createVault(peer); }, peer);
  const sendOld = async text => {
    const envelope = await a.evaluate(async text => {
      const target = window.old ?? session.vault;
      const result = await m.encryptMlsApplication(target, { v: 1, kind: 'text', text, sentAt: new Date().toISOString() }, crypto.randomUUID()); target.mls.groupState = result.nextGroupState; return result.envelope;
    }, text);
    return service.store.insertMessage(peer.roomId, envelope);
  };
  const initial = await sendOld('before recovery');
  await a.evaluate(async message => {
    session.vault.lastSeq = message.seq;
    await v.saveHistoryMessage(session, { seq: message.seq, clientMsgId: message.envelope.clientMsgId, senderId: message.envelope.senderId, payload: { v: 1, kind: 'text', text: 'before recovery', sentAt: '2026-09-16T00:00:00.000Z' }, acceptedAt: message.acceptedAt, status: 'stored' }); await v.saveVault(session);
  }, initial);
  await b.evaluate(async message => {
    const opened = await m.decryptMlsApplication(session.vault, message.envelope); session.vault.mls.groupState = opened.nextGroupState; session.vault.lastSeq = message.seq;
    await v.saveHistoryMessage(session, { seq: message.seq, clientMsgId: message.envelope.clientMsgId, senderId: message.envelope.senderId, payload: opened.payload, acceptedAt: message.acceptedAt, status: 'delivered' });
    await v.saveUiPreferences(session, { composerDraft: 'helper draft', hiddenChatMessageIds: [message.envelope.clientMsgId] }); await v.saveVault(session);
  }, initial);
  for (const page of pages) await page.evaluate(async () => { await b.syncCloudBackup(session, signal); window.sp = await import('/src/lib/spaces.ts'); await sp.syncSpaceDirectory(session, signal); window.masterCode = session.vault.spaceRecoveryCode; window.oldCode = session.vault.backup.code; const bundle = await b.fetchRecoveryBundle(masterCode, signal, undefined, session.vault.roomId); if (bundle.checkpoint.spaceRecoveryCode) throw new Error('Collection capability leaked into a room checkpoint'); });
  const unnecessary = await a.evaluate(async () => {
    const originalId = session.vault.identity.publicBundle.deviceId;
    window.session = await j.prepareJointRecovery(oldCode, 'auto', null, session, undefined, 'usable A', ['joint-recovery-v1'], signal);
    await j.advanceJointRecovery(session, signal);
    return { link: session.vault.pendingJointRecovery.link, originalId };
  });
  await b.evaluate(async link => {
    const before = JSON.stringify(await v.readStoredVault());
    let rejected = false;
    try { await j.prepareJointRecovery(oldCode, 'auto', link, session, undefined, 'usable B', ['joint-recovery-v1'], signal); }
    catch (cause) { rejected = cause.message.includes('均可正常使用'); }
    if (!rejected || before !== JSON.stringify(await v.readStoredVault())) throw new Error('Two usable endpoints changed their vaults');
  }, unnecessary.link);
  await a.evaluate(async originalId => {
    const result = await j.cancelJointRecovery(session, signal);
    if (result !== 'helper' || session.vault.identity.publicBundle.deviceId !== originalId || session.vault.pendingJointRecovery) throw new Error('Cancelling helper staging changed its identity');
  }, unnecessary.originalId);
  const link = await a.evaluate(async () => {
    const history = await import('/src/lib/local-history-backup.ts'); const chunks = [];
    await history.exportLocalHistory(session, { write: async bytes => chunks.push(bytes.slice()) }, signal); window.localFile = new Blob(chunks);
    window.old = structuredClone(session.vault);
    const { derivePasswordCredential } = await import('/src/lib/password-protection.ts'); const credential = await derivePasswordCredential('joint-new-password');
    window.session = await j.prepareJointRecovery(oldCode, 'auto', null, null, credential, 'new A', ['joint-recovery-v1'], signal, masterCode); await sp.rememberLocalSpace(session, masterCode);
    await j.advanceJointRecovery(session, signal); return session.vault.pendingJointRecovery.link;
  });
  await b.evaluate(async link => { window.session = await j.prepareJointRecovery(oldCode, 'auto', link, session, undefined, 'new B', ['joint-recovery-v1'], signal); await j.advanceJointRecovery(session, signal); }, link);
  // The helper must retain messages arriving while the restoration screen owns the UI.
  await sendOld('during recovery');
  await a.evaluate(async () => { window.snapshot = await j.advanceJointRecovery(session, signal); });
  await b.evaluate(async () => { window.snapshot = await j.advanceJointRecovery(session, signal); });
  await a.evaluate(async () => {
    await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
    const { QuietRoomApp } = await import('/src/app.ts');
    window.progressApp = new QuietRoomApp(document.querySelector('#app'));
    progressApp.session = session; progressApp.privacyCovered = false; progressApp.runtimeAbort = new AbortController();
    progressApp.renderJointProgress();
  });
  assert.equal(await a.locator('#joint-progress h1').textContent(), '确认找回结果');
  assert.match(await a.locator('#joint-progress .recovery-flow-lead').textContent() ?? '', /核对双方页面的编号与结果/);
  assert.equal(await a.locator('.joint-request-code').count(), 1);
  assert.equal(await a.locator('#joint-scope-summary').count(), 1);
  assert.match(await a.locator('#joint-scope').textContent(), /空间恢复码保持不变/);
  assert.doesNotMatch(await a.locator('#joint-scope').textContent(), /保存新恢复码/);
  assert.equal(await a.evaluate(() => session.vault.recoveryExperience.jointMaterial), 'retained');
  assert.equal(await a.locator('#joint-participant-badge').count(), 1);
  assert.equal(await a.locator('#joint-retire, #joint-retry').count(), 0);
  assert.equal(await a.locator('#joint-qr').evaluate(canvas => canvas.getAttribute('width')), '248');
  await a.setViewportSize({ width: 390, height: 844 });
  await a.getByRole('button', { name: '确认并找回空间', exact: true }).waitFor();
  if (process.argv[2]) { await mkdir(process.argv[2], { recursive: true }); await a.screenshot({ path: path.join(process.argv[2], 'F01-auto-recovery-390.png'), animations: 'disabled' }); }
  assert.equal(await a.locator('#joint-qr').isVisible(), false, 'Invitation is secondary to the verified result');
  assert.equal(await a.locator('.recovery-steps [aria-current=step]').textContent(), '2共同确认');
  await a.locator('.joint-invite-details summary').click();
  const waitingLayout = await a.evaluate(() => {
    const qr = document.querySelector('#joint-qr')?.getBoundingClientRect();
    const summary = document.querySelector('#joint-scope-summary');
    return {
      qrWidth: qr ? Math.round(qr.width) : 0,
      qrHeight: qr ? Math.round(qr.height) : 0,
      scopeText: summary?.textContent ?? '',
      startButton: [...document.querySelectorAll('button')].some(button => (button.textContent ?? '').includes('开始恢复')),
    };
  });
  assert.ok(waitingLayout.qrWidth >= 160 && waitingLayout.qrHeight >= 160, JSON.stringify(waitingLayout));
  assert.ok((waitingLayout.scopeText ?? '').length > 0, JSON.stringify(waitingLayout));
  assert.equal(waitingLayout.startButton, false);
  await a.evaluate(() => progressApp.runtimeAbort.abort());
  // Both local states and fresh identities survive an actual unlock before confirmation.
  for (const page of pages) await page.evaluate(async () => { window.session = await v.unlockVault((await v.readStoredVault())?.unlockMethod === 'password' ? 'joint-new-password' : ''); window.snapshot = await j.advanceJointRecovery(session, signal); });
  await a.evaluate(async () => { window.snapshot = await j.approveJointRecovery(session, snapshot, signal); if (snapshot.result) throw new Error('Single signature committed'); });
  await b.evaluate(async () => { window.snapshot = await j.approveJointRecovery(session, snapshot, signal); await j.completeJointRecovery(session, snapshot, signal); });
  await a.evaluate(async () => { window.snapshot = await j.advanceJointRecovery(session, signal); await j.completeJointRecovery(session, snapshot, signal); });
  assert.equal(await a.evaluate(async () => (await v.loadHistory(session)).length), 0);
  const helper = await b.evaluate(async () => ({ history: (await v.loadHistory(session)).map(x => x.payload.text), preferences: await v.loadUiPreferences(session) }));
  assert.deepEqual(helper.history, ['before recovery', 'during recovery']); assert.equal(helper.preferences.composerDraft, 'helper draft'); assert.deepEqual(helper.preferences.hiddenChatMessageIds, [initial.envelope.clientMsgId]);
  for (const page of pages) await page.evaluate(async () => {
    await b.syncCloudBackup(session, signal); if (session.vault.recoverySource || session.vault.backup.code === oldCode) throw new Error('Code rotation not finished');
    let rejected = false; try { await b.fetchRecoveryBundle(oldCode, signal); } catch { rejected = true; } if (!rejected) throw new Error('Old online fetch was not revoked'); await sp.syncSpaceDirectory(session, signal); if (session.vault.spaceRecoveryCode !== masterCode) throw new Error('Shared recovery code changed'); const bundle = await b.fetchRecoveryBundle(masterCode, signal, undefined, session.vault.roomId); if (bundle.deviceId !== session.vault.identity.publicBundle.deviceId) throw new Error('Shared code points to a retired identity');
  });
  assert.equal(await a.evaluate(async () => (await (await import('/src/lib/local-history-backup.ts')).importLocalHistory(session, localFile, signal)).imported), 1);
  const next = await a.evaluate(async () => (await m.encryptMlsApplication(session.vault, { v: 1, kind: 'text', text: 'fresh group', sentAt: new Date().toISOString() }, crypto.randomUUID())).envelope);
  assert.equal(await b.evaluate(async envelope => (await m.decryptMlsApplication(session.vault, envelope)).payload.text, next), 'fresh group');
  // Verify the actual application accepts the authenticated post-reset server roster.
  await a.evaluate(async () => {
    await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles(); const { QuietRoomApp } = await import('/src/app.ts'); window.app = new QuietRoomApp(document.querySelector('#app'));
    app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController();
    const state = await api.getRoomState(session.vault.roomId, session.vault.accessToken);
    await v.withVaultMutation(session, mutation => app.applyRoomState(state, mutation));
    app.renderRecoveryCenter();
  });
  for (const width of [375, 390]) {
    await a.setViewportSize({ width, height: 844 });
    const layout = await a.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, small: [...document.querySelectorAll('button')].some(x => x.getBoundingClientRect().height < 44) }));
    assert.equal(layout.overflow, false); assert.equal(layout.small, false);
  }
  if (process.argv[2]) await a.screenshot({ path: path.join(process.argv[2], 'F07-recovery-center-390.png'), animations: 'disabled' });
  assert.equal(await a.locator('#open-local-history, #import-history-from-hub').count(), 0);
  assert.equal(await a.locator('#save-my-code').count(), 1);
  assert.equal(await a.locator('.recovery-flow-list li').count(), 4);
  assert.equal(await a.locator('#save-my-code').textContent(), '查看我的恢复码');
  assert.equal(await a.locator('.recovery-status-badge').count(), 0);
  await a.locator('#recovery-center-back').click();
  await a.evaluate(() => app.lockNow()); assert.equal(await a.locator('#recovery-center-back').count(), 0);
  console.log('Joint recovery browser: dual signatures, helper catch-up, atomic history preservation, code rotation, own local import, resumed original protections and 375/390 UI passed.');
} finally { await browser?.close(); await vite?.close(); await service?.close(); await rm(dataDir, { recursive: true, force: true }); }
