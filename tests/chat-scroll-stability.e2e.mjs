import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__scroll_stability', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app"></main>');
});
let browser;
try {
  await server.listen();
  for (const engine of ['webkit', 'chromium']) {
    browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch();
    for (const desktop of [false, true]) {
      const page = await browser.newPage({ viewport: desktop ? { width: 1280, height: 800 } : { width: 393, height: 844 },
        isMobile: !desktop, hasTouch: !desktop });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__scroll_stability`);
      await page.evaluate(async desktop => {
        for (const css of ['styles', 'chat-layout', 'chat-interactions', 'cover', 'gallery', 'desktop', 'motion']) await import(`/src/${css}.css`);
        const { QuietRoomApp } = await import('/src/app.ts');
        const vault = await import('/src/lib/vault.ts');
        const app = new QuietRoomApp(document.querySelector('#app'));
        app.visualClientCoordinates = !desktop; app.usesListScrolling = true;
        const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities: ['media-dimensions-v1', 'file-message-v1'] };
        const peer = { ...own, deviceId: crypto.randomUUID(), role: 'joiner' };
        const session = await vault.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'scroll-fixture', role: 'creator',
          protocol: 'legacy-v1', lastSeq: 180, members: [own, peer], identity: { publicBundle: own } }, 'scroll-fixture-password', 'password');
        app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController();
        app.uiPreferencesHydrated = true; app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
        app.updateSafetyCode = async () => {}; app.unreadCounter.markRead = async () => {};
        app.connectionState = 'disconnected'; app.retryOperation = operation => operation();
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
        const message = seq => ({ seq, clientMsgId: `scroll-${seq}`, senderId: peer.deviceId, status: 'delivered',
          acceptedAt: '2026-10-10T01:00:00.000Z', payload: { v: 1, kind: 'text', text: `阅读位置 ${seq}\n组合场景保持稳定。`, sentAt: '2026-10-10T01:00:00.000Z' } });
        app.messages = new Map(Array.from({ length: 180 }, (_, i) => [i + 1, message(i + 1)]));
        app.renderChat(); app.renderMessages({ scroll: 'bottom' });
        const gate = { hold: true, release: null, requests: 0, fail: false };
        const blobs = new Map(); const fetch = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.href);
          if (!url.pathname.includes('/blobs')) return fetch(input, init);
          const match = url.pathname.match(/\/blobs\/([^/]+)(?:\/chunks\/(\d+)|\/(complete))?$/);
          if (!match) return Response.json({ ok: true });
          const blob = blobs.get(match[1]) ?? { chunks: new Map(), completed: false }; blobs.set(match[1], blob);
          if (match[2] !== undefined && init.method === 'PUT') {
            gate.requests++;
            if (gate.hold) await new Promise(resolve => { gate.release = resolve; });
            init.signal?.throwIfAborted();
            if (gate.fail) throw Error('Synthetic upload interruption');
            blob.chunks.set(Number(match[2]), new Uint8Array(init.body)); return Response.json({ ok: true });
          }
          if (match[2] !== undefined) return new Response(blob.chunks.get(Number(match[2])));
          if (match[3]) { blob.completed = true; return Response.json({ ok: true }); }
          return Response.json({ uploadedIndexes: [...blob.chunks.keys()], completed: blob.completed });
        };
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 480;
        canvas.getContext('2d').fillRect(0, 0, 320, 480);
        const file = new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], 'synthetic-scroll.png', { type: 'image/png' });
        const up = (distance = 700) => {
          const list = app.chatLayoutElements.list;
          list.dispatchEvent(new WheelEvent('wheel', { deltaY: -distance, bubbles: true }));
          app.setChatScrollTop(app.chatScrollTop - distance);
          app.commitChatScrollBookkeeping(list, true);
        };
        const observe = () => {
          const anchor = app.captureChatAnchor(); const row = document.querySelector(`[data-client-msg-id="${anchor.clientMsgId}"]`);
          const bubble = row.querySelector('.message-bubble');
          const { header, composer } = app.chatLayoutElements;
          const origin = { row: row.getBoundingClientRect().top, header: header.getBoundingClientRect().top,
            bottom: composer.getBoundingClientRect().bottom };
          const samples = []; let running = true;
          const sample = () => {
            samples.push({ row: row.getBoundingClientRect().top, header: header.getBoundingClientRect().top,
              bottom: composer.getBoundingClientRect().bottom, opacity: Number(getComputedStyle(composer).opacity),
              connected: row.isConnected && bubble === row.querySelector('.message-bubble'),
              obscured: document.documentElement.classList.contains('privacy-obscured') });
            if (running) requestAnimationFrame(sample);
          };
          sample(); return { anchor, origin, samples, stop() { running = false; } };
        };
        window.scrollFixture = { app, message, gate, file, up, observe, vault };
      }, desktop);
      const settle = () => page.waitForFunction(() => {
        const a = window.scrollFixture.app;
        return !a.chatViewportMotion?.moving && !a.composerHeightMotion && !a.listKeyboardLayout.moving && !a.chatMessageAnimations.size;
      }, undefined, { timeout: 10_000 });
      const sampleSettledFrames = async () => {
        const start = await page.evaluate(() => window.scrollFixture.watch.samples.length);
        // CI WebKit may draw fewer than four frames in 120 ms. Wait for actual
        // frame samples, preserving every geometry/node/visibility assertion.
        await page.waitForFunction(start => window.scrollFixture.watch.samples.length >= start + 8, start, { timeout: 5_000 });
      };
      const stable = async (label, keyboard = false) => {
        await settle(); await sampleSettledFrames();
        const result = await page.evaluate(() => {
          const f = window.scrollFixture; f.watch.stop();
          return { ...f.watch, savedAnchor: f.watch.anchor, anchor: f.app.captureChatAnchor(), stop: undefined };
        });
        assert.equal(result.anchor.clientMsgId, result.savedAnchor.clientMsgId, `${label}: reading anchor replaced`);
        assert.ok(result.samples.length > 3, `${label}: missing frame samples`);
        for (const s of result.samples) {
          assert.ok(s.connected && !s.obscured && s.opacity === 1, `${label}: flash/replaced bubble ${JSON.stringify(s)}`);
          assert.ok(Math.abs(s.row - result.origin.row) <= 2, `${label}: reading position jumped ${JSON.stringify({ origin: result.origin, s })}`);
          assert.ok(Math.abs(s.header - result.origin.header) <= 1, `${label}: header jumped`);
          if (!keyboard) assert.ok(Math.abs(s.bottom - result.origin.bottom) <= 1, `${label}: composer jumped`);
        }
      };
      await settle();

      // A durable send waits behind another vault operation. Newer user input
      // must win over the eventual completion, not just over later receipts.
      await page.evaluate(() => {
        const f = window.scrollFixture;
        f.app.sendChain = new Promise(resolve => { f.releaseSend = resolve; });
        f.send = f.app.enqueuePayload({ v: 1, kind: 'text', text: 'delayed durable send', sentAt: new Date().toISOString() });
        f.up(); f.watch = f.observe();
      });
      await page.evaluate(async () => { const f = window.scrollFixture; f.releaseSend(); await f.send; });
      await stable(`${engine}/${desktop}: send then scroll`);

      await page.evaluate(() => {
        const f = window.scrollFixture; f.app.scrollChatToBottom();
        f.app.sendChain = new Promise(resolve => { f.releaseSend = resolve; });
        f.send = f.app.enqueuePayload({ v: 1, kind: 'text', text: 'scrollbar competing with send', sentAt: new Date().toISOString() });
        f.app.chatLayoutElements.list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
        f.app.setChatScrollTop(f.app.chatScrollTop - 650);
        f.app.commitChatScrollBookkeeping(f.app.chatLayoutElements.list, true); f.watch = f.observe();
      });
      await page.evaluate(async () => { const f = window.scrollFixture; f.releaseSend(); await f.send; });
      await stable(`${engine}/${desktop}: scrollbar competing with send`);

      // Direct quote navigation from the latest main is also a newer user
      // action; the older durable send must not pull the reader away from it.
      await page.evaluate(async () => {
        const f = window.scrollFixture; f.app.scrollChatToBottom();
        f.app.sendChain = new Promise(resolve => { f.releaseSend = resolve; });
        f.send = f.app.enqueuePayload({ v: 1, kind: 'text', text: 'send competing with quote', sentAt: new Date().toISOString() });
        await f.app.jumpToReplyTarget('scroll-90', 90);
      });
      await settle();
      await page.evaluate(() => { const f = window.scrollFixture; f.watch = f.observe(); });
      await page.evaluate(async () => { const f = window.scrollFixture; f.releaseSend(); await f.send; });
      await stable(`${engine}/${desktop}: direct quote competing with send`);

      // Explicit fresh sends still restore following from history.
      await page.evaluate(async () => { const f = window.scrollFixture; await f.app.enqueuePayload({ v: 1, kind: 'text', text: 'fresh send', sentAt: new Date().toISOString() }); });
      await settle();
      assert.equal(await page.evaluate(() => window.scrollFixture.app.chatPinnedToBottom), true);
      assert.ok(await page.evaluate(() => window.scrollFixture.app.chatBottomGap() <= 2));

      await page.evaluate(() => {
        const f = window.scrollFixture; f.up(); f.watch = f.observe();
        for (const message of f.app.pending.values()) message.status = 'failed';
        f.app.renderMessages({ scroll: 'preserve' });
      });
      await stable(`${engine}/${desktop}: scroll after local send then status update`);

      // Metadata preparation is asynchronous too, before the upload placeholder
      // first appears. A gesture in that interval must also cancel positioning.
      await page.evaluate(() => {
        const f = window.scrollFixture; f.app.scrollChatToBottom();
        f.upload = f.app.processImageBatch([f.file], 'chat'); f.up(700); f.watch = f.observe();
      });
      await page.waitForFunction(() => window.scrollFixture.gate.release !== null);
      await page.evaluate(() => { const f = window.scrollFixture; f.gate.hold = false; f.gate.release(); });
      assert.equal(await page.evaluate(() => window.scrollFixture.upload), true);
      await stable(`${engine}/${desktop}: scroll during media preparation`);

      await page.evaluate(() => {
        const f = window.scrollFixture; f.gate.hold = true; f.gate.release = null;
        f.upload = f.app.processImageBatch([f.file], 'chat');
      });
      await page.waitForFunction(() => window.scrollFixture.gate.release !== null);
      await settle();
      await page.evaluate(() => { const f = window.scrollFixture; f.up(900); f.watch = f.observe(); f.gate.hold = false; f.gate.release(); });
      assert.equal(await page.evaluate(() => window.scrollFixture.upload), true);
      await stable(`${engine}/${desktop}: upload while reading history`);

      // Retry is a state change of the original row, never a fresh send jump.
      await page.evaluate(() => {
        const f = window.scrollFixture; f.gate.hold = true; f.gate.release = null; f.gate.fail = true;
        f.upload = f.app.processImageBatch([f.file], 'chat');
      });
      await page.waitForFunction(() => window.scrollFixture.gate.release !== null);
      await settle();
      await page.evaluate(() => { const f = window.scrollFixture; f.gate.hold = false; f.gate.release(); });
      assert.equal(await page.evaluate(() => window.scrollFixture.upload), false);
      await settle();
      await page.evaluate(() => {
        const f = window.scrollFixture; f.up(750); f.watch = f.observe(); f.gate.fail = false;
        const [id, draft] = [...f.app.mediaUploads][0];
        f.retry = f.app.processImageBatch(draft.files, 'chat', undefined, draft.expression, id, draft.autoHide, draft.expressionKind);
      });
      assert.equal(await page.evaluate(() => window.scrollFixture.retry), true);
      await stable(`${engine}/${desktop}: retry while reading history`);

      // A live arrival shares the keyboard-open geometry batch. Preserve the
      // reader, while the composer alone travels to its new viewport edge.
      await page.locator('#message-input').focus();
      await page.evaluate(() => {
        const f = window.scrollFixture; f.watch = f.observe();
        if (!f.app.desktopLayoutWide) {
          Object.defineProperty(visualViewport, 'height', { configurable: true, value: 450 });
          visualViewport.dispatchEvent(new Event('resize'));
        }
        f.app.messages.set(181, f.message(181)); f.app.renderMessages({ scroll: 'preserve' });
      });
      await stable(`${engine}/${desktop}: arrival plus keyboard`, !desktop);
      if (!desktop) {
        assert.ok(await page.evaluate(() => Math.abs(document.querySelector('#composer').getBoundingClientRect().bottom - 450) <= 2));
        await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); document.querySelector('#message-input').blur(); });
        await settle();
      }

      // Removing the anchor must select its neighbour, never jump to latest.
      const deleted = await page.evaluate(() => {
        const f = window.scrollFixture; const anchor = f.app.captureChatAnchor();
        f.app.messages.delete(anchor.seq); f.app.renderMessages({ scroll: 'preserve' });
        return { anchor, next: f.app.captureChatAnchor(), gap: f.app.chatBottomGap() };
      });
      assert.ok(deleted.gap > 400, `${engine}/${desktop}: deleted reading anchor jumped to latest`);
      assert.ok(Math.abs(deleted.next.seq - deleted.anchor.seq) <= 1);
      assert.ok(Math.abs(deleted.next.offset - deleted.anchor.offset) <= 2);

      const reopened = await page.evaluate(() => {
        const f = window.scrollFixture; const anchor = f.app.captureChatAnchor(true);
        f.app.restoreChatAnchorOnNextRender = true; f.app.renderChat(); return anchor;
      });
      await settle();
      const restored = await page.evaluate(() => window.scrollFixture.app.captureChatAnchor());
      assert.equal(restored.clientMsgId, reopened.clientMsgId);
      assert.ok(Math.abs(restored.offset - reopened.offset) <= 2, `${engine}/${desktop}: reopening lost reading offset`);

      // Returning through a send must reach the actual newer local tail, not
      // just append a pending row after an old, partially loaded window.
      await page.evaluate(async () => {
        const f = window.scrollFixture;
        for (let seq = 182; seq <= 184; seq++) await f.vault.saveHistoryMessage(f.app.session, f.message(seq));
        f.app.session.vault.lastSeq = 184; f.app.historyForwardCursor = 181; f.app.historyHasNewer = true;
        await f.app.enqueuePayload({ v: 1, kind: 'text', text: 'send from partial history', sentAt: new Date().toISOString() });
      });
      await settle();
      assert.deepEqual(await page.evaluate(() => { const a = window.scrollFixture.app;
        return [a.historyHasNewer, a.historyForwardCursor, a.messages.has(184), a.chatPinnedToBottom, a.chatBottomGap() <= 2];
      }), [false, 184, true, true, true]);

      // Media consumes the same fresh-send navigation at preview time, before
      // uploading. It must load the tail too, then respect subsequent scrolling.
      await page.evaluate(() => {
        const f = window.scrollFixture;
        for (let seq = 182; seq <= 184; seq++) f.app.messages.delete(seq);
        f.app.historyForwardCursor = 181; f.app.historyHasNewer = true;
        f.app.renderMessages({ scroll: 'preserve' }); f.up(700);
        f.gate.hold = true; f.gate.release = null;
        f.upload = f.app.processImageBatch([f.file], 'chat');
      });
      await page.waitForFunction(() => window.scrollFixture.gate.release !== null);
      await settle();
      assert.deepEqual(await page.evaluate(() => { const a = window.scrollFixture.app;
        return [a.historyHasNewer, a.historyForwardCursor, a.messages.has(184), a.chatPinnedToBottom, a.chatBottomGap() <= 2];
      }), [false, 184, true, true, true]);
      await page.evaluate(() => { const f = window.scrollFixture; f.up(700); f.watch = f.observe(); f.gate.hold = false; f.gate.release(); });
      assert.equal(await page.evaluate(() => window.scrollFixture.upload), true);
      await stable(`${engine}/${desktop}: media from partial history then scroll during upload`);
      await page.evaluate(() => { window.scrollFixture.app.scrollChatToBottom(); });
      await settle();

      // At the bottom the same arrival/keyboard race should retain following.
      await page.locator('#message-input').focus();
      await page.evaluate(() => {
        const f = window.scrollFixture; f.watch = f.observe();
        if (!f.app.desktopLayoutWide) { Object.defineProperty(visualViewport, 'height', { configurable: true, value: 450 }); visualViewport.dispatchEvent(new Event('resize')); }
        f.app.messages.set(185, f.message(185)); f.app.renderMessages({ scroll: 'preserve' });
      });
      await settle(); await sampleSettledFrames();
      const bottomRace = await page.evaluate(() => {
        const f = window.scrollFixture; f.watch.stop();
        return { samples: f.watch.samples, pinned: f.app.chatPinnedToBottom, gap: f.app.chatBottomGap() };
      });
      assert.ok(bottomRace.pinned && bottomRace.gap <= 2, `${engine}/${desktop}: keyboard arrival lost bottom following`);
      for (const sample of bottomRace.samples) {
        assert.ok(sample.connected && !sample.obscured && sample.opacity === 1);
        assert.ok(Math.abs(sample.header) <= 1);
      }
      if (!desktop) {
        const bottoms = bottomRace.samples.map(sample => sample.bottom);
        assert.ok(bottoms.every((bottom, i) => !i || bottom <= bottoms[i - 1] + 1), `${engine}: keyboard composer reversed direction`);
        assert.ok(Math.abs(bottoms.at(-1) - 450) <= 2);
      }

      if (process.argv[2]) { await mkdir(process.argv[2], { recursive: true }); await page.screenshot({ path: `${process.argv[2]}/${engine}-${desktop ? 'desktop' : 'mobile'}.png` }); }
      assert.deepEqual(errors, []);
      console.log(`${engine}/${desktop ? 'desktop' : 'mobile'} chat scroll combinations passed`);
      await page.close();
    }
    await browser.close(); browser = null;
  }
} finally { await browser?.close(); await server.close(); }
