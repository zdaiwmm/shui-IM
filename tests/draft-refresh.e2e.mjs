import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

// Actual application, server, MLS and encrypted vaults. Each engine has two
// independent participant contexts; only the deliberate stale-tab case shares one.
const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-draft-refresh-'));
const root = process.cwd(); let service, vite, browser, database;
const password = 'synthetic draft regression password';
async function waitForState(page, stage, predicate) {
  // Storage/network completion must not depend on WebKit scheduling a paint
  // for another participant's page. Keep the page's existing 15s deadline.
  try { await page.waitForFunction(predicate, undefined, { polling: 100 }); }
  catch (error) {
    // Only state flags: never include messages, invitations or vault contents.
    console.error('DRAFT_REGRESSION_STATE', stage, await page.evaluate(() => ({
      visibility: document.visibilityState, focused: document.hasFocus(),
      covered: app.privacyCovered, surface: app.activeSurface,
      session: Boolean(app.session), mls: app.session?.vault.mls?.phase,
      connection: app.connectionState, accessFailure: Boolean(app.accessFailure),
      inputPresent: Boolean(document.querySelector('#message-input')),
      inputDisabled: document.querySelector('#message-input')?.disabled,
      sending: app.sendingTextDrafts.size, fault: Boolean(window.draftFault?.injected),
      welcome: Boolean(document.querySelector('#welcome-chat')),
      overlays: document.querySelectorAll('.confirm-overlay').length,
    })).catch(() => ({ unavailable: true })));
    throw error;
  }
}
async function protect(page) {
  const form = page.locator('.password-form'); await form.waitFor();
  await form.locator('[name=password]').fill(password);
  if (await form.locator('[name=confirmation]').count()) await form.locator('[name=confirmation]').fill(password);
  await form.locator('[type=submit]').click();
}
async function ready(page) {
  await page.locator('.chat-shell').waitFor();
  // MLS may become active before the pairing render/welcome is installed.
  // Observe that transition instead of guessing a 1.5s welcome window.
  await waitForState(page, 'chat-ready', () => {
    const input = document.querySelector('#message-input');
    return window.app?.session?.vault.mls?.phase === 'active' && input && !input.disabled
      && app.session.vault.recoveryExperience?.welcomePending !== true;
  });
  if (await page.locator('#welcome-chat').count()) await page.locator('#welcome-chat').click();
  await page.locator('.confirm-overlay').waitFor({ state: 'detached' });
}
async function unlock(page) {
  await page.locator('.password-form,.cover-trigger').first().waitFor();
  if (await page.locator('.cover-trigger').count()) {
    const box = await page.locator('.cover-trigger').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.locator('.password-form').waitFor(); await page.mouse.up();
  }
  await protect(page); await ready(page);
}
async function reload(page) { await page.reload(); await unlock(page); }
async function receive(page, text) { await page.locator('.message-text').filter({ hasText: text }).waitFor(); }
async function barrier(page) {
  await page.evaluate(() => {
    const original = app.attemptSend.bind(app);
    app.attemptSend = id => new Promise(resolve => {
      window.durableSend = id;
      window.releaseSend = async () => { app.attemptSend = original; await original(id); resolve(); };
    });
  });
}
try {
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir, quiet: true });
  vite = await createServer({ configFile: false, root, logLevel: 'error', plugins: [{
    name: 'draft-regression-observation', enforce: 'pre', transform(code, id) {
      if (id === path.join(root, 'src/main.ts')) return code.replace('void app.start();', 'window.app = app; void app.start();');
    },
  }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
    '/api': `http://127.0.0.1:${service.port}`, '/ws': { target: `ws://127.0.0.1:${service.port}`, ws: true },
  } } });
  await vite.listen(); const url = `http://localhost:${vite.httpServer.address().port}/`;
  database = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'), { readOnly: true });
  for (const engine of process.env.QUIET_ROOM_TEST_BROWSER ? [process.env.QUIET_ROOM_TEST_BROWSER] : ['chromium', 'webkit']) {
    browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
    const options = { viewport: { width: 390, height: 844 }, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.65' };
    const [ac, bc] = await Promise.all([browser.newContext(options), browser.newContext(options)]);
    await ac.addInitScript(() => { delete window.PublicKeyCredential; }); await bc.addInitScript(() => { delete window.PublicKeyCredential; });
    const [a, b] = await Promise.all([ac.newPage(), bc.newPage()]); a.setDefaultTimeout(15000); b.setDefaultTimeout(15000);
    // A durable state change can finish while animation frames are paused.
    // Navigation below restores the real frame scheduler before app startup.
    await a.evaluate(() => {
      window.requestAnimationFrame = () => 0;
      window.draftStateProbe = false;
      window.draftStateProbeObserved = false;
    });
    const probe = waitForState(a, 'state-without-animation-frame', () => {
      window.draftStateProbeObserved = true;
      return window.draftStateProbe;
    });
    await a.waitForFunction(() => window.draftStateProbeObserved, undefined, { polling: 100 });
    await a.evaluate(() => { window.draftStateProbe = true; });
    await probe;
    await a.goto(url); await a.locator('#create-room').click(); await protect(a);
    await a.locator('#invite-url').waitFor(); await b.goto(await a.locator('#invite-url').inputValue());
    await b.locator('[data-device-verify]').click(); await protect(b); await ready(a); await ready(b);

    // No wait for preferences, debounce, key derivation or IDB after input.
    for (const text of ['first immediate draft', 'replacement\n第二行', '', '输入法当前文字']) {
      await a.locator('#message-input').fill(text); await reload(a);
      assert.equal(await a.locator('#message-input').inputValue(), text, `${engine}: immediate refresh must restore the latest value`);
    }
    await a.evaluate(() => {
      const input = document.querySelector('#message-input'); input.dispatchEvent(new CompositionEvent('compositionstart'));
      input.value = '中文输入中'; input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true, data: '中文输入中' }));
    });
    await reload(a); assert.equal(await a.locator('#message-input').inputValue(), '中文输入中');
    await a.locator('#message-input').fill('survives closing this tab'); await a.close();
    const reopened = await ac.newPage(); reopened.setDefaultTimeout(15000); await reopened.goto(url); await unlock(reopened);
    assert.equal(await reopened.locator('#message-input').inputValue(), 'survives closing this tab');

    // Force a real IDB abort at the outbox+draft-marker transaction, before its
    // commit. The server must receive no message and the text must survive.
    await reopened.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(stores, ...args) {
        const tx = original.call(this, stores, ...args);
        if (Array.isArray(stores) && stores.includes('outbox') && stores.includes('preferences')) {
          IDBDatabase.prototype.transaction = original;
          window.draftFault = { stage: 'outbox-before-commit', injected: true };
          queueMicrotask(() => tx.abort());
        }
        return tx;
      };
    });
    await reopened.locator('#message-input').fill('failed transaction draft'); await reopened.locator('#send-text').click();
    await waitForState(reopened, 'outbox-abort', () => window.draftFault?.injected && app.sendingTextDrafts.size === 0);
    assert.equal(await reopened.evaluate(async () => (await (await import('/src/lib/vault.ts')).loadOutbox(app.session)).length), 0);
    await reload(reopened); assert.equal(await reopened.locator('#message-input').inputValue(), 'failed transaction draft');

    // Stop AFTER durable commit, before the submit handler can clear the input.
    await barrier(reopened); await reopened.locator('#message-input').fill('committed before refresh'); await reopened.locator('#send-text').click();
    await waitForState(reopened, 'durable-send', () => window.durableSend && app.outbox.has(window.durableSend));
    const sentId = await reopened.evaluate(() => window.durableSend);
    assert.equal(await reopened.locator('#message-input').inputValue(), 'committed before refresh');
    await reload(reopened); assert.equal(await reopened.locator('#message-input').inputValue(), '', 'A durably submitted draft must not resurrect');
    await receive(b, 'committed before refresh');
    assert.equal(database.prepare('SELECT COUNT(*) n FROM messages WHERE client_msg_id=?').get(sentId).n, 1);
    assert.equal(await b.locator('.message-text').filter({ hasText: 'committed before refresh' }).count(), 1);

    for (const newer of ['new input during send', 'same text ABA']) {
      await barrier(reopened); await reopened.locator('#message-input').fill('same text ABA'); await reopened.locator('#send-text').click();
      await waitForState(reopened, 'durable-send-newer-input', () => window.durableSend && app.outbox.has(window.durableSend));
      await reopened.locator('#message-input').fill('intermediate edit'); await reopened.locator('#message-input').fill(newer);
      await reopened.evaluate(() => window.releaseSend());
      await reload(reopened); assert.equal(await reopened.locator('#message-input').inputValue(), newer, 'Sending must retain newer input, including ABA');
    }

    // Clearing belongs to recovery binding, where the old history is about to
    // be replaced. Use an independent vault, not a live MLS receive cursor.
    const clearContext = await browser.newContext(options), clearPage = await clearContext.newPage();
    await clearPage.goto(url);
    const clearResult = await clearPage.evaluate(async () => {
      const v = await import('/src/lib/vault.ts');
      const member = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active' };
      const session = await v.createVault({ v: 1, roomId: 'isolated-draft-clear', accessToken: 'synthetic', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [member], identity: { publicBundle: member } }, 'synthetic clear fixture password', 'password');
      const old = await v.prepareComposerDraft(session, 'must be cleared');
      const preferences = { composerDraft: old.draft };
      await v.clearLocalBrowserData(session); await v.saveUiPreferences(session, preferences);
      const next = await v.prepareComposerDraft(session, (await v.loadUiPreferences(session)).composerDraft);
      let stale = false; try { old.write('late old runtime'); } catch { stale = true; }
      const draft = next.draft; old.dispose(); next.dispose(); return { draft, stale };
    });
    assert.deepEqual(clearResult, { draft: '', stale: true }); await clearContext.close();

    // Same-browser case is separate from the isolated A/B participant contexts.
    await reopened.locator('#message-input').fill('before another tab');
    const second = await ac.newPage(); second.setDefaultTimeout(15000); await second.goto(url); await unlock(second);
    assert.equal(await second.locator('#message-input').inputValue(), 'before another tab');
    await second.locator('#message-input').fill('latest from second tab');
    await reload(second); assert.equal(await second.locator('#message-input').inputValue(), 'latest from second tab');

    await b.locator('#message-input').fill(`reverse ${engine}`); await b.locator('#send-text').click(); await receive(second, `reverse ${engine}`);
    await second.locator('#message-input').fill(`forward ${engine}`); await second.locator('#send-text').click(); await receive(b, `forward ${engine}`);
    const opaque = await second.evaluate(() => Object.entries(localStorage).filter(([id]) => id.startsWith('quiet-room:composer-draft:')));
    assert.ok(!JSON.stringify(opaque).includes('latest from second tab'));
    // Real peer enrollment wins over a delayed invitation-close return.
    await second.locator('#open-spaces').click(); await second.locator('#space-create').click(); await protect(second);
    await second.locator('#invite-url').waitFor(); const nextInvite = await second.locator('#invite-url').inputValue();
    await second.evaluate(() => {
      const original = app.openPrivateSpaces.bind(app);
      app.openPrivateSpaces = (guard, scroll) => new Promise(resolve => {
        window.inviteReturnRequested = true;
        window.releaseInviteReturn = async () => { app.openPrivateSpaces = original; await original(guard, scroll); resolve(); };
      });
    });
    await second.locator('#invite-close').click(); await waitForState(second, 'invitation-return', () => window.inviteReturnRequested);
    // A fresh peer browser follows initial invite enrollment. Reusing B's
    // already-protected browser would require its existing-vault unlock route.
    const joiningContext = await browser.newContext(options);
    await joiningContext.addInitScript(() => { delete window.PublicKeyCredential; });
    const joiningPeer = await joiningContext.newPage(); joiningPeer.setDefaultTimeout(15000);
    await joiningPeer.goto(nextInvite); await joiningPeer.locator('[data-device-verify]').click();
    await protect(joiningPeer); await ready(joiningPeer); await ready(second);
    await second.evaluate(() => window.releaseInviteReturn());
    assert.equal(await second.locator('.space-drawer-overlay').count(), 0, 'Late return must not cover the completed peer join');
    await second.locator('#message-input').fill(`after invitation race ${engine}`); await second.locator('#send-text').click(); await receive(joiningPeer, `after invitation race ${engine}`);
    await joiningContext.close();
    console.log(`PASS draft-refresh ${engine}: actual refresh/close, IME, IDB abort, post-commit unload, new input/ABA, clear fence, separate same-browser tabs, bidirectional MLS, peer-join before delayed invite return`);
    await ac.close(); await bc.close(); await browser.close(); browser = undefined;
  }
} finally { database?.close(); await browser?.close(); await vite?.close(); await service?.close(); await rm(dataDir, { recursive: true, force: true }); }
