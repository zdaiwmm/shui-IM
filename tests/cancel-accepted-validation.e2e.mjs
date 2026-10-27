// Local diagnostic only. Actual product remains untouched; all identities are disposable.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'quiet-cancel-accepted-'));
const output = path.resolve('docs/requirements/2026-10-27-cancel-accepted-validation/results.json');
const results = { baseline: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  fixtureRevision: 'V1.1', startedAt: new Date().toISOString(), scope: 'synthetic local application, server, MLS and IndexedDB', cases: [] };
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
    for (const mode of ['delayed-no-cancel', 'cancel-before-submit', 'cancel-accepted-release', 'cancel-accepted-reload']) {
      stage = `${engineName}/${mode}: pair`;
      const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
      try {
        for (const context of contexts) await context.addInitScript(() => {
          localStorage.setItem('quiet-room:auto-lock-seconds', '0');
          localStorage.setItem('quiet-room:lock-on-hidden', '0');
        });
        const [peer, sender] = await Promise.all(contexts.map(context => context.newPage()));
        const errors = [];
        for (const page of [peer, sender]) { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); }
        const gate = { armed: false, id: null, held: [], submitted: 0, cancelled: false, afterCancelSubmissions: 0 };
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
            else route.send(raw);
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
        if (mode !== 'delayed-no-cancel') {
          await cancelThroughUI(sender, id); gate.cancelled = true;
          const cancelled = await local(sender);
          assert.equal(cancelled.outbox.includes(id), false);
          assert.ok(cancelled.hidden.includes(id));
          assert.equal(cancelled.history.some(message => message.id === id), false);
        }
        const heldTypes = gate.held.map(item => item.type);
        gate.armed = false;
        if (mode === 'cancel-accepted-reload' || mode === 'cancel-before-submit') {
          gate.held = [];
          await sender.reload();
        } else {
          for (const item of gate.held.splice(0)) item.route.send(item.raw);
        }
        await sender.waitForFunction(() => document.querySelector('#fatal-message')
          || auditApp.session && !auditApp.outbox.size && [...auditApp.messages.values()].some(message => message.payload.text === 'SYNTHETIC target')
          || document.querySelector('#message-input')?.disabled === false && window.auditApp?.connectionState === 'connected' && window.auditApp?.session && !auditApp.outbox.size,
        undefined, { polling: 100 });
        // For accepted scenarios, wait for the actual durable receive or failure, not only socket readiness.
        if (accepted) await sender.waitForFunction(id => document.querySelector('#fatal-message')
          || [...auditApp.messages.values()].some(message => message.clientMsgId === id), id, { polling: 100 });
        let snapshot = await local(sender);
        let bidirectional = false, blockedAfterPeerSend = false;
        stage = `${engineName}/${mode}: subsequent delivery`;
        if (!snapshot.fatal) {
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
          pageErrors: [...errors] };
        if (mode === 'cancel-before-submit') {
          assert.equal(row.serverTargetCopies, 0); assert.equal(await peer.getByText('SYNTHETIC target', { exact: true }).count(), 0);
          assert.equal(row.localHidden, true); assert.equal(row.targetDurable, false);
        } else assert.equal(row.serverTargetCopies, 1);
        if (mode === 'delayed-no-cancel' || mode === 'cancel-before-submit') {
          assert.equal(row.fatal, null); assert.equal(row.bidirectional, true);
        }
        assert.equal(row.afterCancelSubmissions, 0); assert.deepEqual(errors, []);
        results.cases.push(row);
        await writeFile(output, JSON.stringify(results, null, 2) + '\n');
        console.log(JSON.stringify(row));
      } finally { for (const context of contexts) await context.close(); }
    }
    await browser.close(); browser = null;
  }
  results.completedAt = new Date().toISOString();
  results.observedFailures = results.cases.filter(row => row.fatal || !row.bidirectional).length;
  console.log(`DIAGNOSTIC_COMPLETE ${results.cases.length} cases; ${results.observedFailures} observed product failures (not a product pass).`);
} catch (error) {
  results.harnessFailure = { stage, name: error.name, message: error.message };
  throw error;
} finally {
  await writeFile(output, JSON.stringify(results, null, 2) + '\n');
  await browser?.close(); await vite?.close(); await service?.close();
  await rm(directory, { recursive: true, force: true });
}
