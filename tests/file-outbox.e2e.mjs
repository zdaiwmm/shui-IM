import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Exercise the production outbox methods and retry timers. Only socket delivery
// and message-list painting are captured; protocol fixtures use real envelopes.
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__file_outbox', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><div id="app"><div id="notice" hidden></div></div></body></html>');
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__file_outbox`);
  const results = await page.evaluate(async () => {
    const { QuietRoomApp } = await import('/src/app.ts');
    const { encryptMessage, generateIdentity } = await import('/src/lib/crypto.ts');
    const { randomBase64Url } = await import('/src/lib/base64.ts');
    const check = (value, message) => { if (!value) throw Error(message); };
    const [identity, peerIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
    const own = { ...identity.publicBundle, role: 'creator', status: 'active', capabilities: ['file-message-v1', 'reply-v2'] };
    const peer = { ...peerIdentity.publicBundle, role: 'joiner', status: 'active', capabilities: ['file-message-v1', 'reply-v2'] };
    const session = { vault: { v: 1, roomId: crypto.randomUUID(), role: 'creator', protocol: 'legacy-v1', members: [own, peer], identity } };
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    root.innerHTML = '<div id="notice" hidden></div>';
    app.session = session;
    app.privacyCovered = false;
    app.runtimeEpoch++;
    app.runtimeAbort = new AbortController();
    app.connectionState = 'connected';
    let renderCount = 0;
    app.renderMessages = () => { renderCount++; };
    const sent = [];
    app.socket = { sendEnvelope: (envelope, countUnread) => sent.push({ envelope, countUnread }) };

    const sentAt = new Date().toISOString();
    const file = {
      v: 1, blobId: crypto.randomUUID(), key: randomBase64Url(32), ivPrefix: randomBase64Url(8),
      chunkSize: 2 * 1024 * 1024, chunkCount: 1, originalSize: 12, originalName: 'queued.pdf',
      mimeType: 'application/pdf', lastModified: 1_700_000_000_000, sha256: 'a'.repeat(64),
    };
    const payloads = [
      { label: 'file', payload: { v: 1, kind: 'file', file, sentAt } },
      { label: 'gallery-file', payload: { v: 1, kind: 'gallery-file', file, sentAt } },
      {
        label: 'reply-file', payload: {
          v: 2, kind: 'text', text: '收到文件', sentAt,
          replyTo: { clientMsgId: crypto.randomUUID(), serverSeq: 1, senderId: peer.deviceId, kind: 'file', preview: '文件' },
        },
      },
    ];
    const addPending = async (payload, withEnvelope = true) => {
      const clientMsgId = crypto.randomUUID();
      const item = { clientMsgId, payload, createdAt: sentAt };
      if (withEnvelope) item.envelope = await encryptMessage(session.vault, payload, clientMsgId);
      app.outbox.set(clientMsgId, item);
      app.pending.set(clientMsgId, { seq: Number.MAX_SAFE_INTEGER, clientMsgId, senderId: own.deviceId, payload, acceptedAt: sentAt, status: 'pending' });
      return item;
    };
    const clearRetries = () => {
      for (const clientMsgId of [...app.retryTimers.keys()]) app.clearRetry(clientMsgId);
    };
    const cases = [];
    try {
      for (const { label, payload } of payloads) {
        peer.capabilities = ['file-message-v1', 'reply-v2'];
        const item = await addPending(payload);
        check(app.payloadCapabilityError(payload) === null, `${label}: fixture was not supported before the capability change`);
        peer.capabilities = ['reply-v2'];
        const sendsBefore = sent.length;
        const paintsBefore = renderCount;
        await app.attemptSend(item.clientMsgId);
        check(sent.length === sendsBefore, `${label}: an existing encrypted envelope bypassed the capability gate`);
        check(app.outbox.get(item.clientMsgId) === item, `${label}: the blocked item was removed or replaced`);
        check(app.pending.get(item.clientMsgId)?.status === 'failed', `${label}: blocked file has no retry state`);
        check(app.retryTimers.has(item.clientMsgId), `${label}: blocked file has no scheduled retry`);
        check(renderCount > paintsBefore, `${label}: the failed state was not rendered`);
        check(document.querySelector('#notice').textContent.includes('已加密保存在本机待发'), `${label}: missing compatibility explanation`);
        check(!app.sending.has(item.clientMsgId), `${label}: blocked item remained in the sending set`);

        peer.capabilities = ['file-message-v1', 'reply-v2'];
        await app.attemptSend(item.clientMsgId);
        check(sent.length === sendsBefore + 1, `${label}: capability recovery did not resume sending`);
        check(sent.at(-1).envelope === item.envelope, `${label}: retry replaced the existing encrypted envelope`);
        check(sent.at(-1).countUnread === (label !== 'gallery-file'), `${label}: retry changed unread-count semantics`);
        check(app.pending.get(item.clientMsgId)?.status === 'pending', `${label}: recovered item still appears failed`);
        app.clearRetry(item.clientMsgId);
        cases.push({ label, blocked: true, retained: true, recovered: true });
      }

      peer.capabilities = ['reply-v2'];
      const text = await addPending({ v: 1, kind: 'text', text: '普通文字继续发送', sentAt });
      const sendsBeforeText = sent.length;
      await app.attemptSend(text.clientMsgId);
      check(sent.length === sendsBeforeText + 1 && sent.at(-1).envelope === text.envelope, 'Ordinary text was incorrectly blocked by the file capability gate');
      check(app.pending.get(text.clientMsgId)?.status === 'pending', 'Ordinary text was marked failed');
      app.clearRetry(text.clientMsgId);

      // The no-envelope legacy path awaits real encryption. A peer can report
      // its older capability set before that asynchronous encryption returns.
      peer.capabilities = ['file-message-v1', 'reply-v2'];
      const duringEncryption = await addPending(payloads[0].payload, false);
      const sendsBeforeEncryption = sent.length;
      const encrypting = app.attemptSend(duringEncryption.clientMsgId);
      peer.capabilities = ['reply-v2'];
      await encrypting;
      check(sent.length === sendsBeforeEncryption, 'A capability change during encryption bypassed the final send gate');
      check(app.pending.get(duringEncryption.clientMsgId)?.status === 'failed', 'Capability change during encryption did not preserve a retry state');
      check(app.outbox.get(duringEncryption.clientMsgId) === duringEncryption && !app.sending.has(duringEncryption.clientMsgId), 'Capability change during encryption lost or stranded the queued item');
      app.clearRetry(duringEncryption.clientMsgId);

      // This sentinel cannot be decoded as an MLS state. If the guard runs
      // after encryption starts, the real MLS implementation will reject it.
      session.vault.protocol = 'mls-rfc9420';
      session.vault.mls = { phase: 'active', groupState: 'must-not-enter-mls-encryption', lastEventSeq: 7 };
      const originalMls = JSON.stringify(session.vault.mls);
      const sendsBeforeMls = sent.length;
      for (const { label, payload } of payloads) {
        const item = [...app.outbox.values()].find(value => value.payload === payload && value.envelope);
        const originalEnvelope = item.envelope;
        await app.reencryptOutboxItemLocked(item.clientMsgId, undefined, item.envelope);
        check(JSON.stringify(session.vault.mls) === originalMls, `${label}: unsupported retry changed MLS state`);
        check(app.outbox.get(item.clientMsgId) === item && item.envelope === originalEnvelope, `${label}: unsupported MLS retry replaced a queued envelope`);
        check(app.pending.get(item.clientMsgId)?.status === 'failed', `${label}: unsupported MLS retry did not defer the item`);
        check(app.retryTimers.has(item.clientMsgId), `${label}: unsupported MLS retry was not scheduled`);
        app.clearRetry(item.clientMsgId);
      }
      check(sent.length === sendsBeforeMls, 'Unsupported MLS re-encryption attempted socket delivery');
      return { existingEnvelopes: cases, ordinaryText: 'sent without file capability', changedDuringEncryption: 'blocked before socket delivery', unsupportedMls: 'state and queued envelopes unchanged' };
    } finally {
      clearRetries();
      if (app.noticeTimer !== null) window.clearTimeout(app.noticeTimer);
      if (app.noticeRemovalTimer !== null) window.clearTimeout(app.noticeRemovalTimer);
      app.privacyCovered = true;
      app.session = null;
      app.runtimeAbort.abort();
    }
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
