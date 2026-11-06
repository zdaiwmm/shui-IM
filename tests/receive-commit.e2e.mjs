import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { harness, send, durable, outputDirectory, outputReady } from './helpers/receive-harness.mjs';

await outputReady();
const results = { startedAt: new Date().toISOString(), cases: [] };
for (const engine of ['chromium', 'webkit']) {
  const h = await harness({ engine });
  try {
    const [sender, peer] = await h.pair();
    await send(sender, 'synthetic reaction target');
    await peer.getByText('synthetic reaction target', { exact: true }).waitFor();
    await sender.waitForFunction(() => !auditApp.outbox.size && !auditApp.serverQueue.size);
    const observed = await sender.evaluate(async () => {
      const app = auditApp;
      const target = [...app.messages.values()].find(row => row.payload.text === 'synthetic reaction target');
      const marker = crypto.randomUUID();
      const faults = []; let injected = false;
      const remove = IDBObjectStore.prototype.delete;
      const error = app.operationalError.bind(app);
      app.operationalError = function (...args) {
        faults.push({ error: String(args[0]), injected, seq: app.session?.vault.lastSeq,
          controls: [...(app.session?.vault.mls?.window?.controls ?? [])],
          queued: [...app.serverQueue.keys()] });
        return error(...args);
      };
      IDBObjectStore.prototype.delete = function (...args) {
        const request = remove.apply(this, args);
        if (!injected && this.name === 'outbox' && String(args[0]).endsWith(':' + marker)) {
          injected = true;
          request.addEventListener('success', () => this.transaction.abort(), { once: true });
        }
        return request;
      };
      window.auditProbe = { marker, faults, restore: () => { IDBObjectStore.prototype.delete = remove; app.operationalError = error; } };
      // Send through the application's normal enqueue/ratchet/outbox path.
      await app.enqueuePayload({ v: 1, kind: 'reaction', emoji: '❤️', target: {
        clientMsgId: target.clientMsgId, serverSeq: target.seq, senderId: target.senderId,
      }, sentAt: new Date().toISOString() }, marker);
      return { targetSeq: target.seq };
    });
    await sender.waitForFunction(() => auditProbe.faults.length > 0, undefined, { timeout: 15_000 });
    const atFailure = await sender.evaluate(() => auditProbe.faults);
    const savedAfterFailure = await durable(sender);
    await sender.evaluate(async () => { auditProbe.restore(); await auditApp.drainServerQueue(); });
    const after = await durable(sender);
    const snapshot = await sender.evaluate(() => ({ liveSeq: auditApp.session?.vault.lastSeq,
      controls: auditApp.session?.vault.mls?.window?.controls ?? [], fatal: Boolean(document.querySelector('#fatal-message')) }));
    const duplicates = after.controls.length !== new Set(after.controls).size;
    const storage = await storageCases(h, sender);
    assert.ok(Object.values(storage).every(value => value === true), JSON.stringify(storage));
    const boundaryCheck = await sender.evaluate(async () => {
      const w = await import('/src/lib/message-window.ts');
      const v = await import('/src/lib/vault.ts');
      // Reproduce a persisted pre-fix duplicate, then exercise the real window entry point.
      await v.withVaultMutation(auditApp.session, async lease => {
        auditApp.session.vault.mls.window.controls.push(auditApp.session.vault.mls.window.controls.at(-1));
        await v.saveVault(auditApp.session, lease);
      });
      await auditApp.ensureMessageWindow(true);
      const valid = w.validRetentionBoundary(w.retentionBoundary(auditApp.session.vault));
      try { await auditApp.ensureMessageWindow(true); return { valid, rotation: 'completed' }; }
      catch (error) { return { valid, rotation: 'rejected', error: String(error) }; }
    });
    const finding = { engine, ...observed, atFailure, savedAfterFailure, after, snapshot, duplicateControls: duplicates, boundaryCheck, storage };
    results.cases.push(finding);
    console.log('POSTCOMMIT_PROBE', JSON.stringify(finding));
    assert.ok(atFailure.some(x => x.injected), 'Fault injector must hit the intended storage abort');
    assert.equal(duplicates, false, 'Committed controls must not contain duplicate sequences');
    assert.ok(atFailure.every(x => x.controls.every(seq => seq <= x.seq)), 'An aborted receive must not install partial in-memory progress');
    assert.equal(boundaryCheck.valid, true);
    assert.equal(boundaryCheck.rotation, 'completed');
    assert.equal(after.outbox, 0);
    await sender.evaluate(async () => {
      const app = auditApp, clear = app.clearRetry.bind(app), report = app.operationalError.bind(app);
      const id = crypto.randomUUID();
      window.postCommitFault = { id, observed: false };
      app.clearRetry = function (clientMsgId) {
        if (clientMsgId === id && app.session.vault.lastSeq > 3 && !postCommitFault.observed) throw Error('synthetic post-commit UI failure');
        return clear(clientMsgId);
      };
      app.operationalError = function (cause, ...rest) {
        if (String(cause).includes('synthetic post-commit')) { postCommitFault.observed = true; postCommitFault.seq = app.session.vault.lastSeq; }
        return report(cause, ...rest);
      };
      await app.enqueuePayload({ v: 1, kind: 'text', text: 'committed before presentation failure', sentAt: new Date().toISOString() }, id);
    });
    await sender.waitForFunction(() => postCommitFault.observed);
    const projectionFault = await sender.evaluate(() => postCommitFault);
    const committed = await durable(sender);
    assert.ok(committed.rows.some(row => row.id === projectionFault.id));
    assert.ok(committed.seq >= projectionFault.seq);
    assert.equal(committed.outbox, 0);
    // Reload uses the production openSession path and reconstructs presentation from durable history.
    await sender.reload(); await h.ready(sender);
    await sender.getByText('committed before presentation failure', { exact: true }).waitFor();
    await send(sender, 'continued after durable receive');
    await peer.getByText('continued after durable receive', { exact: true }).waitFor();
    finding.postCommitResume = true;
  } catch (error) {
    results.cases.push({ engine, error: String(error) }); throw error;
  } finally {
    await writeFile(path.join(outputDirectory, 'receive-commit.json'), JSON.stringify(results, null, 2));
    await h.close();
  }
}

async function storageCases(h, source) {
  const fixture = await source.evaluate(async () => ({ vault: auditApp.session.vault,
    history: await (await import('/src/lib/vault.ts')).loadHistory(auditApp.session) }));
  const page = await h.newPage();
  await page.route('**/storage-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage fault regression</title>' }));
  await page.goto(h.origin + '/storage-fixture');
  try { return await page.evaluate(async ({ vault, history }) => {
    const v = await import('/src/lib/vault.ts'), b = await import('/src/lib/browser-room-key.ts');
    const s = await v.createVault(vault, '', 'platform', await b.automaticRoomCredential());
    for (const message of history) await v.saveHistoryMessage(s, message);
    const original = structuredClone(s.vault), results = {};
    const reset = async controls => {
      s.vault = structuredClone(original);
      s.vault.mls.window.controls = controls ?? [...original.mls.window.controls, original.mls.window.controls.at(-1)];
      await v.saveVault(s);
    };
    const durable = async () => v.unlockVault(await b.browserRoomKey());
    const snapshot = async () => JSON.stringify({ live: s.vault, stored: await v.readStoredVault() });
    const rejectUnchanged = async operation => {
      const before = await snapshot(); let rejected = false;
      try { await operation(); } catch { rejected = true; }
      return rejected && before === await snapshot();
    };
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('quiet-room'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const transaction = (store, action, mode = 'readwrite') => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode), request = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(request?.result); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
    });
    try {
      await reset();
      const beforeGroup = s.vault.mls.groupState;
      results.repaired = await v.repairDuplicateWindowControls(s);
      results.idempotent = !await v.repairDuplicateWindowControls(s);
      results.durableRepair = JSON.stringify((await durable()).vault.mls.window.controls) === JSON.stringify(original.mls.window.controls);
      results.noHistoryOrRatchetChange = beforeGroup === s.vault.mls.groupState && JSON.stringify(history) === JSON.stringify(await v.loadHistory(s));
      const message = history.at(-1), prior = JSON.stringify(s.vault);
      await v.withVaultMutation(s, lease => v.commitMlsReceive(s, message, 'must-not-rewind-ratchet', undefined, lease));
      results.exactReplay = JSON.stringify(s.vault) === prior;
      results.conflictRejected = await rejectUnchanged(() => v.withVaultMutation(s, lease => v.commitMlsReceive(s,
        { ...message, acceptedAt: '2000-01-01T00:00:00.000Z' }, 'must-not-install', undefined, lease)));
      await reset();
      const aborted = new AbortController(); aborted.abort();
      results.cancelledRepair = await rejectUnchanged(() => v.repairDuplicateWindowControls(s, aborted.signal));
      const put = IDBObjectStore.prototype.put, controller = new AbortController(); let injected = false;
      IDBObjectStore.prototype.put = function (...args) {
        const r = put.apply(this, args);
        if (this.name === 'vault') { injected = true; controller.abort(); }
        return r;
      };
      try { results.cancelledInstall = await rejectUnchanged(() => v.repairDuplicateWindowControls(s, controller.signal)) && injected; }
      finally { IDBObjectStore.prototype.put = put; }
      const raw = (await transaction('history', store => store.getAll(), 'readonly')).find(row => row.seq === message.seq);
      await transaction('history', store => store.delete(raw.id));
      results.missingRejected = await rejectUnchanged(() => v.repairDuplicateWindowControls(s));
      await transaction('history', store => store.put({ ...raw, ciphertext: (raw.ciphertext[0] === 'A' ? 'B' : 'A') + raw.ciphertext.slice(1) }));
      results.corruptRejected = await rejectUnchanged(() => v.repairDuplicateWindowControls(s));
      await transaction('history', store => store.put(raw));
      const controls = original.mls.window.controls;
      await reset([controls.at(-1), controls[0], controls[0]]);
      results.unorderedRejected = await rejectUnchanged(() => v.repairDuplicateWindowControls(s));
      await reset([...controls, original.lastSeq + 1, original.lastSeq + 1]);
      results.outsideRejected = await rejectUnchanged(() => v.repairDuplicateWindowControls(s));
      await reset([history[0].seq, ...controls, controls.at(-1)]);
      results.classificationRejected = await rejectUnchanged(() => v.repairDuplicateWindowControls(s));
      await reset();
      const stale = { ...s, vault: structuredClone(s.vault) };
      await v.saveVault(s);
      const storedBefore = JSON.stringify(await v.readStoredVault());
      let staleRejected = false;
      try { await v.repairDuplicateWindowControls(stale); } catch { staleRejected = true; }
      results.staleRejected = staleRejected && JSON.stringify(await v.readStoredVault()) === storedBefore;
      await v.repairDuplicateWindowControls(s);
      // A local link video acknowledgement and outbox retirement share the receive transaction.
      const id = crypto.randomUUID(), bytes = new Blob(['synthetic local video bytes']), signal = new AbortController().signal;
      await v.storeLinkVideo(s, { id, key: id, name: 'synthetic.mp4', size: bytes.size, created: Date.now(), duration: 1 }, bytes, signal);
      const payload = { v: 1, kind: 'file', sentAt: new Date().toISOString(), file: { v: 1, blobId: crypto.randomUUID(),
        key: 'A'.repeat(43), ivPrefix: 'A'.repeat(11), chunkSize: 2 * 1024 * 1024, chunkCount: 1, originalSize: bytes.size,
        originalName: 'synthetic.mp4', mimeType: 'video/mp4', lastModified: 0, sha256: 'a'.repeat(64) } };
      await v.withVaultMutation(s, lease => v.commitMlsSend(s, { clientMsgId: id, payload, createdAt: payload.sentAt }, s.vault.mls.groupState, lease));
      const fileMessage = { seq: s.vault.lastSeq + 1, clientMsgId: id, senderId: s.vault.identity.publicBundle.deviceId,
        payload, acceptedAt: payload.sentAt, status: 'stored' };
      let videoInjected = false;
      IDBObjectStore.prototype.put = function (...args) {
        const r = put.apply(this, args);
        if (this.name === 'linkVideos') { videoInjected = true; r.addEventListener('success', () => this.transaction.abort(), { once: true }); }
        return r;
      };
      try { results.videoAbort = await rejectUnchanged(() => v.withVaultMutation(s, lease => v.commitMlsReceive(s, fileMessage, s.vault.mls.groupState, undefined, lease))) && videoInjected; }
      finally { IDBObjectStore.prototype.put = put; }
      results.videoAbortAtomic = (await v.loadOutbox(s)).some(row => row.clientMsgId === id)
        && !(await v.listLinkVideos(s, signal)).find(row => row.id === id).shared
        && !(await v.loadHistory(s)).some(row => row.clientMsgId === id);
      await v.withVaultMutation(s, lease => v.commitMlsReceive(s, fileMessage, s.vault.mls.groupState, undefined, lease));
      const reopened = await durable();
      results.videoCommitAtomic = !(await v.loadOutbox(reopened)).some(row => row.clientMsgId === id)
        && (await v.listLinkVideos(reopened, signal)).find(row => row.id === id).shared
        && (await v.loadHistory(reopened)).some(row => row.clientMsgId === id) && reopened.vault.lastSeq === fileMessage.seq;
      return results;
    } finally { db.close(); }
  }, fixture); } finally { await page.close(); }
}
