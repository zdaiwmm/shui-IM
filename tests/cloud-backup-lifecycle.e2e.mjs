import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-cloud-lifecycle-'));
let service, vite, browser;
try {
  service = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': `http://127.0.0.1:${service.port}` } },
    plugins: [{ name: 'cloud-test-fixture', configureServer(server) {
      server.middlewares.use('/__cloud', (_request, response) => {
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Cloud backup regression</title><div id="app"></div>');
      });
    } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
  await page.goto(`http://localhost:${vite.httpServer.address().port}/__cloud`);
  const first = await page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    const b = await import('/src/lib/cloud-backup.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { createRoom } = await import('/src/lib/api.ts');
    const { randomBackupSecret } = await import('/src/lib/backup-crypto.ts');
    const identity = await generateIdentity(); const token = randomBackupSecret();
    const room = await createRoom(identity.publicBundle, token);
    const session = await v.createVault({ v: 3, roomId: room.roomId, role: 'creator', accessToken: token, pairingSecret: '', creatorFingerprint: 'fixture',
      identity, members: [{ ...identity.publicBundle, role: 'creator', status: 'active', joinProof: null }], lastSeq: 2,
      createdAt: new Date().toISOString(), protocol: 'mls-rfc9420', mls: { protocol: 'mls-rfc9420', phase: 'awaiting-peer' } });
    for (let seq = 1; seq <= 2; seq++) await v.saveHistoryMessage(session, { seq, clientMsgId: crypto.randomUUID(), senderId: identity.publicBundle.deviceId,
      payload: { v: 1, kind: 'text', text: `private-history-${seq}`, sentAt: new Date().toISOString() }, acceptedAt: new Date().toISOString(), status: 'stored' });
    await b.syncCloudBackup(session, new AbortController().signal);
    const code = session.vault.backup.code;
    const before = session.vault.backup.revision;
    const original = fetch;
    let committedThenLost = false;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!committedThenLost && String(args[0]).endsWith('/backup') && args[1]?.method === 'PUT' && response.ok) {
        committedThenLost = true;
        throw new TypeError('Synthetic response lost after commit');
      }
      return response;
    };
    let rejected = false;
    try { await b.syncCloudBackup(session, new AbortController().signal); } catch { rejected = true; }
    window.fetch = original;
    const reopened = await v.unlockVault();
    const pending = JSON.stringify(reopened.vault.backup.pending);
    let identicalRetry = false;
    window.fetch = (...args) => {
      if (String(args[0]).endsWith('/backup') && args[1]?.method === 'PUT') identicalRetry = args[1].body === pending;
      return original(...args);
    };
    await b.syncCloudBackup(reopened, new AbortController().signal);
    window.fetch = original;
    const stableCode = reopened.vault.backup.code === code;
    const bundle = await b.fetchRecoveryBundle(code, new AbortController().signal);
    const noCodeInPayload = !JSON.stringify(bundle).includes(code) && !bundle.checkpoint.backup;
    const record = JSON.stringify(await v.readStoredVault());
    const persistedCiphertext = !record.includes(code) && !record.includes('private-history-');
    const controller = new AbortController(); controller.abort();
    const prior = JSON.stringify(await v.readStoredVault());
    try { await b.syncCloudBackup(reopened, controller.signal); } catch { /* expected */ }
    const abortUnchanged = prior === JSON.stringify(await v.readStoredVault());
    // Abort after local crypto finishes, before installing any durable checkpoint.
    const interrupted = new AbortController();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async (...args) => {
      const result = await encrypt(...args); interrupted.abort(); return result;
    };
    let interruptedRejected = false;
    try { await b.recoverFromCloud(code, interrupted.signal); } catch { interruptedRejected = true; }
    crypto.subtle.encrypt = encrypt;
    const lateAbortUnchanged = interruptedRejected && prior === JSON.stringify(await v.readStoredVault());
    let staleRejected = false;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).startsWith('/api/recovery-backups/')) await v.deleteCurrentVault();
      return response;
    };
    try { await b.recoverFromCloud(code, new AbortController().signal); } catch { staleRejected = true; }
    window.fetch = original;
    const lateFetchUnchanged = staleRejected && await v.readStoredVault() === null;
    // Restore the synthetic original fixture before the normal replacement path.
    await v.createVault(reopened.vault);
    const recovered = await b.recoverFromCloud(code, new AbortController().signal);
    const noAutomaticHistory = recovered.vault.recoverySource.archives.length > 0 && !recovered.vault.mls.groupState;
    const resume = await v.unlockRecoveryVault(code);
    const pendingResumes = resume.vault.roomId === room.roomId;
    // Keep this synthetic original device for the local reauthentication UI check.
    await v.createVault(reopened.vault);
    return { rejected, committedThenLost, identicalRetry, stableCode, noCodeInPayload, persistedCiphertext, abortUnchanged,
      noAutomaticHistory, pendingResumes, lateAbortUnchanged, lateFetchUnchanged, revisionAdvanced: reopened.vault.backup.revision > before };
  });
  assert.deepEqual(first, { rejected: true, committedThenLost: true, identicalRetry: true, stableCode: true, noCodeInPayload: true,
    persistedCiphertext: true, abortUnchanged: true, noAutomaticHistory: true, pendingResumes: true, lateAbortUnchanged: true, lateFetchUnchanged: true, revisionAdvanced: true });
  await page.evaluate(async () => {
    const { QuietRoomApp } = await import('/src/app.ts'); const v = await import('/src/lib/vault.ts');
    const app = new QuietRoomApp(document.querySelector('#app')); await app.start();
    app.session = await v.unlockVault(); app.privacyCovered = false; app.runtimeAbort = new AbortController(); app.resetIdleLock();
    app.renderPendingRecovery(new TypeError('Synthetic lost response'));
    const restart = document.querySelector('#restart-recovery');
    if (!restart.disabled) throw new Error('Uncertain recovery must not discard replacement identity');
    const before = JSON.stringify(await v.readStoredVault());
    restart.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (JSON.stringify(await v.readStoredVault()) !== before) throw new Error('Uncertain recovery deleted its checkpoint');
    clearTimeout(app.recoveryPollTimer); app.recoveryPollTimer = null;
    app.renderBackupSettings(); window.fixtureApp = app;
    window.originalCredentialGet = navigator.credentials.get.bind(navigator.credentials);
    Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: () => Promise.reject(new DOMException('Cancelled', 'NotAllowedError')) });
  });
  await page.locator('#view-local-recovery').click();
  await page.locator('#verify-recovery-passkey').click();
  await page.getByText('未完成设备安全验证', { exact: true }).waitFor();
  assert.equal(await page.locator('.local-recovery-code').count(), 0);
  await page.evaluate(() => Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: window.originalCredentialGet }));
  await page.locator('#verify-recovery-passkey').click();
  await page.locator('.local-recovery-code').waitFor();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.locator('.local-recovery-code').count(), 0);
  assert.equal(await page.evaluate(() => window.fixtureApp.session === null && window.fixtureApp.retainedSession === null), true);
  console.log('Cloud backup lifecycle passed: durable lost-response retry, stable code, no secret persistence/upload, abort fencing, pending-recovery resume and fresh-passkey reveal cleanup.');
} finally {
  await browser?.close(); await vite?.close(); await service?.close(); await rm(dataDir, { recursive: true, force: true });
}
