import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Only synthetic messages and in-memory media are used. This fixture does not
// start the application, join a room, send messages, or access production data.
const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'message-timeline-fixture', configureServer(vite) {
    vite.middlewares.use('/__message_timeline', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    });
  } }],
});
const visualQaDirectory = process.argv[2];
const results = {};
const errors = [];
let browser;

async function initializeTimeline() {
  // Preserve the application's cascade order, independently of network timing.
  await import('/src/styles.css');
  await import('/src/chat-layout.css');
  await import('/src/gallery.css');
  await import('/src/auth-recovery.css');
  await import('/src/chat-interactions.css');
  await import('/src/cover.css');
  await import('/src/voice-messages.css');
  await import('/src/call.css');
  const { QuietRoomApp } = await import('/src/app.ts');
  const { createVault } = await import('/src/lib/vault.ts');
  const member = { deviceId: 'timeline-own', role: 'creator', status: 'active', capabilities: ['image-album-v1', 'voice-message-v1', 'file-message-v1', 'message-reactions-v1'] };
  const peer = { ...member, deviceId: 'timeline-peer', role: 'joiner' };
  const session = await createVault({ v: 1, roomId: 'message-timeline-test-only', accessToken: 'test-only', role: 'creator', protocol: 'legacy-v1', lastSeq: 200, members: [member, peer], identity: { publicBundle: member } }, 'synthetic-timeline-test-passphrase', 'password');
  const app = new QuietRoomApp(document.querySelector('#app'));
  const reads = [];
  app.updateSafetyCode = async () => {};
  app.updateBackgroundNotificationControl = async () => {};
  app.mountChatImageObserver = () => {};
  app.mountGalleryThumbnails = () => {};
  app.scheduleUiPreferencesSave = () => {};
  app.flushUiPreferencesSave = () => {};
  app.unreadCounter.markRead = async (_vault, seq) => { reads.push(seq); };
  const year = new Date().getFullYear();
  const local = (y, month, day, hour = 12, minute = 0) => new Date(y, month - 1, day, hour, minute).toISOString();
  const sentAt = local(year, 9, 4);
  const message = (seq, text = `合成消息 ${seq}`, time = sentAt, own = false) => ({
    seq, clientMsgId: `timeline-${seq}`, senderId: own ? member.deviceId : peer.deviceId,
    payload: { v: 1, kind: 'text', text, sentAt: time },
    // Deliberately different: separators must derive from authenticated payload time.
    acceptedAt: local(year, 10, 20), status: 'delivered',
  });
  const settle = async () => {
    await Promise.all([...document.querySelectorAll('#message-list img')].map(image => image.decode()));
    // Let image decoding, ResizeObserver delivery, and the viewport sampler
    // each complete; do not repair the app's scroll position in the fixture.
    for (let frame = 0; frame < 6; frame++) await new Promise(requestAnimationFrame);
  };
  const fresh = () => {
    app.lockNow();
    app.session = session; app.privacyCovered = false;
    app.runtimeEpoch += 1; app.runtimeAbort = new AbortController();
    app.messages = new Map(); app.pending = new Map(); app.reactionHistory = new Map();
    app.uiPreferences = { recoveryReminderDismissed: true }; app.restoreChatAnchorOnNextRender = false;
    reads.length = 0;
    app.renderChat();
  };
  const show = async (messages, scroll = 'bottom') => {
    app.messages = new Map(messages.map(item => [item.seq, item]));
    app.renderMessages({ scroll }); await settle();
  };
  const imageBlob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="600" height="360" fill="#b1d6e0"/><circle cx="470" cy="80" r="40" fill="#f8e9a8"/><path d="M0 280 160 120 330 290 460 190 600 310V360H0Z" fill="#386c70"/><path d="M0 315Q180 270 350 325T600 305V360H0Z" fill="#76adb0"/></svg>'], { type: 'image/svg+xml' });
  const imageManifest = { v: 1, blobId: 'timeline-synthetic-image', originalName: '合成山海.svg', originalSize: imageBlob.size, mimeType: imageBlob.type };
  const warmImage = id => {
    app.cacheLocalImage(imageManifest, imageBlob);
    Object.assign(app.imageCache.get(imageManifest.blobId), { width: 600, height: 360 });
    app.chatRevealedAssets.add(`${id}:${imageManifest.blobId}`);
  };
  const specimens = kind => {
    if (kind === 'extremes') return [[8, 1200], [1200, 8]].map(([width, height], index) => {
      const item = message(9 + index, '', sentAt, true);
      const blob = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#267d8e"/><rect width="${width / 2}" height="${height / 2}" fill="#f1bc66"/></svg>`], { type: 'image/svg+xml' });
      const image = { v: 1, blobId: `timeline-extreme-${width}-${height}`, originalName: `合成比例-${width}×${height}.svg`, originalSize: blob.size, mimeType: blob.type };
      app.cacheLocalImage(image, blob);
      Object.assign(app.imageCache.get(image.blobId), { width, height });
      app.chatRevealedAssets.add(`${item.clientMsgId}:${image.blobId}`);
      item.payload = { v: 1, kind: 'image', image, sentAt };
      return item;
    });
    if (kind === 'text') {
      const target = message(1, '好', sentAt, true);
      const long = message(2, '这是一条合成的长消息，用于检查文字换行后，时间和送达标记仍然在气泡内。ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 不应遮挡最后一行正文。');
      const multiline = message(3, '第一行是行程说明\n第二行保留主动换行\n第三行结束。', sentAt, true);
      const reply = message(4, '收到，我们就在这里见。', sentAt, true);
      reply.payload = { ...reply.payload, v: 2, replyTo: { clientMsgId: target.clientMsgId, serverSeq: target.seq, senderId: target.senderId, kind: 'text', preview: '文字消息' } };
      return [target, long, multiline, reply];
    }
    const image = message(5, '', sentAt, true);
    image.payload = { v: 1, kind: 'image', image: imageManifest, sentAt }; warmImage(image.clientMsgId);
    const audio = message(6);
    audio.payload = { v: 1, kind: 'audio', audio: { v: 1, blobId: 'timeline-synthetic-audio', originalName: '合成语音.wav', originalSize: 48044, mimeType: 'audio/wav' }, durationMs: 12000, waveform: Array.from({ length: 48 }, (_, index) => index * 17 % 80 + 20), sentAt };
    const file = message(7, '', sentAt, true);
    file.payload = { v: 1, kind: 'file', file: { v: 1, blobId: 'timeline-synthetic-file', originalName: '旅行安排与备份说明（合成测试）.pdf', originalSize: 128000, mimeType: 'application/pdf' }, sentAt };
    const failed = { ...image, seq: 8, clientMsgId: 'timeline-8', status: 'failed' }; warmImage(failed.clientMsgId);
    return [image, audio, file, failed];
  };
  window.timeline = { app, reads, year, local, sentAt, message, fresh, show, settle, specimens, imageManifest };
  fresh();
}

try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const url = `http://localhost:${server.httpServer.address().port}/__message_timeline`;
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai', hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(url); await mobile.evaluate(initializeTimeline);

  results.localDates = await mobile.evaluate(async () => {
    const { fresh, show, message, year, local } = window.timeline; fresh();
    const messages = [
      message(1, '跨年前', local(year - 1, 12, 31, 23, 59)),
      message(2, '跨年后', local(year, 1, 1, 0, 1)),
      message(3, '午夜前', local(year, 9, 4, 23, 59)),
      message(4, '午夜后', local(year, 9, 5, 0, 1)),
      message(5, '设备时间回退，同一个日期不重复', local(year, 9, 4, 20)),
      message(6, '同日继续', local(year, 9, 4, 21)),
    ];
    await show(messages);
    const list = document.querySelector('#message-list');
    const actual = [...list.querySelectorAll(':scope > .message-date')].map(separator => ({ key: separator.dataset.dateKey, dateTime: separator.querySelector('time')?.dateTime, label: separator.textContent, next: separator.nextElementSibling?.dataset.clientMsgId }));
    const expected = [
      { key: `${year - 1}-12-31`, label: `${year - 1}年12月31日`, next: 'timeline-1' },
      { key: `${year}-01-01`, label: '1月1日', next: 'timeline-2' },
      { key: `${year}-09-04`, label: '9月4日', next: 'timeline-3' },
      { key: `${year}-09-05`, label: '9月5日', next: 'timeline-4' },
    ].map(item => ({ ...item, dateTime: item.key }));
    for (const [index, item] of expected.entries()) {
      const found = actual[index];
      if (!found || Object.keys(item).some(key => found[key] !== item[key])) throw Error(`Local date ${index}: ${JSON.stringify({ expected: item, actual: found })}`);
    }
    if (actual.length !== expected.length) throw Error(`Repeated or extraneous date separators: ${JSON.stringify(actual)}`);
    const ids = [...list.querySelectorAll(':scope > article.message')].map(node => node.dataset.clientMsgId);
    if (ids.join() !== messages.map(item => item.clientMsgId).join()) throw Error('Date grouping reordered the server sequence');
    if ([...list.children].some(node => !node.matches('article.message, div.message-date'))) throw Error('Unexpected timeline child');
    return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, dates: actual, sequencePreserved: true };
  });

  results.prependAnchor = await mobile.evaluate(async () => {
    const { app, fresh, message, show, settle, sentAt } = window.timeline; fresh();
    const messages = Array.from({ length: 60 }, (_, index) => message(index + 21, `用于定位的历史消息 ${index + 21}\n阅读位置应保留。`, sentAt));
    await show(messages);
    const list = document.querySelector('#message-list');
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    document.querySelector('[data-client-msg-id="timeline-45"]').scrollIntoView({ block: 'center', behavior: 'instant' });
    await settle();
    const anchor = app.captureChatAnchor(false, true);
    if (!anchor || anchor.pinnedToBottom || anchor.seq <= 21) throw Error(`Fixture did not establish an interior reading anchor: ${JSON.stringify(anchor)}`);
    const target = document.querySelector(`[data-client-msg-id="${anchor.clientMsgId}"]`);
    const before = target.getBoundingClientRect().top;
    const separator = list.querySelector('.message-date');
    for (let seq = 1; seq <= 20; seq++) app.messages.set(seq, message(seq));
    app.renderMessages({ scroll: 'preserve' }); await settle();
    const after = target.getBoundingClientRect().top;
    if (Math.abs(after - before) > 2) throw Error(`Prepending same-day history moved the reading anchor: ${JSON.stringify({ anchor, before, after })}`);
    if (list.querySelectorAll('.message-date').length !== 1 || separator !== list.firstElementChild || separator.nextElementSibling?.dataset.clientMsgId !== 'timeline-1') throw Error('Same-day prepend duplicated or stranded the separator');
    if (app.captureChatAnchor(false, true)?.clientMsgId !== anchor.clientMsgId) throw Error('Date divider became the reading anchor');
    return { anchor: anchor.clientMsgId, displacement: after - before, separatorReused: true };
  });

  results.nonChatDatesAndRead = await mobile.evaluate(async () => {
    const { app, fresh, show, message, reads, year, local, imageManifest } = window.timeline; fresh();
    const real = [message(1), message(2), message(3)];
    const hiddenTime = local(year, 11, 20);
    const galleryImage = { ...message(101), payload: { v: 1, kind: 'gallery-image', image: imageManifest, sentAt: hiddenTime } };
    const galleryFile = { ...message(102), payload: { v: 1, kind: 'gallery-file', file: { v: 1, blobId: 'gallery-test-only', originalName: '合成文件.txt', originalSize: 1, mimeType: 'text/plain' }, sentAt: hiddenTime } };
    const reaction = { ...message(103), payload: { v: 1, kind: 'reaction', target: { clientMsgId: real[0].clientMsgId, serverSeq: 1, senderId: real[0].senderId }, emoji: '👍', sentAt: hiddenTime } };
    await show([...real, galleryImage, galleryFile, reaction]);
    app.markVisibleMessagesRead();
    if (document.querySelectorAll('#message-list > article.message').length !== 3 || document.querySelectorAll('#message-list > .message-date').length !== 1) throw Error('Gallery or reaction events contributed timeline rows or dates');
    if (!reads.includes(3) || reads.some(seq => seq > 3)) throw Error(`Non-chat events or dividers advanced the visible read boundary: ${JSON.stringify(reads)}`);
    return { realMessages: 3, dateSeparators: 1, maxVisibleReadSeq: Math.max(...reads) };
  });

  results.receiptsAndSelection = await mobile.evaluate(async () => {
    const { app, fresh, message, settle } = window.timeline; fresh();
    const pending = { ...message(Number.MAX_SAFE_INTEGER, '同一条消息在确认、送达时保留原节点。\n选择文字也应留在原位。', undefined, true), clientMsgId: 'timeline-pending', status: 'pending' };
    app.pending.set(pending.clientMsgId, pending); app.renderMessages({ scroll: 'bottom' }); await settle();
    const article = document.querySelector('[data-client-msg-id="timeline-pending"]');
    const bubble = article.querySelector('.message-bubble');
    const date = document.querySelector('.message-date');
    if (article.querySelector('.message-delivery')) throw Error('Pending message prematurely displayed a success check');
    const text = article.querySelector('.message-text');
    const before = text.getBoundingClientRect();
    app.openMessageTextSelection(pending); await settle();
    const selection = article.querySelector('textarea.message-text-selection');
    if (!selection || selection.value !== pending.payload.text) throw Error('Explicit text selection was lost');
    const selectedBounds = selection.getBoundingClientRect();
    for (const key of ['x', 'y', 'width', 'height']) if (Math.abs(selectedBounds[key] - before[key]) > 1) throw Error(`Selecting text changed ${key}: ${before[key]} -> ${selectedBounds[key]}`);
    selection.setSelectionRange(2, 12);
    app.pending.delete(pending.clientMsgId);
    const confirmed = { ...pending, seq: 1, payload: structuredClone(pending.payload), status: 'stored' };
    app.messages.set(1, confirmed); app.renderMessages({ scroll: 'position' }); await settle();
    const assertIdentity = () => {
      if (article !== document.querySelector('[data-client-msg-id="timeline-pending"]') || bubble !== article.querySelector('.message-bubble') || selection !== article.querySelector('textarea') || date !== document.querySelector('.message-date')) throw Error('Receipt upgrade replaced live content or date nodes');
      if (selection.selectionStart !== 2 || selection.selectionEnd !== 12) throw Error('Receipt upgrade changed text selection range');
    };
    assertIdentity();
    if (article.querySelectorAll('.message-delivery path').length !== 1 || article.querySelector('.message-delivery')?.dataset.state !== 'sent') throw Error('Stored message did not upgrade to one sent check');
    if (!article.querySelector('.message-meta').title.includes('服务器已保存加密消息')) throw Error('Sent status lost its server-storage meaning');
    app.messages.set(1, { ...confirmed, status: 'delivered' }); app.renderMessages({ scroll: 'position' }); await settle();
    assertIdentity();
    if (article.querySelectorAll('.message-delivery path').length !== 2 || !article.querySelector('.message-meta').title.includes('对方至少一台设备已验证并保存')) throw Error('Delivered status lost its verified-device meaning');
    const finalBounds = selection.getBoundingClientRect();
    for (const key of ['x', 'y', 'width', 'height']) if (Math.abs(finalBounds[key] - selectedBounds[key]) > 1) throw Error(`Receipt upgrade moved selected text ${key}`);
    app.clearMessageTextSelection();
    return { pendingToStoredToDelivered: true, messageAndDateNodesPreserved: true, selectionGeometryPreserved: true };
  });

  results.shortReceiptGeometry = await mobile.evaluate(async () => {
    const { app, fresh, message, settle } = window.timeline; fresh();
    const pending = { ...message(Number.MAX_SAFE_INTEGER, '好', undefined, true), clientMsgId: 'timeline-short', status: 'pending' };
    app.pending.set(pending.clientMsgId, pending); app.renderMessages({ scroll: 'bottom' }); await settle();
    const article = document.querySelector('[data-client-msg-id="timeline-short"]');
    const bubble = article.querySelector('.message-bubble');
    const initial = bubble.getBoundingClientRect();
    const meta = bubble.querySelector('.message-meta');
    if (!meta.querySelector('.message-pending svg') || meta.querySelector('.message-pending .sr-only')?.textContent !== '等待发送' || !meta.getAttribute('aria-label')?.includes('已保存在本机，等待发送到服务器') || meta.querySelector('.message-delivery')) throw Error('Pending clock lost its waiting semantics or appeared as a success receipt');
    app.pending.delete(pending.clientMsgId);
    for (const status of ['stored', 'delivered']) {
      app.messages.set(1, { ...pending, seq: 1, payload: structuredClone(pending.payload), status });
      app.renderMessages({ scroll: 'position' }); await settle();
      const current = bubble.getBoundingClientRect();
      if (article !== document.querySelector('[data-client-msg-id="timeline-short"]') || bubble !== article.querySelector('.message-bubble')) throw Error('Short receipt upgrade replaced the live bubble');
      for (const key of ['x', 'y', 'width', 'height']) if (Math.abs(current[key] - initial[key]) > 1) throw Error(`Short ${status} receipt changed bubble ${key}: ${initial[key]} -> ${current[key]}`);
      if (meta.querySelector('.message-pending') || meta.querySelectorAll('.message-delivery path').length !== (status === 'stored' ? 1 : 2)) throw Error(`Short ${status} receipt did not upgrade its marker`);
    }
    return { text: '好', pendingSemantics: 'waiting', upgrades: ['stored', 'delivered'], geometryPreserved: true };
  });

  await mobile.evaluate(async () => {
    const { app, fresh, show, specimens } = window.timeline; fresh();
    await show(specimens('attachments').filter(message => message.status === 'failed'));
    window.timeline.retry = { attempts: [], original: app.attemptSend };
    app.attemptSend = async id => { window.timeline.retry.attempts.push(id); };
  });
  await mobile.locator('.message-retry').click();
  results.retryIdentity = await mobile.evaluate(async () => {
    const { app, retry, settle } = window.timeline; await settle();
    app.attemptSend = retry.original;
    const articles = [...document.querySelectorAll('#message-list > article.message')];
    if (retry.attempts.length !== 1 || retry.attempts[0] !== 'timeline-8' || articles.length !== 1 || articles[0].dataset.clientMsgId !== 'timeline-8' || !articles[0].classList.contains('is-pending') || app.messages.get(8)?.status !== 'pending') throw Error(`Retry did not reuse the existing message identity: ${JSON.stringify({ attempts: retry.attempts, rows: articles.map(article => article.dataset.clientMsgId), status: app.messages.get(8)?.status })}`);
    if (document.querySelector('.message-retry') || document.querySelector('.message-delivery')) throw Error('Retry retained a failed action or prematurely displayed a delivery check');
    return { clientMsgId: retry.attempts[0], attemptCount: 1, status: 'pending', rows: 1 };
  });

  await mobile.emulateMedia({ reducedMotion: 'no-preference' });
  results.midnightMotion = await mobile.evaluate(async () => {
    const { app, fresh, show, message, year, local } = window.timeline; fresh();
    await show(Array.from({ length: 30 }, (_, index) => message(index + 1, '午夜前的合成历史', local(year, 9, 4, 23, 59))));
    app.messages.set(31, message(31, '午夜后的第一条消息', local(year, 9, 5, 0, 1), true));
    app.renderMessages({ scroll: 'send' });
    const date = document.querySelector(`[data-date-key="${year}-09-05"]`);
    const bubble = document.querySelector('[data-client-msg-id="timeline-31"] > .message-bubble');
    const animations = [...app.chatMessageAnimations];
    const dateAnimation = animations.find(animation => animation.effect.target === date);
    const bubbleAnimation = animations.find(animation => animation.effect.target === bubble);
    if (!dateAnimation || !bubbleAnimation) throw Error(`Cross-midnight send omitted coordinated date/message motion: ${JSON.stringify({ count: animations.length, date: Boolean(dateAnimation), bubble: Boolean(bubbleAnimation), followPending: app.chatBottomFollowPending })}`);
    const dateFrames = dateAnimation.effect.getKeyframes();
    const bubbleFrames = bubbleAnimation.effect.getKeyframes();
    if (dateFrames[0].translate !== bubbleFrames[0].translate || dateAnimation.effect.getTiming().duration !== 300 || bubbleAnimation.effect.getTiming().duration !== 300) throw Error('Date and message did not share the send offset and 300ms duration');
    await Promise.all(animations.map(animation => animation.finished));
    if (app.chatMessageAnimations.size !== 0 || date.getAnimations().some(animation => animations.includes(animation))) throw Error('Completed send motion retained date/message animations');
    return { offset: dateFrames[0].translate, duration: 300, coordinated: true, finishedAnimations: 0 };
  });
  await mobile.emulateMedia({ reducedMotion: 'reduce' });
  results.reducedMidnightMotion = await mobile.evaluate(async () => {
    const { app, fresh, show, message, year, local } = window.timeline; fresh();
    await show([message(1, '午夜前', local(year, 9, 4, 23, 59))]);
    app.messages.set(2, message(2, '午夜后', local(year, 9, 5, 0, 1), true));
    app.renderMessages({ scroll: 'send' });
    if (app.chatMessageAnimations.size !== 0 || document.querySelector(`[data-date-key="${year}-09-05"]`).getAnimations().length) throw Error('Reduced motion still animated the new date separator');
    return { animations: 0 };
  });

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
  desktop.on('pageerror', error => errors.push(error.message));
  await desktop.goto(url); await desktop.evaluate(initializeTimeline);
  const configurations = [
    { name: '320-light', width: 320, height: 740, scheme: 'light', font: 16 },
    { name: '320-dark', width: 320, height: 740, scheme: 'dark', font: 16 },
    { name: '390-light', width: 390, height: 844, scheme: 'light', font: 16 },
    { name: '390-dark', width: 390, height: 844, scheme: 'dark', font: 16 },
    { name: 'desktop-light', width: 1280, height: 900, scheme: 'light', font: 16, desktop: true },
    { name: 'desktop-dark', width: 1280, height: 900, scheme: 'dark', font: 16, desktop: true },
    { name: '320-large-light', width: 320, height: 740, scheme: 'light', font: 20 },
    { name: '320-large-dark', width: 320, height: 740, scheme: 'dark', font: 20 },
  ];
  if (visualQaDirectory) await mkdir(visualQaDirectory, { recursive: true });
  results.layouts = [];
  for (const configuration of configurations) {
    const page = configuration.desktop ? desktop : mobile;
    await page.bringToFront();
    await page.setViewportSize({ width: configuration.width, height: configuration.height });
    await page.emulateMedia({ colorScheme: configuration.scheme, reducedMotion: 'reduce' });
    await page.evaluate(({ scheme, font }) => {
      document.documentElement.dataset.colorScheme = scheme;
      document.documentElement.style.setProperty('font-size', `${font}px`, 'important');
    }, configuration);
    // Existing controls can still be finishing a theme-color transition when
    // emulateMedia changes. Capture settled colors, never an intermediate mix.
    await page.waitForTimeout(220);
    for (const kind of ['text', 'attachments', 'extremes']) {
      const geometry = await page.evaluate(async ({ kind, name, font }) => {
        const { app, fresh, show, specimens } = window.timeline; fresh();
        await show(specimens(kind));
        if (parseFloat(getComputedStyle(document.documentElement).fontSize) !== font) throw Error(`${name}: fixture root font ${JSON.stringify({ requested: font, inline: document.documentElement.style.cssText, computed: getComputedStyle(document.documentElement).fontSize })}`);
        const issues = [];
        const boxes = [];
        const composer = document.querySelector('#composer');
        const composerBox = composer?.getBoundingClientRect();
        if (!document.body.classList.contains('app-mode') || !composerBox || composerBox.height < 44 || composerBox.top >= innerHeight || composerBox.bottom < 1 || getComputedStyle(composer).visibility !== 'visible') issues.push('fixture did not present the chat composer');
        const latest = document.querySelector('#message-list > article.message:last-child');
        const latestGap = composerBox.top - latest.getBoundingClientRect().bottom;
        const scrollState = { pinned: app.chatPinnedToBottom, gap: latestGap, remainingScroll: app.chatBottomGap(), scrollY, scrollHeight: document.documentElement.scrollHeight, intent: app.chatScrollIntent, followPending: app.chatBottomFollowPending, restoringAnchor: Boolean(app.chatRestoreAnchor) };
        if (app.chatPinnedToBottom) {
          if (Math.abs(latestGap - 64) > 2) issues.push(`pinned latest message lost its 64px composer gap: ${JSON.stringify(scrollState)}`);
        } else issues.push(`show(bottom) lost bottom following without user scrolling: ${JSON.stringify(scrollState)}`);
        const bodyColor = getComputedStyle(document.body).color;
        for (const article of document.querySelectorAll('#message-list > article.message')) {
          const id = article.dataset.clientMsgId;
          const bubble = article.querySelector(':scope > .message-bubble');
          const meta = bubble.querySelector(':scope > .message-meta');
          if (!meta || article.querySelector(':scope > .message-meta')) { issues.push(`${id}: metadata outside bubble`); continue; }
          const b = bubble.getBoundingClientRect(); const m = meta.getBoundingClientRect();
          const content = bubble.querySelector('.message-text');
          if (article.classList.contains('incoming') && content && getComputedStyle(content).color !== bodyColor) issues.push(`${id}: incoming text color did not settle with the current theme`);
          if (b.left < -1 || b.right > innerWidth + 1 || m.left < b.left - 1 || m.right > b.right + 1 || m.top < b.top - 1 || m.bottom > b.bottom + 1) issues.push(`${id}: bubble or metadata overflow`);
          const style = getComputedStyle(meta);
          if (Math.abs(parseFloat(style.fontSize) - font * 11 / 16) > .1) issues.push(`${id}: metadata font is not 11px at default size or its accessible scaled equivalent`);
          if (style.justifyContent !== 'flex-end' || style.textAlign !== 'right') issues.push(`${id}: metadata not right aligned`);
          const icon = meta.querySelector('.message-delivery svg');
          if (icon && Math.abs(icon.getBoundingClientRect().width - font * 11 / 16 * 1.45) > .5) issues.push(`${id}: delivery glyph is not approximately 16px at default size or its accessible scaled equivalent`);
          const mediaOverlay = bubble.classList.contains('image-bubble') && !article.classList.contains('is-failed');
          if (mediaOverlay) {
            if (style.position !== 'absolute' || style.backgroundColor === 'transparent' || style.backgroundColor === 'rgba(0, 0, 0, 0)' || b.right - m.right > 12 || b.bottom - m.bottom > 12) issues.push(`${id}: media metadata lost its contrasting bottom-right overlay`);
            if (kind === 'extremes') {
              const image = bubble.querySelector('img');
              const imageBox = image.getBoundingClientRect();
              const preview = bubble.querySelector('.image-preview').getBoundingClientRect();
              const expectedHeight = imageBox.width * image.naturalHeight / image.naturalWidth;
              if (Math.abs(imageBox.height - expectedHeight) > Math.max(.04, expectedHeight * .015) || imageBox.left < preview.left - 1 || imageBox.right > preview.right + 1 || imageBox.top < preview.top - 1 || imageBox.bottom > preview.bottom + 1) issues.push(`${id}: extreme original aspect ratio was distorted or clipped`);
              if (preview.height < 64 || b.width < Math.min(font * 11, article.getBoundingClientRect().width) - 1) issues.push(`${id}: extreme media has no safe space for metadata`);
            }
          } else {
            for (const content of [...bubble.children].filter(child => child !== meta)) {
              if (content.getBoundingClientRect().bottom > m.top + 1) issues.push(`${id}: metadata overlaps ${content.className}`);
            }
          }
          const retry = meta.querySelector('.message-retry');
          if (retry) {
            const r = retry.getBoundingClientRect();
            if (r.width < 44 || r.height < 44 || r.left < b.left - 1 || r.right > b.right + 1 || r.bottom > b.bottom + 1 || style.pointerEvents === 'none') issues.push(`${id}: retry target is clipped, too small, or disabled`);
          }
          boxes.push({ id, bubble: { x: b.x, y: b.y, width: b.width, height: b.height }, meta: { x: m.x, y: m.y, width: m.width, height: m.height }, mediaOverlay, colors: { bubble: getComputedStyle(bubble).backgroundColor, content: getComputedStyle(bubble.querySelector('.message-text') ?? bubble).color, metadata: style.color } });
        }
        if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('horizontal page overflow');
        if (issues.length) throw Error(`${name}/${kind}: ${issues.join('; ')}; geometry=${JSON.stringify(boxes)}`);
        return { name, kind, messages: boxes.length, rootFont: getComputedStyle(document.documentElement).fontSize, bodyColor, composer: { top: composerBox.top, bottom: composerBox.bottom }, scrollState, boxes };
      }, { ...configuration, kind });
      results.layouts.push(geometry);
      if (visualQaDirectory) await page.screenshot({ path: path.join(visualQaDirectory, `${configuration.name}-${kind}.png`) });
    }
  }
  if (visualQaDirectory) {
    await mobile.bringToFront();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await mobile.evaluate(() => {
      document.documentElement.dataset.colorScheme = 'light';
      document.documentElement.style.setProperty('font-size', '16px', 'important');
    });
    await mobile.waitForTimeout(220);
    await mobile.evaluate(async () => {
      const { fresh, show, message } = window.timeline; fresh();
      await show(Array.from({ length: 60 }, (_, index) => message(index + 1, `历史位置合成消息 ${index + 1}`, undefined, index % 3 === 0)));
    });
    await mobile.locator('#message-input').focus();
    await mobile.mouse.move(170, 350);
    await mobile.mouse.wheel(0, -240);
    await mobile.evaluate(() => window.timeline.settle());
    await mobile.locator('#chat-bottom-control').waitFor({ state: 'visible' });
    await mobile.screenshot({ path: path.join(visualQaDirectory, '390-light-history-bottom-control.png') });
  }
  assert.deepEqual(errors, [], 'Timeline fixture emitted browser errors');
  results.browserErrors = errors.length;
  if (visualQaDirectory) await writeFile(path.join(visualQaDirectory, 'message-timeline-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ ...results, layouts: results.layouts.map(({ boxes: _boxes, ...layout }) => layout) }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
