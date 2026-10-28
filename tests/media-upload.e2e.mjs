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
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__media_upload`);
  await page.evaluate(async () => {
    await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities: ['reply-v2', 'file-message-v1', 'image-album-v1', 'media-dimensions-v1', 'expression-image-v1', 'expression-kind-v1'] };
    const peer = { ...own, deviceId: crypto.randomUUID(), role: 'joiner' };
    const session = await vault.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'media-upload-fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own, peer], identity: { publicBundle: own } }, 'media-upload-password', 'password');
    app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController();
    app.uiPreferencesHydrated = true; app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
    app.updateSafetyCode = async () => {}; app.unreadCounter.markRead = async () => {};
    app.connectionState = 'disconnected'; app.retryOperation = operation => operation();
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const blobs = new Map();
    const gate = { release: null, hold: true, fail: false, requests: 0, failCommit: false, failDownload: false, holdDownload: false, skipLocalPreviewCache: false, downloadRelease: null, downloadWaiters: [], downloads: 0 };
    const cacheLocalImage = app.cacheLocalImage.bind(app);
    app.cacheLocalImage = (manifest, blob, ...args) => {
      // Sending normally caches the selected File before enqueue. Cold cases
      // explicitly omit that optimization; verified downloaded Blobs still cache.
      if (gate.skipLocalPreviewCache && blob instanceof File) return;
      return cacheLocalImage(manifest, blob, ...args);
    };
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
        if (match[2] !== undefined) {
          gate.downloads++;
          if (gate.failDownload) throw Error('Synthetic failed download');
          if (gate.holdDownload) await new Promise(resolve => {
            gate.downloadWaiters.push(resolve);
            gate.downloadRelease = () => { for (const release of gate.downloadWaiters.splice(0)) release(); };
          });
          return new Response(blob.chunks.get(Number(match[2])));
        }
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
    window.mediaFixture = { app, session, own, files, gate, blobs, vault, run: null, fileFor(variant) { return variant === 'tall-photo' ? files[3] : variant === 'wide-photo' ? files[4] : variant === 'small-photo' ? files[5] : variant === 'tall-expression' || variant === 'tall-gif-expression' ? files[6] : variant.includes('expression') ? files[2] : files[0]; }, start(files, expression = false, autoHide = false, kind) { this.run = app.processImageBatch(files, 'chat', undefined, expression, undefined, autoHide, kind); } };
  });
  await page.evaluate(() => {
    const { app, session } = window.mediaFixture;
    const payload = { v: 1, kind: 'image', image: {}, presentation: 'expression', expressionKind: 'gifs' };
    if (app.payloadCapabilityError(payload)) throw Error('Upgraded devices rejected GIF classification');
    const members = session.vault.members;
    try {
      session.vault.members = members.map(member => ({ ...member, capabilities: member.capabilities.filter(value => value !== 'expression-kind-v1') }));
      if (!app.payloadCapabilityError(payload)) throw Error('Typed GIF was allowed to reach a legacy device');
      const { expressionKind, ...legacy } = payload;
      if (app.payloadCapabilityError(legacy)) throw Error('Legacy expression format lost compatibility');
    } finally { session.vault.members = members; }
  });
  const geometry = async locator => locator.evaluate(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { width: box.width, height: box.height, corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius] };
  });
  const sameSize = (before, after, label) => {
    assert.ok(Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1, `${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    assert.equal(new Set(after.corners).size, 1, `${label}: four equal corners`);
  };
  for (const variant of ['photo', 'tall-photo', 'wide-photo', 'small-photo', 'album', 'expression', 'hidden-expression', 'tall-expression', 'gif-expression', 'tall-gif-expression']) {
    await page.evaluate(variant => {
      const f = window.mediaFixture;
      f.gate.release = null; f.gate.hold = true; f.gate.fail = false;
      f.start(variant === 'album' ? f.files.slice(0, 2) : [f.fileFor(variant)], variant.includes('expression'), variant === 'hidden-expression', variant.includes('gif-') ? 'gifs' : undefined);
    }, variant);
    const draft = page.locator('.media-upload');
    await draft.waitFor();
    await page.waitForFunction(() => window.mediaFixture.gate.release);
    await page.waitForFunction(() => [...document.querySelectorAll('.media-upload-preview')].every(cell => cell.querySelector('img')?.complete));
    const id = await draft.getAttribute('data-client-msg-id');
    const uploadBox = await geometry(draft.locator('.message-bubble'));
    const uploadMediaBox = await geometry(draft.locator('.media-upload-previews'));
    assert.equal(new Set(uploadBox.corners).size, 1, 'Upload has four equal corners');
    if (variant.includes('gif-')) {
      const box = await geometry(draft.locator('.media-upload-previews'));
      const expected = variant === 'tall-gif-expression' ? { width: 64, height: 128 } : { width: 115.2, height: 115.2 };
      assert.ok(Math.abs(box.width - expected.width) < 1 && Math.abs(box.height - expected.height) < 1, `GIF not reduced to 60%: ${JSON.stringify(box)}`);
    }
    assert.equal(await draft.getAttribute('data-concealed'), String(!variant.includes('expression') || variant === 'hidden-expression'));
    assert.equal(await page.locator('#upload-progress').isVisible(), false, 'No global progress for chat media');
    assert.doesNotMatch(await page.locator('#upload-progress output').innerText(), /\d+%/, 'Hidden composer must not inherit attachment progress');
    assert.equal(await draft.getAttribute('data-upload-state'), 'uploading', 'First in-flight chunk is uploading, not preparing');
    assert.doesNotMatch(await draft.locator('.media-upload-status').innerText(), /\d+%/, 'No fabricated percentage before first completed chunk');
    if (variant === 'photo') {
      const snapshot = await draft.evaluate(row => {
        const f = window.mediaFixture, view = f.app.mediaUploads.get(row.dataset.clientMsgId).view;
        const status = row.querySelector('.media-upload-status');
        const before = status.querySelector(':scope > .media-capsule-content').offsetWidth;
        // A component-only motion probe: unknown -> known text must not stretch
        // the outgoing snapshot to the incoming label's longer width.
        view.update('uploading', 1 / 3);
        const outgoing = status.querySelector(':scope > .media-capsule-retiring > .media-capsule-content').offsetWidth;
        view.update('uploading');
        return { before, outgoing, layers: status.querySelectorAll(':scope > .media-capsule-retiring').length,
          nested: status.querySelectorAll('.media-capsule-retiring .media-capsule-retiring').length };
      });
      assert.equal(snapshot.outgoing, snapshot.before, 'Retiring label retains its intrinsic width');
      assert.equal(snapshot.layers, 1); assert.equal(snapshot.nested, 0);
    }
    assert.equal(await draft.locator('.message-delivery').count(), 0, 'Upload is not a sent message');
    const width = await draft.locator('img').first().evaluate(image => image.naturalWidth);
    assert.equal(width <= 128, !variant.includes('expression') || variant === 'hidden-expression', 'Only concealed derivatives may be painted for private media');
    await page.evaluate(() => {
      const f = window.mediaFixture;
      f.row = document.querySelector('.media-upload');
      f.shell = f.row.querySelector('.message-bubble');
      f.status = f.row.querySelector('.media-send-status');
      f.app.renderMessages();
    });
    assert.equal(await draft.evaluate(node => node === window.mediaFixture.row), true, 'Progress updates retain the row');
    await page.evaluate(() => { const g = window.mediaFixture.gate; g.fail = true; g.release(); });
    await page.waitForFunction(() => document.querySelector('.media-upload')?.dataset.uploadState === 'failed');
    assert.equal(await draft.getAttribute('data-client-msg-id'), id);
    // Measure within one renderer task: CDP's transformed quad can round its
    // two Y coordinates differently while a neighbouring row is translating.
    // Keep the layout target at least 44px; tolerate only floating-point
    // subtraction noise (e.g. 43.99994px) in the painted rectangle.
    const retryRect = await draft.getByRole('button', { name: '重试', exact: true }).evaluate(button => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height, layoutWidth: button.offsetWidth, layoutHeight: button.offsetHeight };
    });
    assert.ok(retryRect.layoutWidth >= 44 && retryRect.layoutHeight >= 44
      && retryRect.width >= 44 - 0.001 && retryRect.height >= 44 - 0.001, `${variant}: ${JSON.stringify(retryRect)}`);
    const statusGeometry = await draft.locator('.media-upload-status').evaluate(status=>({height:status.getBoundingClientRect().height,
      corners:status.querySelectorAll('.media-upload-cancel').length,
      retiring:status.querySelectorAll('.media-capsule-retiring').length}));
    assert.ok(Math.abs(statusGeometry.height-24)<.01,`${variant}: 24px process/error capsule`);
    assert.equal(statusGeometry.corners,0,'failure has no corner X');
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
    // Force two cold previews; normal sends cache their File before enqueue
    // and may complete handoff in the same task without any download request.
    const stalledExpression = variant === 'expression' || variant === 'tall-expression';
    await page.evaluate(stall => { const g = window.mediaFixture.gate; g.hold = false; g.fail = false; g.holdDownload = stall; g.skipLocalPreviewCache = stall; }, stalledExpression);
    await draft.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.media-upload').length === 0);
    const message = page.locator(`.message[data-client-msg-id="${id}"]`);
    if (variant.includes('expression')) {
      if (stalledExpression) await message.locator('.media-upload-handoff').waitFor();
      assert.equal(await message.locator('.media-upload-handoff .media-upload-status').count(), 0, 'Expression handoff has only the live message status, including while thumbnail loading is stalled');
      assert.equal(await message.locator('.message-meta').count(), 1);
      await page.evaluate(() => { const g = window.mediaFixture.gate; g.holdDownload = false; g.downloadRelease?.(); });
    }
    await message.locator('.image-preview[data-image-state="loaded"]').first().waitFor();
    assert.equal(await message.count(), 1);
    sameSize(uploadBox, await geometry(message.locator('.message-bubble')), `${variant} complete shell upload to pending`);
    assert.deepEqual(await message.evaluate(node => ({ row:node===window.mediaFixture.row,
      shell:node.querySelector('.message-bubble')===window.mediaFixture.shell,
      status:node.querySelector('.media-send-status')===window.mediaFixture.status })), {row:true,shell:true,status:true}, 'Upload commits in the original row, media shell and status slot');
    assert.equal(await message.locator('.message-meta > .media-capsule-content > time').isVisible(), false, 'Only server-confirmed media shows a send time');
    if (variant.includes('expression')) {
      const placed = await message.locator('.image-preview').evaluate(preview => {
        const media = preview.getBoundingClientRect();
        const meta = preview.parentElement.querySelector('.message-meta');
        const status = meta?.querySelector('.message-pending, .message-delivery')?.getBoundingClientRect();
        const box = meta?.getBoundingClientRect();
        return { valid: Boolean(box && status && box.top >= media.bottom - 1 && Math.abs(box.height-24)<.01),
          media: media.toJSON(), box: box?.toJSON(), status: status?.toJSON() };
      });
      assert.equal(placed.valid, true, `${variant}: fixed transparent 24px status row below the image: ${JSON.stringify(placed)}`);
    }
    if (variant !== 'album') sameSize(uploadMediaBox, await geometry(message.locator('.image-preview')), `${variant} content fills media frame`);
    assert.match(await message.locator('.message-meta').innerText(), /等待连接/);
    assert.equal(await message.locator('.message-delivery').count(), 0, '100% upload is not server confirmation');
    assert.equal(await message.locator('.image-preview').first().getAttribute('data-revealed'), String(variant.includes('expression') && variant !== 'hidden-expression'));
    const outcome = await page.evaluate(async ({ id, variant }) => {
      const f = window.mediaFixture;
      const entries = (await f.vault.loadOutbox(f.session)).filter(item => item.clientMsgId === id);
      if (entries.length !== 1) throw Error('Retry duplicated or lost message ID');
      const payload = entries[0].payload;
      if (variant.includes('gif-') && payload.expressionKind !== 'gifs') throw Error('Retry lost GIF classification');
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
      // count/evaluate calls can cross its 180ms completion and sample nothing.
      f.confirmationFade = [...document.querySelectorAll(`[data-client-msg-id="${id}"] .media-capsule-retiring`)]
        .flatMap(node => node.getAnimations().map(animation => ({ duration: animation.effect.getTiming().duration,
          keyframes: animation.effect.getKeyframes().map(frame => frame.opacity) })));
      return manifests.length;
    }, { id, variant });
    assert.equal(await message.locator('.media-send-meta').count(), 0);
    sameSize(uploadBox, await geometry(message.locator('.message-bubble')), `${variant} complete shell server confirmation`);
    assert.equal(await message.locator('.message-meta > .media-capsule-content > time').isVisible(), true, 'Time appears after server acceptance');
    await page.waitForFunction(id => !document.querySelector(`[data-client-msg-id="${id}"] .media-upload-handoff`), id);
    const animation = await page.evaluate(() => window.mediaFixture.confirmationFade);
    assert.ok(animation.some(item => item.duration === 180 && item.keyframes.join(',') === '1,0'), 'Status fades out instead of vanishing');
    await page.waitForFunction(id => !document.querySelector(`[data-client-msg-id="${id}"] .media-capsule-retiring`), id);
    if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/${variant}-confirmed.png` });
    assert.equal(await message.locator('.message-meta').evaluate(node => node.offsetHeight), 24, 'Completed receipt retains its fixed 24px layout slot');
    if (!variant.includes('expression')) assert.equal(await message.locator('.message-meta').evaluate(node => getComputedStyle(node,'::before').top), '2px', 'Completed 20px paint is centered inside the reserved 24px slot');
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
  // An actual upload with a reply and a following message must keep the entire
  // row, status anchor and reader's position through both kinds of failure.
  const continuityId = await page.evaluate(async () => {
    const f = window.mediaFixture;
    const sentAt = new Date(Date.now()-60_000).toISOString();
    const reply = {seq:1,clientMsgId:crypto.randomUUID(),senderId:f.own.deviceId,status:'stored',acceptedAt:sentAt,
      payload:{v:1,kind:'text',text:'被回复的合成消息',sentAt}};
    f.app.messages.set(1,reply); f.app.replyTarget=reply;
    f.gate.hold=true; f.gate.release=null; f.gate.fail=false; f.gate.failCommit=false;
    f.start([f.files[0]]);
    return [...f.app.mediaUploads.keys()].at(-1);
  });
  await page.waitForFunction(id => document.querySelector(`[data-client-msg-id="${id}"]`)?.dataset.poster==='ready' && window.mediaFixture.gate.release, continuityId);
  await page.evaluate(async id => {
    const f = window.mediaFixture;
    const followingId=crypto.randomUUID();
    await f.app.enqueuePayload({v:1,kind:'text',text:'不应跳动的后续消息',sentAt:new Date().toISOString()},followingId);
    f.app.renderMessages({scroll:'bottom'});
    const finite=[...document.querySelectorAll('#message-list .message')].flatMap(row=>row.getAnimations({subtree:true})).filter(a=>a.effect?.getTiming().iterations!==Infinity);
    await Promise.allSettled(finite.map(a=>a.finished));
    f.continuityRow=document.querySelector(`[data-client-msg-id="${id}"]`);
    f.continuityStatus=f.continuityRow.querySelector('.media-send-status');
    f.continuityDate=[...document.querySelectorAll('#message-list > .message-date')].at(-1);
    f.following=document.querySelector(`[data-client-msg-id="${followingId}"]`);
    f.samples=[]; f.sampleContinuity=true;
    const sample=()=>{
      if(!f.sampleContinuity)return;
      if(f.samples.length<600) f.samples.push([...f.continuityRow.querySelectorAll('.message-bubble,.media-send-status'),f.following].map(node=>{
        const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height];
      }));
      requestAnimationFrame(sample);
    };
    sample();
  },continuityId);
  const continuity = page.locator(`.message[data-client-msg-id="${continuityId}"]`);
  assert.equal(await continuity.locator('.message-reply-quote').count(),1,'Reply geometry is present before upload finishes');
  await page.evaluate(()=>{const f=window.mediaFixture;f.gate.fail=true;f.gate.release();});
  await page.waitForFunction(()=>window.mediaFixture.continuityRow.dataset.uploadState==='failed');
  await page.evaluate(()=>{const g=window.mediaFixture.gate;g.fail=false;g.hold=false;g.failCommit=true;});
  await continuity.getByRole('button',{name:'重试',exact:true}).click();
  await page.waitForFunction(()=>window.mediaFixture.continuityRow.dataset.failureStage==='message');
  const completedUploads=await page.evaluate(()=>window.mediaFixture.gate.requests);
  await page.evaluate(()=>{window.mediaFixture.gate.failCommit=false;});
  await continuity.getByRole('button',{name:'重试',exact:true}).click();
  await page.waitForFunction(()=>!window.mediaFixture.continuityRow.classList.contains('media-upload'));
  assert.equal(await page.evaluate(()=>window.mediaFixture.gate.requests),completedUploads,'Media submission failure reuses uploaded bytes');
  assert.equal(await continuity.locator('.message-meta > .media-capsule-content > time').isVisible(),false);
  await page.evaluate(async id=>{
    const f=window.mediaFixture;
    f.app.pending.get(id).status='stored';f.app.renderMessages();
    await Promise.allSettled([...f.continuityStatus.getAnimations({subtree:true})].filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));
    await new Promise(resolve=>requestAnimationFrame(resolve));f.sampleContinuity=false;
  },continuityId);
  const geometryProof=await page.evaluate(id=>{
    const f=window.mediaFixture,base=f.samples[0];
    return {samples:f.samples.length,maxDelta:Math.max(...f.samples.flatMap(sample=>sample.flatMap((r,i)=>r.map((value,j)=>Math.abs(value-base[i][j]))))),
      sameRow:document.querySelector(`[data-client-msg-id="${id}"]`)===f.continuityRow,
      sameStatus:f.continuityRow.querySelector('.media-send-status')===f.continuityStatus,
      sameDate:[...document.querySelectorAll('#message-list > .message-date')].at(-1)===f.continuityDate};
  },continuityId);
  assert.ok(geometryProof.samples>2&&geometryProof.maxDelta<1,`Full row, reply, status and neighbour moved: ${JSON.stringify(geometryProof)}`);
  assert.equal(geometryProof.sameRow&&geometryProof.sameStatus&&geometryProof.sameDate,true,JSON.stringify(geometryProof));
  assert.equal(await continuity.locator('.message-meta > .media-capsule-content > time').isVisible(),true);
  console.log('Whole-row/reply/neighbour continuity:',geometryProof);

  // Each ordinary file owns a fresh attempt, even after media reached 100%.
  await page.evaluate(() => {
    const f = window.mediaFixture; f.gate.hold = true; f.gate.release = null;
    f.file = new File([new Uint8Array(3 * 1024 * 1024)], 'independent.bin', { type: 'application/octet-stream', lastModified: 42 });
    f.start([f.file]);
  });
  await page.waitForFunction(() => window.mediaFixture.gate.release);
  const fileDraft = page.locator('.file-upload');
  const fileId = await fileDraft.getAttribute('data-client-msg-id');
  assert.equal(await fileDraft.locator('.file-attachment-name').textContent(), 'independent.bin');
  assert.equal(await fileDraft.getAttribute('data-upload-state'), 'uploading');
  assert.doesNotMatch(await fileDraft.locator('.media-upload-status').innerText(), /\d+%/);
  assert.equal(await page.locator('#upload-progress').isVisible(), false);
  await page.evaluate(() => { const g = window.mediaFixture.gate; g.fail = true; g.hold = false; g.release(); });
  await page.waitForFunction(() => document.querySelector('.file-upload')?.dataset.uploadState === 'failed');
  if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/file-failed.png` });
  await page.evaluate(() => { const g = window.mediaFixture.gate; g.fail = false; g.failCommit = true; });
  await fileDraft.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.file-upload')?.dataset.failureStage === 'message');
  const uploadRequests = await page.evaluate(() => window.mediaFixture.gate.requests);
  await page.evaluate(() => { window.mediaFixture.gate.failCommit = false; });
  await fileDraft.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.file-upload'));
  assert.equal(await page.evaluate(() => window.mediaFixture.gate.requests), uploadRequests, 'Submission retry must not repeat uploads');
  const fileMessage = page.locator(`.message[data-client-msg-id="${fileId}"]`);
  assert.equal(await fileMessage.count(), 1);
  if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/file-pending.png` });
  await page.evaluate(async id => {
    const f = window.mediaFixture;
    const entries = (await f.vault.loadOutbox(f.session)).filter(item => item.clientMsgId === id);
    if (entries.length !== 1) throw Error('File retry duplicated message');
    const { decryptFileAttachment } = await import('/src/lib/file-crypto.ts');
    const restored = await decryptFileAttachment(entries[0].payload.file, async (blobId, index) => f.blobs.get(blobId).chunks.get(index).buffer);
    if (restored.size !== f.file.size || new Uint8Array(await restored.arrayBuffer()).some(value => value !== 0)) throw Error('File original bytes changed');
    f.app.connectionState = 'disconnected'; f.app.renderMessages();
  }, fileId);
  assert.match(await fileMessage.locator('.message-meta').innerText(), /等待连接/);
  await page.evaluate(() => { const f = window.mediaFixture; f.app.connectionState = 'connected'; f.app.renderMessages(); });
  assert.match(await fileMessage.locator('.message-meta').innerText(), /发送中/);
  // A failed received image, album cell or expression must rebuild its live
  // ring on retry, retain the capsule/ID and complete real decryption.
  for (const kind of ['image', 'image-album', 'expression']) {
    const id = await page.evaluate(async kind => {
      const f = window.mediaFixture;
      const source = [...f.app.pending.values()].find(message => kind === 'expression'
        ? message.payload.presentation === 'expression' : message.payload.kind === kind && !message.payload.presentation);
      const manifests = source.payload.images ?? [source.payload.image];
      for (const manifest of manifests) {
        const cached = f.app.imageCache.get(manifest.blobId);
        if (cached) for (const key of ['url','posterUrl','concealedUrl']) if (cached[key]) URL.revokeObjectURL(cached[key]);
        f.app.imageCache.delete(manifest.blobId);
        // Earlier cold handoffs now populate the authenticated persistent
        // preview/chunk cache too. This case specifically injects network failure.
        await f.vault.deleteCachedMediaBlob(f.session, manifest.blobId);
      }
      f.app.renderedMessages.delete(source.clientMsgId);
      f.gate.failDownload = true; f.app.renderMessages();
      const button = document.querySelector(`[data-client-msg-id="${source.clientMsgId}"] .image-preview`);
      f.retryButton = button; f.retryManifest = manifests[0];
      void f.app.hydrateImagePreview(button, manifests[0]);
      return source.clientMsgId;
    }, kind);
    const preview = page.locator(`[data-client-msg-id="${id}"] .image-preview`).first();
    await page.waitForFunction(id => document.querySelector(`[data-client-msg-id="${id}"] .image-preview`)?.dataset.imageState === 'error', id);
    await page.evaluate(() => {
      const f = window.mediaFixture; f.retryCapsule = f.retryButton.querySelector('.media-load-capsule');
      f.gate.failDownload = false; f.gate.holdDownload = true; f.gate.downloadRelease = null;
    });
    await preview.scrollIntoViewIfNeeded();
    await preview.click();
    await page.waitForFunction(() => window.mediaFixture.gate.downloadRelease);
    assert.equal(await preview.getAttribute('aria-busy'), 'true');
    assert.equal(await preview.locator('.media-load-capsule > .media-capsule-content > .media-load-progress').count(), 1, 'Retry restores the removed live progress ring');
    assert.equal(await preview.locator('.is-error').count(), 0);
    assert.equal(await preview.locator('.media-load-capsule').evaluate(node => node === window.mediaFixture.retryCapsule), true);
    await page.evaluate(() => { const g = window.mediaFixture.gate; g.holdDownload = false; g.downloadRelease(); });
    await page.waitForFunction(id => document.querySelector(`[data-client-msg-id="${id}"] .image-preview`)?.dataset.imageState === 'loaded', id);
    assert.equal(await preview.getAttribute('aria-busy'), 'false');
    assert.equal(await preview.getAttribute('data-revealed'), String(kind === 'expression'));
    console.log(`${kind}: cold download failure and same-capsule retry passed`);
  }
  console.log('File scoped progress, submission-only retry, offline labels and image/album/expression download retries passed');
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
