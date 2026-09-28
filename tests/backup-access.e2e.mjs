import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-backup-access-'));
let service, vite, browser;
try {
  service = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': `http://127.0.0.1:${service.port}` } },
    plugins: [{ name: 'backup-access-fixture', configureServer(server) {
      server.middlewares.use('/__backup-access', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div id="app"></div>'); });
    } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
  const url = `http://localhost:${vite.httpServer.address().port}/__backup-access`;
  await page.goto(url);
  const fixture = await page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts'), b = await import('/src/lib/cloud-backup.ts'), local = await import('/src/lib/local-history-backup.ts');
    const c = await import('/src/lib/backup-crypto.ts'), spaces = await import('/src/lib/spaces.ts');
    const identity = await (await import('/src/lib/crypto.ts')).generateIdentity(), token = c.randomBackupSecret();
    const room = await (await import('/src/lib/api.ts')).createRoom(identity.publicBundle, token);
    const source = await v.createVault({ v: 3, roomId: room.roomId, role: 'creator', identity, accessToken: token, pairingSecret: '', creatorFingerprint: 'fixture',
      members: [{ ...identity.publicBundle, role: 'creator', status: 'active', joinProof: null }], lastSeq: 1, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420', mls: { protocol: 'mls-rfc9420', phase: 'awaiting-peer' } });
    await v.saveHistoryMessage(source, { seq: 1, clientMsgId: crypto.randomUUID(), senderId: identity.publicBundle.deviceId, acceptedAt: new Date().toISOString(), status: 'stored', payload: { v: 1, kind: 'text', text: 'synthetic cross-device history', sentAt: new Date().toISOString() } });
    await b.syncCloudBackup(source, new AbortController().signal);
    const chunks = [];
    await local.exportLocalHistory(source, { write: async bytes => { chunks.push(bytes.slice()); } }, new AbortController().signal);
    await b.cloudBackupPreference(source, new AbortController().signal, true);
    await b.syncCloudBackup(source, new AbortController().signal);
    await spaces.syncSpaceDirectory(source, new AbortController().signal);
    return { roomId: room.roomId, code: source.vault.spaceRecoveryCode, sourceBundle: identity.publicBundle, bytes: [...new Uint8Array(await new Blob(chunks).arrayBuffer())] };
  });
  // Independent browser storage and independently generated target identity.
  const targetPage = await browser.newPage();
  await targetPage.goto(url);
  const result = await targetPage.evaluate(async fixture => {
    const v = await import('/src/lib/vault.ts'), b = await import('/src/lib/cloud-backup.ts'), local = await import('/src/lib/local-history-backup.ts');
    const c = await import('/src/lib/backup-crypto.ts');
    const identity = await (await import('/src/lib/crypto.ts')).generateIdentity();
    const target = await v.createVault({ v: 1, roomId: fixture.roomId, role: 'creator', identity, accessToken: 'synthetic-target', pairingSecret: '', creatorFingerprint: 'fixture',
      members: [{ ...fixture.sourceBundle, role: 'creator', status: 'active', joinProof: null }, { ...identity.publicBundle, role: 'creator', status: 'active', joinProof: null }], lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'legacy-v1',
      backup: { v: 1, ...c.newRecoveryCode(), cursor: 0, revision: 1, syncedAt: new Date().toISOString(), archives: [{ id: c.randomBackupSecret(), key: c.randomBackupSecret(), token: c.randomBackupSecret(), parts: [] }] } }, 'synthetic-target-password', 'password');
    const beforeIdentity = JSON.stringify(target.vault.identity), beforeArchives = JSON.stringify(target.vault.backup.archives);
    const file = new Blob([new Uint8Array(fixture.bytes)]), signal = new AbortController().signal;
    let ungranted = false;
    try { await local.previewLocalHistoryBackup(target, file, signal); } catch { ungranted = true; }
    const access = await local.authorizeLocalHistoryBackup(target, file, fixture.code, signal);
    const preview = await local.previewLocalHistoryBackup(target, file, signal, access);
    const imported = await local.importLocalHistory(target, file, signal, undefined, access);
    const cloud = await b.restoreUnifiedHistory(target, fixture.code, signal, () => {});
    target.vault.role = 'joiner';
    let wrongParticipant = false;
    try { await local.authorizeLocalHistoryBackup(target, file, fixture.code, signal); } catch { wrongParticipant = true; }
    return { ungranted, wrongParticipant, preview: preview.messages, imported: imported.imported, cloudNew: cloud.chat.restored,
      sameIdentity: beforeIdentity === JSON.stringify(target.vault.identity), ownArchivesUnchanged: beforeArchives === JSON.stringify(target.vault.backup.archives), cursor: target.vault.lastSeq };
  }, fixture);
  assert.deepEqual(result, { ungranted: true, wrongParticipant: true, preview: 1, imported: 1, cloudNew: 0, sameIdentity: true, ownArchivesUnchanged: true, cursor: 0 });
  console.log('Cross-device backup access passed: explicit QR4 authorization, QRL1 compatibility, participant boundary, dedup, unchanged identity and writable archives.');
} finally { await browser?.close(); await vite?.close(); await service?.close(); await rm(dataDir, { recursive: true, force: true }); }
