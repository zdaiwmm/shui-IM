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
  page = await browser.newPage();
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
      try { await app.reencryptOutboxItem(item.clientMsgId); } catch { rejected = true; }
      Object.defineProperty(crypto.subtle, 'encrypt', { configurable: true, value: encrypt });
      const result = { failed, rejected, sameItem: app.outbox.get(item.clientMsgId) === item, sameEnvelope: JSON.stringify(item.envelope) === beforeEnvelope, sameGroup: session.vault.mls.groupState === beforeGroup, sameStored: JSON.stringify(await readStoredVault()) === beforeStored };
      app.lockNow(); root.remove();
      return result;
    });
    expect(result).toEqual({ failed: true, rejected: true, sameItem: true, sameEnvelope: true, sameGroup: true, sameStored: true });
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
    expect(result).toEqual({ waited: true, readCommittedSeq: 41, staleRejected: true, crossRoomRejected: true, retained: true });
  }, 30_000);
});

try {
  await setup();
  for (const test of cases) { await test.run(); console.log(`PASS ${test.name}`); }
} finally { await teardown(); }
