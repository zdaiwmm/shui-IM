import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'vault-resume-fixture', configureServer(vite) {
    // Serve the isolated fixture before the SPA fallback can boot a second app.
    vite.middlewares.use('/__vault_resume', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Vault resume regression</title>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true,
  } });
  await page.goto(`http://localhost:${server.httpServer.address().port}/__vault_resume`);
  const results = await page.evaluate(async () => {
    const vault = await import('/src/lib/vault.ts');
    const fixture = () => ({
      v: 1, roomId: crypto.randomUUID(), accessToken: 'resume-test', role: 'creator', protocol: 'legacy-v1',
      lastSeq: 0, members: [{ deviceId: 'resume-own', role: 'creator', status: 'active' }],
      identity: { publicBundle: { deviceId: 'resume-own' } },
    });
    const rejected = async operation => {
      try { await operation(); return false; } catch { return true; }
    };
    const session = await vault.createVault(fixture());
    const storedBefore = JSON.stringify(await vault.readStoredVault());
    let credentialRequests = 0;
    const credentialGet = navigator.credentials.get;
    Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: () => {
      credentialRequests++;
      throw new Error('A retained key must not request device verification');
    } });
    try {
      // An interrupted mutation can leave plaintext dirty without changing
      // the authenticated record. Resume must rebuild from that record.
      session.vault.lastSeq = 999;
      session.vault.members = [];
      session.vault.mls = { groupState: 'uncommitted-ratchet' };
      const resumed = await vault.resumeVaultSession(session);
      const dirtyState = {
        freshObject: resumed !== session && resumed.vault !== session.vault,
        sameKey: resumed.key === session.key,
        sequence: resumed.vault.lastSeq,
        members: resumed.vault.members.length,
        noUncommittedRatchet: resumed.vault.mls === undefined,
        storageUnchanged: JSON.stringify(await vault.readStoredVault()) === storedBefore,
      };
      const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const authenticated = await rejected(() => vault.resumeVaultSession({ ...resumed, key: wrongKey }));

      let release; let started;
      const startedPromise = new Promise(resolve => { started = resolve; });
      const events = [];
      const mutation = vault.withVaultMutation(resumed, async lease => {
        events.push('mutation-start');
        started();
        await new Promise(resolve => { release = resolve; });
        resumed.vault.lastSeq = 7;
        await vault.saveVault(resumed, lease);
        events.push('mutation-committed');
      });
      await startedPromise;
      let returnedEarly = false;
      const resume = vault.resumeVaultSession(resumed).then(value => {
        returnedEarly = true;
        events.push('resume-completed');
        return value;
      });
      await new Promise(resolve => setTimeout(resolve, 30));
      const waited = !returnedEarly;
      release();
      await mutation;
      const committed = await resume;
      const serialization = { waited, sequence: committed.vault.lastSeq, events };

      // A second retained object models another tab committing a newer vault.
      const other = await vault.resumeVaultSession(committed);
      await vault.withVaultMutation(other, async lease => {
        other.vault.lastSeq = 8;
        await vault.saveVault(other, lease);
      });
      const newerRecord = JSON.stringify(await vault.readStoredVault());
      const changedRejected = await rejected(() => vault.resumeVaultSession(committed));
      const changedRecordPreserved = JSON.stringify(await vault.readStoredVault()) === newerRecord;
      await vault.deleteCurrentVault();
      const deletedRejected = await rejected(() => vault.resumeVaultSession(other));

      const legacy = await vault.createVault(fixture(), 'resume-legacy-passphrase', 'password');
      legacy.vault.lastSeq = 123;
      const legacyResume = await vault.resumeVaultSession(legacy);
      return {
        dirtyState, authenticated, serialization, changedRejected, changedRecordPreserved, deletedRejected,
        legacy: { sequence: legacyResume.vault.lastSeq, sameKey: legacyResume.key === legacy.key, freshObject: legacyResume.vault !== legacy.vault },
        credentialRequests,
      };
    } finally {
      Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: credentialGet });
    }
  });
  assert.deepEqual(results, {
    dirtyState: { freshObject: true, sameKey: true, sequence: 0, members: 1, noUncommittedRatchet: true, storageUnchanged: true },
    authenticated: true,
    serialization: { waited: true, sequence: 7, events: ['mutation-start', 'mutation-committed', 'resume-completed'] },
    changedRejected: true, changedRecordPreserved: true, deletedRejected: true,
    legacy: { sequence: 0, sameKey: true, freshObject: true },
    credentialRequests: 0,
  });
  console.log('Vault resume E2E passed: authenticated durable reload, dirty-state isolation, unchanged storage, mutation serialization, stale/deleted rejection, legacy compatibility, and no repeated device verification.');
} finally {
  await browser?.close();
  await server.close();
}
