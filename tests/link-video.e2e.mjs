import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__link_video', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app"></main>',
  );
});
let browser;
try {
  await server.listen();
  browser =
    process.env.QUIET_ROOM_TEST_BROWSER === 'webkit'
      ? await webkit.launch()
      : await chromium.launch(
          process.env.CHROME_PATH
            ? { executablePath: process.env.CHROME_PATH }
            : process.env.CI
              ? {}
              : { channel: 'chrome' },
        );
  const roomId = crypto.randomUUID();
  const large = process.env.CHAMBER_TEST_LARGE_LINK_VIDEO === '1';
  for (const role of large ? ['joiner'] : ['creator', 'joiner']) {
    const page = await browser.newPage({
      locale: 'zh-CN',
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://localhost:' + server.httpServer.address().port + '/__link_video');
    await page.evaluate(
      async ({ role, roomId, large }) => {
        const vault = await import('/src/lib/vault.ts');
        const { QuietRoomApp } = await import('/src/app.ts');
        await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
        const own = {
          deviceId: crypto.randomUUID(),
          role,
          status: 'active',
          capabilities: ['file-message-v1', 'media-dimensions-v1'],
        };
        const peer = {
          ...own,
          role: role === 'creator' ? 'joiner' : 'creator',
          deviceId: crypto.randomUUID(),
        };
        const session = await vault.createVault(
          {
            v: 1,
            roomId,
            accessToken: 'fixture',
            role,
            protocol: 'legacy-v1',
            lastSeq: 0,
            members: [own, peer],
            identity: { publicBundle: own },
          },
          'link-video-fixture-password',
          'password',
        );
        const app = new QuietRoomApp(document.querySelector('#app'));
        app.session = session;
        app.privacyCovered = false;
        app.runtimeAbort = new AbortController();
        app.uiPreferencesHydrated = true;
        app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
        app.updateSafetyCode = async () => {};
        app.unreadCounter.markRead = async () => {};
        app.connectionState = 'disconnected';
        app.retryOperation = (operation) => operation();
        // Synthetic ISO boxes isolate byte preservation and do not require a device codec.
        const atom = (tag, data) => {
          const b = new Uint8Array(8 + data.length);
          new DataView(b.buffer).setUint32(0, b.length);
          b.set(new TextEncoder().encode(tag), 4);
          b.set(data, 8);
          return b;
        };
        const payload = new Uint8Array(large ? 2 ** 20 : 1024).fill(123);
        const block = new Blob([payload]);
        const count = large ? 589 : 1;
        const dataHeader = atom('mdat', []);
        new DataView(dataHeader.buffer).setUint32(0, block.size * count + 8);
        const essence = new Blob([
          atom('ftyp', new TextEncoder().encode('isom0000')),
          atom('moov', [0]),
          dataHeader,
          ...Array(count).fill(block),
        ]);
        const source = new Blob([essence, atom('free', new Uint8Array(80))], { type: 'video/mp4' });
        const requests = [],
          uploads = [],
          realFetch = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.href);
          if (url.hostname === 'api.fxtwitter.com') {
            requests.push(url.hostname);
            return Response.json({
              code: 200,
              tweet: {
                id: '123',
                media: { videos: [{ url: 'https://video.twimg.com/test/video.mp4', duration: 2 }] },
              },
            });
          }
          if (url.hostname === 'video.twimg.com') {
            requests.push(url.hostname);
            return new Response(init.method === 'HEAD' ? null : source, {
              headers: { 'content-type': 'video/mp4', 'content-length': String(source.size) },
            });
          }
          if (url.pathname.includes('/blobs')) {
            requests.push('chamber-upload');
            if (init.method === 'PUT') uploads[Number(url.pathname.split('/').pop())] = new Blob([init.body]);
            return Response.json({ ok: true, uploadedIndexes: [], completed: false });
          }
          return realFetch(input, init);
        };
        app.renderChat();
        window.f = {
          app,
          vault,
          session,
          requests,
          uploads,
          source,
          essence,
          large,
          signal: app.runtimeAbort.signal,
        };
      },
      { role, roomId, large },
    );
    const sheet = page.locator('.link-video-sheet');
    const click = (text) => sheet.getByRole('button', { name: text, exact: true }).click();
    await page.locator('#open-chat-tools').click();
    await page.locator('#open-link-video').click();
    await click('我的下载');
    await sheet.getByText('暂无本机视频').waitFor();
    await click('链接视频');
    await sheet.getByRole('textbox').fill('https://x.com/demo/status/123?s=46');
    await click('识别');
    await click(role === 'creator' ? '仅下载' : '下载并发送');
    if (role === 'creator') {
      await sheet.getByText('已保存到我的下载').waitFor();
      const privateState = await page.evaluate(async () => {
        const { app, vault, session, requests, signal, source } = window.f;
        const [row] = await vault.listLinkVideos(session, signal),
          file = await vault.readLinkVideo(session, row.id, signal);
        const raw = await new Promise((resolve) => {
          const r = indexedDB.open('quiet-room');
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction(['linkVideos', 'linkVideoParts']),
              q = tx.objectStore('linkVideos').getAll(),
              parts = tx.objectStore('linkVideoParts').getAll();
            tx.oncomplete = () => {
              resolve({ row: q.result[0], body: new Blob([parts.result[0].ciphertext]) });
              db.close();
            };
          };
        });
        return {
          chat: app.messages.size,
          outbox: (await vault.loadOutbox(session)).length,
          upload: requests.includes('chamber-upload'),
          equal: (await file.text()) === (await source.text()),
          encrypted:
            raw.body.size > source.size &&
            !JSON.stringify(raw).includes(row.name) &&
            !(await raw.body.text()).includes('ftyp'),
        };
      });
      assert.deepEqual(privateState, { chat: 0, outbox: 0, upload: false, equal: true, encrypted: true });
      await click('我的下载');
      const tile = sheet.locator('.link-video-tile');
      await tile.locator('.local-video-lock').waitFor();
      await tile.dispatchEvent('pointerdown', { isPrimary: true, button: 0, pointerType: 'touch' });
      await sheet.locator('.link-video-menu').waitFor();
      assert.equal(await page.evaluate(() => window.f.requests.includes('chamber-upload')), false);
      await click('取消');
      await sheet.getByRole('button', { name: '更多操作' }).click();
      await click('发送至聊天');
    }
    if (large) {
      await sheet.getByText('请先让所有已授权设备打开一次最新版，再发送大视频').waitFor({ timeout: 240000 });
      assert.equal(await page.evaluate(() => window.f.uploads.length), 0);
      await page.evaluate(() => {
        for (const member of window.f.session.vault.members) member.capabilities.push('large-video-v1');
      });
      await click('发送至聊天');
    }
    await sheet.getByText('已交给聊天发送').waitFor({ timeout: large ? 300000 : 18000 });
    const sent = await page.evaluate(async () => {
      const { app, vault, session, signal, uploads, essence } = window.f;
      const [row] = await vault.listLinkVideos(session, signal),
        outbox = await vault.loadOutbox(session);
      const { decryptFileAttachment } = await import('/src/lib/file-crypto.ts');
      const restored = await decryptFileAttachment(outbox[0].payload.file, async (_id, index) =>
        uploads[index].arrayBuffer(),
      );
      if (restored.size !== essence.size) throw Error('Decoded attachment changed size');
      // Compare the entire restored file in bounded portions, including large fixtures.
      for (let offset = 0; offset < essence.size; offset += 2 ** 20) {
        const actual = new Uint8Array(await restored.slice(offset, offset + 2 ** 20).arrayBuffer());
        const original = new Uint8Array(await essence.slice(offset, offset + 2 ** 20).arrayBuffer());
        if (!actual.every((byte, index) => byte === original[index]))
          throw Error('Decoded attachment lost media bytes');
      }
      return {
        count: outbox.length,
        sameId: outbox[0]?.clientMsgId === row.id,
        kind: outbox[0]?.payload.kind,
        losslessSize: outbox[0]?.payload.file.originalSize === essence.size,
        privateUntilAck: !row.shared,
        encrypted: uploads.length > 0 && !(await uploads[0].slice(0, 64).text()).includes('ftyp'),
      };
    });
    assert.deepEqual(sent, {
      count: 1,
      sameId: true,
      kind: 'file',
      losslessSize: true,
      privateUntilAck: true,
      encrypted: true,
    });
    await page.evaluate(() => window.f.app.runtimeAbort.abort());
    await sheet.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'X video: both roles, direct import, encrypted local storage, explicit sharing, MP4 compaction and encrypted file outbox passed.',
  );
} finally {
  await browser?.close();
  await server.close();
}
