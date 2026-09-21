import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__media_upload', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app"></main>'); });
let browser;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__media_upload`);
  await page.evaluate(async () => {
    for (const css of ['styles', 'chat-layout', 'chat-interactions', 'cover', 'memes', 'gallery']) await import(`/src/${css}.css`);
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities: ['file-message-v1', 'image-album-v1', 'media-dimensions-v1', 'expression-image-v1'] };
    const peer = { ...own, deviceId: crypto.randomUUID(), role: 'joiner' };
    const session = await vault.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'media-upload-fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own, peer], identity: { publicBundle: own } }, 'media-upload-password', 'password');
    app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController();
    app.uiPreferencesHydrated = true; app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
    app.updateSafetyCode = async () => {}; app.unreadCounter.markRead = async () => {};
    app.connectionState = 'disconnected'; app.retryOperation = operation => operation();
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const blobs = new Map();
    const gate = { release: null, hold: true, fail: false, requests: 0, failCommit: false };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname.includes('/memes/')) return Response.json({ items: [], packs: [], nextPage: null });
      if (!url.pathname.includes('/blobs')) return realFetch(input, init);
      const match = url.pathname.match(/\/blobs\/([^/]+)(?:\/chunks\/(\d+)|\/(complete))?$/);
      if (match) {
        const blob = blobs.get(match[1]) ?? { chunks: new Map(), completed: false }; blobs.set(match[1], blob);
        if (match[2] !== undefined && init.method === 'PUT') {
          gate.requests++;
          if (gate.hold) await new Promise(resolve => { gate.release = resolve; });
          init.signal?.throwIfAborted();
          if (gate.fail) throw Error('Synthetic failed upload');
          blob.chunks.set(Number(match[2]), new Uint8Array(init.body));
          return Response.json({ ok: true });
        }
        if (match[2] !== undefined) return new Response(blob.chunks.get(Number(match[2])));
        if (match[3]) { blob.completed = true; return Response.json({ ok: true }); }
        return Response.json({ uploadedIndexes: [...blob.chunks.keys()], completed: blob.completed });
      }
      return Response.json({ ok: true });
    };
    const makeFile = async (index, transparent = false, width = 512, height = transparent ? 512 : 320) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const c = canvas.getContext('2d');
      if (!transparent) { c.fillStyle = '#789894'; c.fillRect(0, 0, 512, 320); }
      c.fillStyle = '#dbc985'; c.fillRect(90, 80, 260, 150);
      c.fillStyle = '#234964'; c.fillRect(200, 120, 70, 70);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return new File([blob, new Uint8Array(2 * 1024 * 1024)], `合成预览-${index}.png`, { type: 'image/png', lastModified: index });
    };
    const files = [await makeFile(1), await makeFile(2), await makeFile(3, true), await makeFile(4, false, 120, 960), await makeFile(5, false, 960, 60), await makeFile(6, false, 60, 40), await makeFile(7, true, 512, 1024)];
    app.renderChat();
    const enqueue = app.enqueuePayload.bind(app);
    app.enqueuePayload = async (...args) => { if (gate.failCommit) throw Error('Synthetic local commit failure'); return enqueue(...args); };
    window.mediaFixture = { app, session, own, files, gate, blobs, vault, run: null, fileFor(variant) { return variant === 'tall-photo' ? files[3] : variant === 'wide-photo' ? files[4] : variant === 'small-photo' ? files[5] : variant === 'tall-expression' ? files[6] : variant.includes('expression') ? files[2] : files[0]; }, start(files, expression = false, autoHide = false) { this.run = app.processImageBatch(files, 'chat', undefined, expression, undefined, autoHide); } };
  });
  const geometry = async locator => locator.evaluate(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { width: box.width, height: box.height, corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius] };
  });
  const sameSize = (before, after, label) => {
    assert.ok(Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1, `${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    assert.equal(new Set(after.corners).size, 1, `${label}: four equal corners`);
  };
  for (const variant of ['photo', 'tall-photo', 'wide-photo', 'small-photo', 'album', 'expression', 'hidden-expression', 'tall-expression']) {
    await page.evaluate(variant => {
      const f = window.mediaFixture;
      f.gate.release = null; f.gate.hold = true; f.gate.fail = false;
      f.start(variant === 'album' ? f.files.slice(0, 2) : [f.fileFor(variant)], variant.includes('expression'), variant === 'hidden-expression');
    }, variant);
    const draft = page.locator('.media-upload');
    await draft.waitFor();
    await page.waitForFunction(() => window.mediaFixture.gate.release);
    await page.waitForFunction(() => [...document.querySelectorAll('.media-upload-preview')].every(cell => cell.querySelector('img')?.complete));
    const id = await draft.getAttribute('data-client-msg-id');
    const uploadBox = await geometry(draft.locator('.message-bubble'));
    assert.equal(new Set(uploadBox.corners).size, 1, 'Upload has four equal corners');
    assert.equal(await draft.getAttribute('data-concealed'), String(!variant.includes('expression') || variant === 'hidden-expression'));
    assert.equal(await page.locator('#upload-progress').isVisible(), false, 'No global progress for chat media');
    assert.equal(await draft.locator('.message-delivery').count(), 0, 'Upload is not a sent message');
    const width = await draft.locator('img').first().evaluate(image => image.naturalWidth);
    assert.equal(width <= 128, !variant.includes('expression') || variant === 'hidden-expression', 'Only concealed derivatives may be painted for private media');
    await page.evaluate(() => { const f = window.mediaFixture; f.row = document.querySelector('.media-upload'); f.app.renderMessages(); });
    assert.equal(await draft.evaluate(node => node === window.mediaFixture.row), true, 'Progress updates retain the row');
    await page.evaluate(() => { const g = window.mediaFixture.gate; g.fail = true; g.release(); });
    await page.waitForFunction(() => document.querySelector('.media-upload')?.dataset.uploadState === 'failed');
    assert.equal(await draft.getAttribute('data-client-msg-id'), id);
    const retryRect = await draft.getByRole('button', { name: '重试', exact: true }).boundingBox();
    assert.ok(retryRect.height >= 44 && retryRect.width >= 44);
    assert.equal(await draft.getAttribute('data-concealed'), String(!variant.includes('expression') || variant === 'hidden-expression'));
    if (process.argv[2]) {
      await mkdir(process.argv[2], { recursive: true });
      await page.screenshot({ path: `${process.argv[2]}/${variant}-failed.png` });
    }
    if (variant === 'hidden-expression') {
      await page.setViewportSize({ width: 320, height: 740 });
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      const action = draft.getByRole('button', { name: '重试', exact: true });
      await action.scrollIntoViewIfNeeded();
      const box = await action.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 320 && box.height >= 44);
      assert.equal(await draft.locator('.media-upload-ring').isVisible(), false);
      if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/hidden-expression-failed-dark-320.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    }
    await page.evaluate(() => { const g = window.mediaFixture.gate; g.hold = false; g.fail = false; });
    await draft.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.media-upload').length === 0);
    const message = page.locator(`.message[data-client-msg-id="${id}"]`);
    await message.locator('.image-preview[data-image-state="loaded"]').first().waitFor();
    assert.equal(await message.count(), 1);
    sameSize(uploadBox, await geometry(message.locator('.message-bubble')), `${variant} upload to pending`);
    if (variant !== 'album') sameSize(uploadBox, await geometry(message.locator('.image-preview')), `${variant} content fills bubble`);
    assert.match(await message.locator('.message-meta').innerText(), /发送中/);
    assert.equal(await message.locator('.message-delivery').count(), 0, '100% upload is not server confirmation');
    assert.equal(await message.locator('.image-preview').first().getAttribute('data-revealed'), String(variant.includes('expression') && variant !== 'hidden-expression'));
    const outcome = await page.evaluate(async ({ id, variant }) => {
      const f = window.mediaFixture;
      const entries = (await f.vault.loadOutbox(f.session)).filter(item => item.clientMsgId === id);
      if (entries.length !== 1) throw Error('Retry duplicated or lost message ID');
      const payload = entries[0].payload;
      if (variant.includes('expression') && payload.expressionAutoHide !== (variant === 'hidden-expression')) throw Error('Retry lost expression visibility policy');
      const { decryptImageFile } = await import('/src/lib/file-crypto.ts');
      const manifests = payload.kind === 'image-album' ? payload.images : [payload.image];
      const originals = variant === 'album' ? f.files.slice(0, 2) : [f.fileFor(variant)];
      for (const [index, manifest] of manifests.entries()) {
        const restored = await decryptImageFile(manifest, async (blobId, chunk) => f.blobs.get(blobId).chunks.get(chunk).buffer);
        const hash = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
        if (await hash(restored) !== await hash(originals[index])) throw Error('Original bytes changed');
      }
      // Server confirmation refreshes metadata without replacing the mounted preview.
      f.preview = document.querySelector(`[data-client-msg-id="${id}"] .image-preview`);
      f.app.pending.get(id).status = 'stored'; f.app.renderMessages();
      // Capture the animation in the same page task that creates it. Separate
      // count/evaluate calls can cross its 320ms completion and sample nothing.
      f.confirmationFade = [...document.querySelectorAll(`[data-client-msg-id="${id}"] .media-status-departing`)]
        .flatMap(node => node.getAnimations().map(animation => ({ duration: animation.effect.getTiming().duration,
          keyframes: animation.effect.getKeyframes().map(frame => frame.opacity) })));
      return manifests.length;
    }, { id, variant });
    assert.equal(await message.locator('.media-send-meta').count(), 0);
    sameSize(uploadBox, await geometry(message.locator('.message-bubble')), `${variant} server confirmation`);
    await page.waitForFunction(id => !document.querySelector(`[data-client-msg-id="${id}"] .media-upload-handoff`), id);
    const animation = await page.evaluate(() => window.mediaFixture.confirmationFade);
    assert.ok(animation.some(item => item.duration === 320 && item.keyframes.join(',') === '1,0'), 'Status fades out instead of vanishing');
    await page.waitForFunction(id => !document.querySelector(`[data-client-msg-id="${id}"] .media-status-departing`), id);
    for (const revealed of [false, true]) {
      await message.locator('.image-preview').first().evaluate((node, revealed) => { node.dataset.revealed = String(revealed); }, revealed);
      const original = await geometry(message.locator('.message-bubble'));
      const originalMedia = await geometry(message.locator('.image-preview').first());
      await message.dispatchEvent('contextmenu');
      const lifted = page.locator('.message-action-preview');
      await lifted.waitFor();
      await page.locator('.message-actions.is-visible').waitFor();
      sameSize(original, await geometry(lifted.locator('.message-bubble')), `${variant} lifted bubble`);
      sameSize(originalMedia, await geometry(lifted.locator('.image-preview').first()), `${variant} lifted content`);
      if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/${variant}-menu-${revealed}.png` });
      await page.evaluate(() => window.mediaFixture.app.closeMessageActions(false, false));
    }

    assert.equal(await message.locator('.message-delivery').count(), 1);
    assert.equal(await message.locator('.image-preview').first().evaluate(node => node === window.mediaFixture.preview), true);
    console.log(`${variant}: immediate bubble, concealed policy, same-ID retry, ${outcome} original(s), confirmation continuity`);
  }
  // A commit failure must retain the original selected bytes and retry in place.
  await page.evaluate(() => { const f = window.mediaFixture; f.gate.failCommit = true; f.start([f.files[1]]); });
  await page.waitForFunction(() => document.querySelector('.media-upload')?.dataset.uploadState === 'failed');
  const commitId = await page.locator('.media-upload').getAttribute('data-client-msg-id');
  await page.evaluate(() => { window.mediaFixture.gate.failCommit = false; });
  await page.locator('.media-upload').getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.media-upload'));
  assert.equal(await page.locator(`.message[data-client-msg-id="${commitId}"]`).count(), 1);
  // The actual picker callback transfers a submitted expression to runtime ownership.
  await page.evaluate(() => {
    const f = window.mediaFixture; f.gate.hold = true; f.gate.release = null;
    f.app.openMemePicker();
    const picker = f.app.memePicker;
    f.run = picker.options.send(f.files[2], true, picker.signal);
    f.app.closeMemePicker();
    if (!picker.signal.aborted) throw Error('Closing picker did not abort its own loads');
  });
  await page.waitForFunction(() => window.mediaFixture.gate.release);
  assert.equal(await page.locator('.media-upload').count(), 1);
  await page.evaluate(() => { const g = window.mediaFixture.gate; g.hold = false; g.release(); });
  await page.evaluate(() => window.mediaFixture.run);
  assert.equal(await page.locator('.media-upload').count(), 0, 'Picker closure must not cancel a submitted upload');
  // Navigation preserves a runtime upload; privacy teardown destroys it and revokes all draft URLs.
  await page.evaluate(() => {
    const f = window.mediaFixture; f.gate.hold = true; f.gate.release = null; f.start([f.files[2]], true, true);
    f.app.renderGallery(); f.app.renderChat();
  });
  await page.waitForFunction(() => window.mediaFixture.gate.release);
  await page.waitForFunction(() => document.querySelector('.media-upload img')?.complete);
  const localUrl = await page.locator('.media-upload img').getAttribute('src');
  await page.evaluate(() => { const f = window.mediaFixture; f.app.lockNow(); f.gate.release(); });
  await page.evaluate(() => window.mediaFixture.run);
  assert.equal(await page.locator('.media-upload').count(), 0);
  assert.equal(await page.evaluate(() => window.mediaFixture.app.mediaUploads.size), 0);
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, localUrl), true);
  assert.deepEqual(errors, []);
  console.log('Media upload: commit retry, navigation continuity, lock cleanup and URL revocation passed');
} finally { await browser?.close(); await server.close(); }
