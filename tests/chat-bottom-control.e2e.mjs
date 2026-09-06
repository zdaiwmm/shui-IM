import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'chat-bottom-fixture', configureServer(vite) {
    vite.middlewares.use('/__chat_bottom', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    });
  } }],
});
let browser;
const results = {};
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__chat_bottom`);
  await page.evaluate(async () => {
    await import('/src/styles.css'); await import('/src/chat-layout.css'); await import('/src/gallery.css');
    await import('/src/chat-interactions.css'); await import('/src/cover.css'); await import('/src/voice-messages.css'); await import('/src/call.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault, saveHistoryMessage } = await import('/src/lib/vault.ts');
    const member = { deviceId: 'bottom-own', role: 'creator', status: 'active' };
    const session = await createVault({ v: 1, roomId: 'bottom-regression', accessToken: 'test', role: 'creator', protocol: 'legacy-v1', lastSeq: 200,
      members: [member, { deviceId: 'bottom-peer', role: 'joiner', status: 'active' }], identity: { publicBundle: member } }, 'bottom-regression-password', 'password');
    const app = new QuietRoomApp(document.querySelector('#app'));
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.mountChatImageObserver = () => {}; app.mountGalleryThumbnails = () => {};
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fresh = async (count = 80) => {
      app.session = session; app.privacyCovered = false; app.runtimeEpoch += 1; app.runtimeAbort = new AbortController();
      app.uiPreferences = { recoveryReminderDismissed: true }; app.restoreChatAnchorOnNextRender = false;
      app.historyHasNewer = false; app.historyHasMore = false; app.historyLoading = false; app.historyForwardCursor = count;
      app.messages = new Map(Array.from({ length: count }, (_, index) => [index + 1, {
        seq: index + 1, clientMsgId: `bottom-${index + 1}`, senderId: 'bottom-peer', status: 'delivered', acceptedAt: '2026-09-04T01:00:00.000Z',
        payload: { v: 1, kind: 'text', text: `聊天消息 ${index + 1}`, sentAt: '2026-09-04T01:00:00.000Z' },
      }]));
      app.pending = new Map(); app.messageEventHistory = new Map(); app.renderChat(); app.renderMessages({ scroll: 'bottom' }); await settle();
    };
    const up = async distance => {
      document.querySelector('#message-list').dispatchEvent(new WheelEvent('wheel', { deltaY: -distance, bubbles: true }));
      window.scrollTo(0, app.chatBottomScrollTop() - distance); app.updateChatBottomControl(); await settle();
    };
    const button = () => document.querySelector('#chat-bottom-control');
    const visible = () => button().classList.contains('is-visible');
    const waitForComposerReveal = async () => {
      const deadline = performance.now() + 1200;
      while (performance.now() < deadline) {
        const composer = document.querySelector('#composer');
        if (!composer.dataset.viewportMotion && Number(getComputedStyle(composer).opacity) === 1) return;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw Error('Composer did not reveal after scrolling settled');
    };
    const surfaceSelectors = {
      input: '.composer-input-stack',
      photo: '#open-image-picker',
      voice: '#record-voice',
      bottom: '#chat-bottom-control',
    };
    const colorAlpha = value => {
      if (value === 'transparent') return 0;
      const slash = value.match(/\/\s*([\d.]+)(%)?\s*\)$/);
      if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
      const comma = value.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/);
      if (comma) return Number(comma[1]);
      if (/^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(/.test(value)) return 1;
      throw Error(`Could not parse computed background alpha: ${value}`);
    };
    const assertComposerVisible = label => {
      const composer = document.querySelector('#composer');
      const style = getComputedStyle(composer);
      const bounds = composer.getBoundingClientRect();
      const top = window.visualViewport?.offsetTop ?? 0;
      const bottom = top + (window.visualViewport?.height ?? innerHeight);
      if (composer.dataset.viewportMotion || style.display === 'none' || style.visibility !== 'visible'
        || Number(style.opacity) !== 1 || bounds.width <= 0 || bounds.height <= 0
        || bounds.bottom <= top || bounds.top >= bottom) {
        throw Error(`${label} sampled surfaces through a concealed or offscreen composer: ${JSON.stringify({
          motion: composer.dataset.viewportMotion ?? null,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          bounds: bounds.toJSON(),
          viewport: { top, bottom },
        })}`);
      }
    };
    const assertSurfaceSet = (label, expectedAlpha, fallback = false) => {
      assertComposerVisible(label);
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (window.visualViewport?.height ?? innerHeight);
      const snapshot = Object.fromEntries(Object.entries(surfaceSelectors).map(([name, selector]) => {
        const element = document.querySelector(selector);
        if (!element) throw Error(`${label} ${name} surface was missing`);
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= viewportTop || bounds.top >= viewportBottom) {
          throw Error(`${label} ${name} surface did not intersect the visual viewport: ${JSON.stringify(bounds.toJSON())}`);
        }
        return [name, {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          color: style.color,
          borderColor: style.borderColor,
          alpha: colorAlpha(style.backgroundColor),
          opacity: style.opacity,
          backdropFilter: style.getPropertyValue('backdrop-filter'),
          webkitBackdropFilter: style.getPropertyValue('-webkit-backdrop-filter'),
        }];
      }));
      for (const name of Object.keys(surfaceSelectors)) {
        if (snapshot[name].backgroundColor !== snapshot.input.backgroundColor
          || snapshot[name].backgroundImage !== snapshot.input.backgroundImage) {
          throw Error(`${label} composer surfaces diverged: ${JSON.stringify(snapshot)}`);
        }
        if (Math.abs(snapshot[name].alpha - expectedAlpha) > 0.002) {
          throw Error(`${label} ${name} background alpha was ${snapshot[name].alpha}, expected ${expectedAlpha}: ${snapshot[name].backgroundColor}`);
        }
        if (snapshot[name].opacity !== '1') throw Error(`${label} ${name} surface was dimmed: ${JSON.stringify(snapshot[name])}`);
        if (fallback && (snapshot[name].backgroundImage !== 'none'
          || [snapshot[name].backdropFilter, snapshot[name].webkitBackdropFilter].some(value => value && value !== 'none'))) {
          throw Error(`${label} ${name} retained translucent effects in its opaque fallback: ${JSON.stringify(snapshot[name])}`);
        }
      }
      if (!visible() || button().getAttribute('aria-hidden') !== 'false' || button().tabIndex !== 0) {
        throw Error(`${label} bottom control was not visibly interactive`);
      }
      return snapshot;
    };
    const forceConditionalRules = kind => {
      const styles = [];
      let containers = 0;
      let ruleCount = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        const rules = [];
        for (const rule of sheet.cssRules) {
          const condition = rule.conditionText ?? '';
          const media = rule.type === CSSRule.MEDIA_RULE;
          const supports = rule.type === CSSRule.SUPPORTS_RULE;
          const selected = kind === 'reduced-transparency'
            ? media && condition.includes('prefers-reduced-transparency')
            : kind === 'contrast'
              ? media && condition.includes('prefers-contrast')
              : kind === 'forced-colors'
                ? media && condition.includes('forced-colors')
                : supports && condition.includes('backdrop-filter') && condition.trim().startsWith('not');
          if (!selected) continue;
          containers++;
          rules.push(...Array.from(rule.cssRules, nested => nested.cssText));
        }
        if (!rules.length) continue;
        ruleCount += rules.length;
        const style = document.createElement('style');
        style.dataset.surfaceFallbackFixture = kind;
        style.textContent = rules.join('\n');
        // Keep every forced rule beside the stylesheet that owns the real
        // conditional block, preserving the application's import cascade.
        sheet.ownerNode.after(style);
        styles.push(style);
      }
      if (containers < 2 || !ruleCount) throw Error(`${kind} fallback rules were not present across the imported stylesheets`);
      return { styles, containers };
    };
    const assertGap = () => {
      const composer = document.querySelector('#composer').getBoundingClientRect(); const rect = button().getBoundingClientRect();
      if (Math.abs(composer.top - rect.bottom - 8) > 0.6 || Math.abs(rect.height - 44) > 0.6) throw Error(`Button lost its composer gap: ${JSON.stringify({ composer: composer.top, bottom: rect.bottom, height: rect.height })}`);
    };
    window.bottomFixture = { app, session, saveHistoryMessage, fresh, settle, up, button, visible, waitForComposerReveal,
      assertSurfaceSet, forceConditionalRules, assertGap }; await fresh();
  });

  results.strictThreshold = await page.evaluate(async () => {
    const { app, up, settle, button, visible, waitForComposerReveal, assertGap } = window.bottomFixture;
    assertGap(); if (visible()) throw Error('Latest message above the button still showed the control');
    const latest = app.renderedMessageOrder.at(-1);
    const start = latest.getBoundingClientRect().bottom - button().getBoundingClientRect().top;
    if (Math.abs(start + 12) > 1) throw Error(`Bottom clearance was not 12px: ${start}`);
    await up(11); if (visible()) throw Error('Button appeared before latest message crossed its top edge');
    await up(13);
    const composer = document.querySelector('#composer');
    if (composer.dataset.viewportMotion !== 'positioning' || getComputedStyle(composer).opacity !== '0') throw Error('Scroll motion did not immediately conceal the composer');
    await waitForComposerReveal();
    if (!visible() || button().getAttribute('aria-hidden') !== 'false' || button().tabIndex !== 0) throw Error('Button did not appear after scroll motion fully settled');
    const fade = getComputedStyle(button());
    if (!fade.transitionProperty.includes('opacity') || !fade.transitionDuration.includes('0.18s')) throw Error('Button lost its opacity transition');
    await up(11);
    // Manual document scrolling conceals the entire composer immediately and
    // commits the button's visibility at the same stable endpoint. Inspecting
    // its child state while the parent is still fully transparent can only
    // observe the previous (unpainted) frame.
    await waitForComposerReveal();
    if (visible() || button().tabIndex !== -1) throw Error('Returning across the threshold left the button active');
    // Observe async content changes even when neither scrolling nor viewport
    // events fire. This covers both the final message and earlier media.
    latest.style.paddingBottom = '30px'; await settle();
    if (!visible()) throw Error('Last-message growth did not refresh visibility');
    latest.style.paddingBottom = ''; await settle();
    if (visible()) throw Error('Last-message shrink did not hide the control');
    const earlier = app.renderedMessageOrder.at(-2); earlier.style.paddingBottom = '30px'; await settle();
    if (!visible()) throw Error('Earlier content growth left the last-message threshold stale');
    earlier.style.paddingBottom = ''; await settle();
    if (visible()) throw Error('Earlier content shrink left the control visible');
    return { clearance: 12, visibleAfterCrossing: true, fadeMs: 180, asynchronousContent: true };
  });

  results.lockedComposerGap = await page.evaluate(async () => {
    const { app, up, settle, assertGap } = window.bottomFixture; await up(400);
    const viewport = window.visualViewport;
    const saved = Object.fromEntries(['height', 'offsetTop'].map(key => [key, Object.getOwnPropertyDescriptor(viewport, key)]));
    try {
      for (const [height, offsetTop] of [[780, 0], [810, 0], [610, 50], [430, 180]]) {
        Object.defineProperty(viewport, 'height', { configurable: true, value: height });
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: offsetTop });
        viewport.dispatchEvent(new Event('resize')); assertGap(); await settle(); assertGap();
      }
      const input = document.querySelector('#message-input'); input.value = '多行输入\n'.repeat(6); input.dispatchEvent(new Event('input'));
      await settle(); assertGap();
    } finally {
      for (const key of Object.keys(saved)) { if (saved[key]) Object.defineProperty(viewport, key, saved[key]); else delete viewport[key]; }
      viewport.dispatchEvent(new Event('resize')); app.scrollChatToBottom(); await settle();
    }
    return { toolbarFrames: 4, multilineComposer: true, gap: 8 };
  });

  results.composerHeightMotion = await page.evaluate(async () => {
    const { app, fresh, settle } = window.bottomFixture;
    await fresh();
    const input = document.querySelector('#message-input');
    input.focus({ preventScroll: true });
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 430 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 100 });
    visualViewport.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 750));
    const composer = document.querySelector('#composer');
    const header = document.querySelector('.chat-header');
    const photo = document.querySelector('#open-image-picker');
    const sample = (trackedMessage = app.renderedMessageOrder.at(-1)) => {
      const action = composer.querySelector('.send-button:not([hidden]), .voice-record-button:not([hidden])');
      const messageContent = trackedMessage?.querySelector('.message-bubble');
      return {
        resizing: Boolean(app.composerHeightMotion),
        viewportMotion: composer.dataset.viewportMotion ?? null,
        inputHeight: input.getBoundingClientRect().height,
        inputBottom: input.getBoundingClientRect().bottom,
        headerTop: header.getBoundingClientRect().top,
        photoBottom: photo.getBoundingClientRect().bottom,
        actionBottom: action?.getBoundingClientRect().bottom ?? Number.NaN,
        messageTop: messageContent?.getBoundingClientRect().top ?? Number.NaN,
        composerTop: composer.getBoundingClientRect().top,
        scrollY: window.scrollY,
        bottomSpace: getComputedStyle(document.documentElement).getPropertyValue('--chat-bottom-space'),
      };
    };
    const collect = async (frames, trackedMessage) => {
      const samples = [sample(trackedMessage)];
      for (let index = 0; index < frames; index++) {
        // Sample after paint. App-owned rAF callbacks may be queued later in
        // the same frame than this test callback, but those intermediate DOM
        // states are never presented to the user.
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        samples.push(sample(trackedMessage));
      }
      return samples;
    };
    const range = (samples, key) => Math.max(...samples.map(item => item[key])) - Math.min(...samples.map(item => item[key]));
    const direction = (samples, key, sign) => samples.slice(1).every((item, index) => {
      // Layout uses fractional CSS pixels; the endpoint document scroll is
      // integer-quantized. Allow at most one CSS pixel only at that handoff,
      // while preserving the tighter bound throughout the visible animation.
      const tolerance = samples[index].resizing && !item.resizing ? 1 : 0.8;
      return sign * (item[key] - samples[index][key]) >= -tolerance;
    });
    // WebKit reports flex-end children on alternating device-pixel rounding
    // boundaries while their sibling height is fractional. Up to 1.25 CSS px
    // spans one WebKit device-pixel quantization step at this emulated scale,
    // not a presented movement of the anchored edge.
    const fixed = (samples, key) => range(samples, key) <= 1.25;
    const smooth = (samples, key) => {
      const travel = range(samples, key);
      const largestFrame = Math.max(...samples.slice(1).map((item, index) => Math.abs(item[key] - samples[index][key])));
      const movingFrames = samples.filter((item, index) => !index || Math.abs(item[key] - samples[index - 1][key]) > 0.2).length;
      // Headless WebKit can miss an early presentation deadline while still
      // producing a continuous compositor transition. Reject a one-frame jump,
      // while requiring several distinct painted positions and a partial step.
      return movingFrames >= 5 && largestFrame < Math.max(4, travel * 0.9);
    };

    input.value = '第一行\n第二行\n第三行';
    input.dispatchEvent(new Event('input'));
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 422 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 108 });
    visualViewport.dispatchEvent(new Event('resize'));
    const growing = await collect(24);
    if (range(growing, 'inputHeight') < 35 || !direction(growing, 'inputHeight', 1)) {
      throw Error(`Composer did not expand through monotonic intermediate heights: ${JSON.stringify(growing)}`);
    }
    if (!fixed(growing, 'headerTop') || !fixed(growing, 'inputBottom')
      || !fixed(growing, 'photoBottom') || !fixed(growing, 'actionBottom')) {
      throw Error(`Fixed chat chrome moved during composer expansion: ${JSON.stringify(growing)}`);
    }
    if (growing.some(frame => frame.viewportMotion)) {
      throw Error(`Composer-owned viewport drift concealed the input toolbar: ${JSON.stringify(growing)}`);
    }
    if (!direction(growing, 'messageTop', -1) || !smooth(growing, 'messageTop')
      || growing.at(-1).messageTop >= growing[0].messageTop - 35) {
      throw Error(`Timeline did not rise smoothly with composer expansion: ${JSON.stringify(growing)}`);
    }

    const offsets = growing.map(frame => ({ gap: frame.composerTop - frame.messageTop }));
    if (range(offsets, 'gap') > 2) throw Error(`Composer and timeline used different progress: ${JSON.stringify(growing)}`);
    const previousLatest = app.renderedMessageOrder.at(-1);
    let sendNumber = 0;
    app.enqueuePayload = async payload => {
      const clientMsgId = `composer-motion-send-${++sendNumber}`;
      app.pending.set(clientMsgId, {
        seq: Number.MAX_SAFE_INTEGER,
        clientMsgId,
        senderId: app.session.vault.identity.publicBundle.deviceId,
        payload,
        acceptedAt: payload.sentAt,
        status: 'pending',
      });
      app.renderMessages({ scroll: 'send' });
    };
    const beforeSend = sample(previousLatest);
    composer.requestSubmit();
    await Promise.resolve();
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 430 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 100 });
    visualViewport.dispatchEvent(new Event('resize'));
    const sending = [beforeSend, ...await collect(24, previousLatest)];
    await settle();
    if (range(sending, 'inputHeight') < 35 || !direction(sending, 'inputHeight', -1)) {
      throw Error(`Sent composer did not collapse through monotonic intermediate heights: ${JSON.stringify(sending)}`);
    }
    if (!fixed(sending, 'headerTop') || !fixed(sending, 'inputBottom')
      || !fixed(sending, 'photoBottom') || !fixed(sending, 'actionBottom')) {
      throw Error(`Fixed chat chrome moved during send: ${JSON.stringify(sending)}`);
    }
    if (sending.some(frame => frame.viewportMotion)) {
      throw Error(`Send-owned viewport drift concealed the input toolbar: ${JSON.stringify(sending)}`);
    }
    if (!direction(sending, 'messageTop', -1) || !smooth(sending, 'messageTop')
      || sending.at(-1).messageTop >= sending[0].messageTop - 4) {
      throw Error(`Inserted message did not move the prior timeline smoothly upward: ${JSON.stringify(sending)}`);
    }
    // Real iOS can defer its caret-reveal pan until after the 280ms textarea
    // collapse has painted. That delayed sample still belongs to the send.
    const beforeDelayedSendDrift = sample(previousLatest);
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 92 });
    visualViewport.dispatchEvent(new Event('scroll'));
    const delayedSendDrift = [beforeDelayedSendDrift, ...await collect(4, previousLatest)];
    if (delayedSendDrift.some(frame => frame.viewportMotion)
      || !fixed(delayedSendDrift, 'headerTop') || !fixed(delayedSendDrift, 'inputBottom')
      || !fixed(delayedSendDrift, 'photoBottom') || !fixed(delayedSendDrift, 'actionBottom')) {
      throw Error(`Delayed send viewport drift moved fixed chat chrome: ${JSON.stringify(delayedSendDrift)}`);
    }
    // Retarget a live Chinese-IME-style wrap, then delete back to one line.
    // The first position after each edit must retain the last painted position.
    input.value = '第一行\n第二行\n第三行\n第四行'; input.dispatchEvent(new Event('input'));
    await collect(3);
    const beforeRetarget = sample();
    input.value = '重新组词\n第二行'; input.dispatchEvent(new Event('input'));
    const retarget = sample();
    if (Math.abs(retarget.messageTop - beforeRetarget.messageTop) > 1.25
      || Math.abs(retarget.inputHeight - beforeRetarget.inputHeight) > 1.25) throw Error('Live wrap retarget jumped before paint');
    await collect(24);
    input.value = ''; input.dispatchEvent(new Event('input')); await collect(24);
    input.value = '快速发送第一行\n第二行\n第三行'; input.dispatchEvent(new Event('input'));
    await collect(3);
    const interruptedRow = app.renderedMessageOrder.at(-1);
    const beforeInterruptedSend = sample(interruptedRow);
    composer.requestSubmit();
    const interruptedSend = [beforeInterruptedSend, ...await collect(24, interruptedRow)];
    if (!direction(interruptedSend, 'messageTop', -1) || !smooth(interruptedSend, 'messageTop')
      || !fixed(interruptedSend, 'photoBottom') || !fixed(interruptedSend, 'headerTop')) {
      throw Error(`Sending during wrap interrupted visible motion: ${JSON.stringify(interruptedSend)}`);
    }

    input.value = '离页之前第一行\n第二行\n第三行'; input.dispatchEvent(new Event('input'));
    await collect(3);
    const targetHeight = app.composerHeightMotion?.targetHeight;
    app.cancelViewportWork();
    if (app.composerHeightMotion || targetHeight == null || Math.abs(input.getBoundingClientRect().height - targetHeight) > 1) {
      throw Error('Suspending mid-resize left an incomplete field height');
    }
    app.syncViewport(); app.trackChatViewport();
    await new Promise(resolve => setTimeout(resolve, 750));
    input.value = ''; input.dispatchEvent(new Event('input')); await collect(24);

    // Typing while reading old history must not temporarily pull it upward
    // and snap it back at the endpoint. Native scroll intent still wins.
    app.chatScrollIntent = 'up'; app.chatPinnedToBottom = false; app.chatBottomFollowPending = false;
    app.chatViewportFollowUntil = 0;
    window.scrollBy(0, -240); await new Promise(resolve => setTimeout(resolve, 500));
    const readingRow = app.renderedMessageOrder.find(row => row.getBoundingClientRect().top >= 180);
    input.value = '历史阅读\n继续输入\n第三行'; input.dispatchEvent(new Event('input'));
    const reading = await collect(24, readingRow);
    if (range(reading, 'messageTop') > 1.25) throw Error(`Composer resize moved history anchor: ${JSON.stringify(reading)}`);
    delete visualViewport.height; delete visualViewport.offsetTop;
    visualViewport.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 750));
    return {
      focusedKeyboardViewport: true,
      interruptedWrap: true,
      historyAnchorStable: true,
      duration: getComputedStyle(document.documentElement).getPropertyValue('--motion-composer').trim(),
      expansionFrames: growing.filter((item, index) => !index || Math.abs(item.inputHeight - growing[index - 1].inputHeight) > 0.2).length,
      collapseFrames: sending.filter((item, index) => !index || Math.abs(item.inputHeight - sending[index - 1].inputHeight) > 0.2).length,
      fixedHeader: true,
      fixedToolbar: true,
      synchronizedTimeline: true,
    };
  });

  // An actual pointer click must retain the focused textarea and selection.
  await page.locator('#message-input').fill('键盘和选择位置保留');
  await page.evaluate(async () => {
    const input = document.querySelector('#message-input'); input.focus({ preventScroll: true }); input.setSelectionRange(2, 5);
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 430 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 180 });
    visualViewport.dispatchEvent(new Event('resize'));
    await window.bottomFixture.up(180);
    window.bottomMotionFrames = [];
    document.querySelector('#chat-bottom-control').addEventListener('pointerdown', () => {
      const sample = () => {
        const button = document.querySelector('#chat-bottom-control');
        window.bottomMotionFrames.push({
          focused: document.activeElement === input,
          concealed: !!document.querySelector('#composer').dataset.viewportMotion,
          headerTop: document.querySelector('.chat-header').getBoundingClientRect().top,
        });
        if (button.dataset.scrolling || window.bottomMotionFrames.length < 2) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { once: true });
    document.querySelector('#chat-bottom-control').addEventListener('click', () => {
      // Reproduce mobile engines that transfer focus despite preventDefault,
      // after the control's own click has committed the scroll request.
      queueMicrotask(() => input.blur());
    }, { once: true });
  });
  await page.locator('#chat-bottom-control').click();
  await page.waitForFunction(() => !document.querySelector('#chat-bottom-control').dataset.scrolling);
  results.keyboardPreserved = await page.evaluate(async () => {
    const { app, button, visible, assertGap, settle } = window.bottomFixture; const input = document.querySelector('#message-input');
    if (document.activeElement !== input || input.selectionStart !== 2 || input.selectionEnd !== 5) throw Error('Return to bottom dismissed the keyboard or changed selection');
    const targetGap = Math.abs(window.scrollY - app.chatBottomScrollTop());
    if (targetGap > 2 || !app.chatPinnedToBottom || visible()) throw Error(`Click did not finish at the latest message: ${JSON.stringify({ targetGap, pinned: app.chatPinnedToBottom, visible: visible(), scrollY: window.scrollY })}`);
    if (window.bottomMotionFrames.length < 3 || window.bottomMotionFrames.some(frame => !frame.focused || frame.concealed)) throw Error(`Programmatic return animation hid the composer or surrendered keyboard focus: ${JSON.stringify(window.bottomMotionFrames)}`);
    if (window.bottomMotionFrames.some(frame => Math.abs(frame.headerTop - 180) > 1)) throw Error(`Return animation moved the fixed header: ${JSON.stringify(window.bottomMotionFrames)}`);
    assertGap(); if (button().dataset.scrolling) throw Error('Completed scroll retained animation state');
    delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize'));
    // Native viewport events are intentionally coalesced into the next paint.
    // Finish that cleanup before the following motion scenario takes ownership.
    await settle();
    return { focus: true, selection: [2, 5], finishedPinned: true, fixedHeader: true, visibleComposerFrames: window.bottomMotionFrames.length };
  });

  results.distanceMotion = await page.evaluate(async () => {
    const { app, up, button } = window.bottomFixture;
    const animate = async distance => {
      await up(distance); const start = window.scrollY; const target = app.chatBottomScrollTop(); const begun = performance.now();
      const originalTarget = app.chatBottomScrollTop; let targetReads = 0;
      app.chatBottomScrollTop = function (...args) { targetReads++; return originalTarget.apply(this, args); };
      button().click();
      if (window.scrollY !== start) throw Error('Click jumped synchronously before animation');
      const frames = [];
      await new Promise((resolve, reject) => {
        const step = () => {
          frames.push({ elapsed: performance.now() - begun, y: window.scrollY });
          if (frames.length > 200) return reject(Error('Return animation did not finish'));
          if (button().dataset.scrolling) requestAnimationFrame(step); else resolve();
        }; requestAnimationFrame(step);
      });
      app.chatBottomScrollTop = originalTarget;
      if (!frames.some(frame => frame.y > start + 1 && frame.y < target - 2)) throw Error('Scroll had no intermediate positions');
      if (frames.some((frame, index) => index && frame.y < frames[index - 1].y - 1)) throw Error('Return animation moved backwards');
      if (Math.abs(window.scrollY - target) > 2) throw Error('Return animation missed its target');
      if (targetReads > 4) throw Error(`Return animation forced target layout on ${targetReads} frames`);
      return { distance: target - start, duration: frames.at(-1).elapsed, frames: frames.length, targetReads };
    };
    const short = await animate(140); const long = await animate(2200);
    if (short.duration < 260 || long.duration > 1200 || long.distance / long.duration <= short.distance / short.duration * 3) throw Error(`Distance-based motion was not deliberate at short range and faster at long range: ${JSON.stringify({ short, long })}`);
    return { short, long };
  });

  results.cancellation = await page.evaluate(async () => {
    const { app, up, settle, button, visible, waitForComposerReveal } = window.bottomFixture;
    await up(1800); button().click(); await settle();
    document.querySelector('#message-list').dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
    window.scrollBy(0, -40); const stopped = window.scrollY; await settle(); await settle();
    if (button().dataset.scrolling || window.scrollY !== stopped || app.chatPinnedToBottom) throw Error('User upward scroll did not cancel automatic movement');
    button().click(); await settle(); app.setActiveSurface('away'); const away = window.scrollY;
    if (button().dataset.scrolling || visible()) throw Error('Leaving chat retained the return control');
    await settle(); if (window.scrollY !== away) throw Error('Leaving chat retained a scrolling frame');
    app.setActiveSurface('chat');
    await waitForComposerReveal();
    if (!visible()) throw Error('Returning to the same chat failed to restore control visibility');
    button().click(); await settle(); const stale = button(); app.lockNow(); await settle();
    const lockedY = window.scrollY; stale.click(); await settle();
    if (!app.privacyCovered || document.querySelector('#chat-bottom-control') || window.scrollY !== lockedY) throw Error('Lock left an active or stale return control');
    return { userScroll: true, away: true, sameDomResume: true, lock: true, staleClick: true };
  });

  await page.setViewportSize({ width: 320, height: 740 });
  results.lateCachedMediaLayout = await page.evaluate(async () => {
    const { app, fresh, settle, visible } = window.bottomFixture;
    document.documentElement.style.setProperty('font-size', '20px', 'important');
    try {
      await fresh(4);
      const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="600" height="360" fill="navy"/></svg>'], { type: 'image/svg+xml' });
      const manifest = { v: 1, blobId: 'bottom-late-image', originalName: 'synthetic.svg', originalSize: blob.size, mimeType: blob.type };
      app.cacheLocalImage(manifest, blob); Object.assign(app.imageCache.get(manifest.blobId), { width: 600, height: 360 });
      for (const seq of [1, 4]) {
        const message = app.messages.get(seq); message.payload = { v: 1, kind: 'image', image: manifest, sentAt: message.payload.sentAt };
      }
      app.messages.get(4).status = 'failed'; app.renderMessages({ scroll: 'bottom' });
      await Promise.all([...document.querySelectorAll('#message-list img')].map(image => image.decode())); await settle();
      const gap = document.querySelector('#composer').getBoundingClientRect().top - app.renderedMessageOrder.at(-1).getBoundingClientRect().bottom;
      if (Math.abs(gap - 64) > 2 || visible() || !app.chatPinnedToBottom) throw Error(`Late cached image layout lost bottom alignment: ${JSON.stringify({ gap, visible: visible(), pinned: app.chatPinnedToBottom })}`);
      return { width: 320, font: 20, decodedImages: 2, finalGap: gap, buttonHidden: true };
    } finally { document.documentElement.style.removeProperty('font-size'); }
  });
  await page.setViewportSize({ width: 390, height: 844 });

  // Fill real encrypted local history; restoring an old reading position
  // initially mounts only 80 records, while the latest is on a third page.
  await page.evaluate(async () => {
    const fixture = window.bottomFixture; const { app, session, saveHistoryMessage, fresh, up } = fixture;
    await fresh(620); session.vault.lastSeq = 620;
    const records = [...app.messages.values()];
    for (let offset = 0; offset < records.length; offset += 40) await Promise.all(records.slice(offset, offset + 40).map(record => saveHistoryMessage(session, record)));
    fixture.restoreMiddle = async (distance = 400) => { await fresh(80); await up(distance); app.historyHasNewer = true; app.historyForwardCursor = 80; app.updateChatBottomControl(); await fixture.settle(); };
    fixture.blockNextDecrypt = () => {
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle); let blocked = false;
      Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: async (...args) => {
        if (!blocked) { blocked = true; await new Promise(resolve => { fixture.releaseDecrypt = resolve; }); }
        return decrypt(...args);
      } });
      fixture.restoreDecrypt = () => Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: decrypt });
    };
    await fixture.restoreMiddle(); fixture.blockNextDecrypt();
    const originalLoad = app.loadNewerHistory; fixture.pageCursors = [];
    app.loadNewerHistory = function (...args) { if (app.historyHasNewer && !app.historyLoading) fixture.pageCursors.push(app.historyForwardCursor); fixture.pendingPage = originalLoad.apply(this, args); return fixture.pendingPage; };
    fixture.restoreLoad = () => { app.loadNewerHistory = originalLoad; };
    // The button must cooperate with a normal page read already in progress.
    fixture.pendingPage = app.loadNewerHistory(document.querySelector('#message-list'));
    const input = document.querySelector('#message-input'); input.value = '分页期间保留键盘'; input.focus({ preventScroll: true }); input.setSelectionRange(1, 3);
    fixture.button().click();
  });
  await page.waitForFunction(() => Boolean(window.bottomFixture.releaseDecrypt));
  await page.evaluate(() => { window.bottomFixture.restoreDecrypt(); window.bottomFixture.releaseDecrypt(); });
  await page.waitForFunction(() => !document.querySelector('#chat-bottom-control').dataset.scrolling);
  results.paginatedLatest = await page.evaluate(() => {
    const { app, button, visible, pageCursors, restoreLoad } = window.bottomFixture; restoreLoad();
    const input = document.querySelector('#message-input');
    if (JSON.stringify(pageCursors) !== '[80,280,480]' || app.historyHasNewer || app.historyForwardCursor !== 620 || app.renderedMessageOrder.at(-1).dataset.clientMsgId !== 'bottom-620') throw Error(`Return stopped on an intermediate history page: ${JSON.stringify({ pageCursors, cursor: app.historyForwardCursor })}`);
    if (Math.abs(window.scrollY - app.chatBottomScrollTop()) > 2 || visible() || button().hasAttribute('aria-busy')) throw Error('Paginated return did not finish at true latest');
    if (document.activeElement !== input || input.selectionStart !== 1 || input.selectionEnd !== 3) throw Error('Paginated return lost keyboard focus or selection');
    return { pageCursors, latest: 620, reusedExistingLoad: true, keyboard: true };
  });

  results.cancelledHistory = {};
  for (const action of ['scroll', 'away', 'lock']) {
    await page.evaluate(async () => {
      const f = window.bottomFixture; await f.restoreMiddle(); f.releaseDecrypt = undefined; f.blockNextDecrypt();
      const original = f.app.loadNewerHistory;
      f.app.loadNewerHistory = function (...args) { f.pendingPage = original.apply(this, args); return f.pendingPage; };
      f.restoreLoad = () => { f.app.loadNewerHistory = original; }; f.button().click();
    });
    await page.waitForFunction(() => Boolean(window.bottomFixture.releaseDecrypt));
    results.cancelledHistory[action] = await page.evaluate(async action => {
      const f = window.bottomFixture; const { app, settle, button } = f;
      if (action === 'scroll') { document.querySelector('#message-list').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); window.scrollBy(0, -40); }
      else if (action === 'away') app.setActiveSurface('away');
      else app.lockNow();
      const stopped = window.scrollY;
      f.restoreDecrypt(); f.releaseDecrypt(); await f.pendingPage; f.restoreLoad(); await settle();
      if (app.messages.size !== (action === 'lock' ? 0 : 80) || app.messages.has(81) || (button()?.dataset.scrolling)) throw Error(`Cancelled ${action} accepted a stale history page`);
      if (action !== 'lock' && window.scrollY !== stopped) throw Error(`Cancelled ${action} resumed scrolling after decrypt`);
      return { stalePageIgnored: true, laterMovement: false };
    }, action);
  }

  await page.evaluate(async () => {
    const f = window.bottomFixture; await f.restoreMiddle(0);
    if (!f.visible()) throw Error('Unloaded newer history hid the return/retry entry at the mounted page bottom');
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[0] === 'history' && args[1] === 'readonly') throw new DOMException('Synthetic history database failure', 'UnknownError');
      return transaction.apply(this, args);
    };
    f.restoreHistoryFault = () => { IDBDatabase.prototype.transaction = transaction; }; f.button().click();
  });
  await page.waitForFunction(() => !document.querySelector('#chat-bottom-control').dataset.scrolling);
  await page.evaluate(() => {
    const f = window.bottomFixture;
    if (!f.app.historyHasNewer || f.app.historyForwardCursor !== 80 || f.app.messages.size !== 80) throw Error('Failed history read was mistaken for completed history');
    if (!f.visible()) throw Error('Failed history read lost its retry button at the mounted page bottom');
    f.restoreHistoryFault(); f.button().click();
  });
  await page.waitForFunction(() => !document.querySelector('#chat-bottom-control').dataset.scrolling);
  results.historyReadRetry = await page.evaluate(() => {
    const { app } = window.bottomFixture;
    if (app.historyHasNewer || app.historyForwardCursor !== 620 || Math.abs(window.scrollY - app.chatBottomScrollTop()) > 2) throw Error('History read retry failed to reach latest');
    return { failurePreservedCursor: true, retryReachedLatest: 620 };
  });

  await page.evaluate(async () => {
    const { app, fresh, up, button, settle } = window.bottomFixture; await fresh(80);
    const source = app.messages.get(60);
    source.payload = { ...source.payload, v: 2, replyTo: { clientMsgId: 'bottom-20', serverSeq: 20, senderId: 'bottom-peer', kind: 'text', preview: '聊天消息 20' } };
    app.renderMessages({ scroll: 'bottom' }); await up(1400);
    document.querySelector('[data-client-msg-id="bottom-60"] .message-reply-quote').focus({ preventScroll: true });
    button().click(); await settle();
    if (!button().dataset.scrolling) throw Error('Reply competition fixture had no running bottom animation');
  });
  // Native keyboard activation has no pointerdown to cancel the old motion.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-client-msg-id="bottom-20"]');
    const rect = target.getBoundingClientRect();
    return !document.querySelector('#chat-bottom-control').dataset.scrolling && target.classList.contains('is-highlighted') && rect.top >= 0 && rect.bottom <= innerHeight;
  });
  results.replySupersedesBottom = await page.evaluate(() => {
    const { app } = window.bottomFixture;
    if (app.chatPinnedToBottom || app.chatBottomGap() < 500) throw Error('Bottom animation overrode the keyboard-activated reply');
    return { nativeKeyboardActivation: true, bottomMotionCancelled: true };
  });

  await page.evaluate(async () => {
    const f = window.bottomFixture; await f.fresh(620);
    f.app.messages = new Map([...f.app.messages].filter(([seq]) => seq > 540)); f.app.renderMessages({ scroll: 'bottom' }); await f.up(400);
    f.releaseDecrypt = undefined; f.blockNextDecrypt(); f.pendingReply = f.app.jumpToReplyTarget('bottom-1', 1);
  });
  await page.waitForFunction(() => Boolean(window.bottomFixture.releaseDecrypt));
  await page.evaluate(async () => {
    const f = window.bottomFixture; f.button().click(); f.restoreDecrypt(); f.releaseDecrypt(); await f.pendingReply;
  });
  await page.waitForFunction(() => !document.querySelector('#chat-bottom-control').dataset.scrolling);
  results.bottomSupersedesReply = await page.evaluate(() => {
    const { app } = window.bottomFixture;
    if (app.messages.has(1) || document.querySelector('.message.is-highlighted') || Math.abs(window.scrollY - app.chatBottomScrollTop()) > 2) throw Error('A delayed reply lookup overrode the newer return-to-bottom intent');
    return { delayedLookupIgnored: true, latestPositionRetained: true };
  });

  await page.evaluate(async () => {
    const { up, button, visible, waitForComposerReveal } = window.bottomFixture;
    await up(200);
    // The control is user-reachable only after the manual-scroll endpoint has
    // committed its visibility and the parent composer has been revealed.
    await waitForComposerReveal();
    if (!visible()) throw Error('Return control was not visible before its keyboard-focus scenario');
    button().focus({ preventScroll: true });
    button().click();
  });
  await page.waitForFunction(() => !document.querySelector('#chat-bottom-control').dataset.scrolling);
  results.hiddenButtonFocus = await page.evaluate(async () => {
    const { app, button, waitForComposerReveal } = window.bottomFixture;
    await waitForComposerReveal();
    const latest = app.renderedMessageOrder.at(-1);
    const snapshot = {
      focusIsLatest: document.activeElement === latest,
      activeElement: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
      ariaHidden: button().getAttribute('aria-hidden'),
      scrollY: window.scrollY,
      target: app.chatBottomScrollTop(),
      latestConnected: latest?.isConnected,
      latestTabIndex: latest?.tabIndex,
    };
    if (!snapshot.focusIsLatest || snapshot.ariaHidden !== 'true' || Math.abs(snapshot.scrollY - snapshot.target) > 2) {
      throw Error(`Hidden return control retained keyboard focus or focus transfer moved the page: ${JSON.stringify(snapshot)}`);
    }
    return { movedToLatestArticle: true, noKeyboardOpened: true, noExtraScroll: true };
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  results.reducedMotionAndBoundedReads = await page.evaluate(async () => {
    const { app, fresh, up, button, visible, waitForComposerReveal } = window.bottomFixture;
    await fresh(5000);
    await up(2400);
    await waitForComposerReveal();
    const original = Element.prototype.getBoundingClientRect; let messageReads = 0; let buttonReads = 0;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('message')) messageReads++;
      if (this.id === 'chat-bottom-control') buttonReads++;
      return original.call(this);
    };
    try {
      app.updateChatBottomControl();
      for (let index = 0; index < 20; index++) app.chatBottomControl.update(false);
    } finally { Element.prototype.getBoundingClientRect = original; }
    if (messageReads !== 1 || buttonReads !== 1) throw Error(`Visibility work scaled with history or idle frames: ${JSON.stringify({ messageReads, buttonReads })}`);
    button().click();
    if (button().dataset.scrolling || Math.abs(window.scrollY - app.chatBottomScrollTop()) > 2 || visible()) throw Error('Reduced motion did not move directly to latest message');
    if (getComputedStyle(button()).transitionProperty !== 'none') throw Error('Reduced motion retained the fade');
    const input = document.querySelector('#message-input');
    const baseHeight = input.getBoundingClientRect().height;
    input.value = '减少动态效果\n第二行\n第三行'; input.dispatchEvent(new Event('input'));
    if (app.composerHeightMotion || input.getBoundingClientRect().height <= baseHeight + 30) throw Error('Reduced motion animated or lost multiline sizing');
    input.value = ''; input.dispatchEvent(new Event('input'));
    if (app.composerHeightMotion || Math.abs(input.getBoundingClientRect().height - baseHeight) > 1) throw Error('Reduced motion failed to restore single-line height');
    await fresh(0); if (visible()) throw Error('Empty conversation displayed return control');
    await fresh(1);
    const shortGap = document.querySelector('#composer').getBoundingClientRect().top - app.renderedMessageOrder.at(-1).getBoundingClientRect().bottom;
    if (visible() || Math.abs(shortGap - 64) > 2) throw Error(`Short conversation lost its final bottom spacing: ${shortGap}`);
    return { historyCount: 5000, messageBoundsReads: messageReads, buttonBoundsReads: buttonReads, idleFrames: 20, instantReducedMotion: true, emptyAndShort: true };
  });

  results.composerSurfaceParity = {};
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference', contrast: 'no-preference', forcedColors: 'none' });
    results.composerSurfaceParity[colorScheme] = await page.evaluate(async scheme => {
      const { app, fresh, up, settle, button, visible, waitForComposerReveal, assertSurfaceSet } = window.bottomFixture;
      if (matchMedia('(prefers-color-scheme: dark)').matches !== (scheme === 'dark')) throw Error(`Failed to emulate the ${scheme} color scheme`);
      await fresh();
      await up(24);
      await waitForComposerReveal();
      const idle = assertSurfaceSet(`${scheme} idle`, 0.84);
      const input = document.querySelector('#message-input');
      input.focus({ preventScroll: true });
      await waitForComposerReveal();
      const focused = assertSurfaceSet(`${scheme} focused`, 0.92);
      if (focused.input.backgroundColor === idle.input.backgroundColor) {
        throw Error(`${scheme} focused composer surface did not reach its focus token`);
      }
      document.querySelector('#open-image-picker').disabled = true;
      document.querySelector('#record-voice').disabled = true;
      const disabled = assertSurfaceSet(`${scheme} disabled actions`, 0.92);
      document.querySelector('#open-image-picker').disabled = false;
      document.querySelector('#record-voice').disabled = false;
      input.blur();
      await waitForComposerReveal();
      app.scrollChatToBottom();
      await settle();
      await new Promise(resolve => setTimeout(resolve, 200));
      const hiddenOpacity = getComputedStyle(button()).opacity;
      if (visible() || hiddenOpacity !== '0' || button().getAttribute('aria-hidden') !== 'true' || button().tabIndex !== -1) {
        throw Error(`${scheme} return to bottom left the control exposed: ${JSON.stringify({ visible: visible(), hiddenOpacity, ariaHidden: button().getAttribute('aria-hidden'), tabIndex: button().tabIndex })}`);
      }
      return { idle, focused, disabled, hiddenOpacity };
    }, colorScheme);
  }
  assert.notEqual(results.composerSurfaceParity.light.idle.input.backgroundColor, results.composerSurfaceParity.dark.idle.input.backgroundColor,
    'Light and dark composer surfaces unexpectedly resolved to the same color');

  const verifyOpaqueFallback = async ({ name, media, query, fixtureKind, colorScheme = 'light', expectInk = false }) => {
    let native = false;
    if (media) {
      try {
        await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference', contrast: 'no-preference', forcedColors: 'none', ...media });
        native = await page.evaluate(value => matchMedia(value).matches, query);
      } catch {
        await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference', contrast: 'no-preference', forcedColors: 'none' });
      }
    } else {
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference', contrast: 'no-preference', forcedColors: 'none' });
    }
    return page.evaluate(async ({ label, useFixture, kind, requireInk }) => {
      const { fresh, up, waitForComposerReveal, assertSurfaceSet, forceConditionalRules } = window.bottomFixture;
      const forced = useFixture ? forceConditionalRules(kind) : null;
      try {
        await fresh();
        await up(24);
        await waitForComposerReveal();
        const idle = assertSurfaceSet(`${label} idle`, 1, true);
        const input = document.querySelector('#message-input');
        input.focus({ preventScroll: true });
        await waitForComposerReveal();
        const focused = assertSurfaceSet(`${label} focused`, 1, true);
        if (requireInk) {
          const probe = document.createElement('span');
          probe.style.color = 'var(--ink)';
          document.body.append(probe);
          const expectedInk = getComputedStyle(probe).color;
          probe.remove();
          for (const [surface, state] of Object.entries(focused)) {
            if (state.color !== expectedInk) throw Error(`${label} ${surface} foreground did not use the theme contrast ink: ${state.color} !== ${expectedInk}`);
          }
        }
        return { mode: forced ? 'source-rule fixture' : 'native media emulation', ruleContainers: forced?.containers ?? null, idle, focused };
      } finally {
        document.querySelector('#message-input')?.blur();
        forced?.styles.forEach(style => style.remove());
      }
    }, { label: name, useFixture: !native, kind: fixtureKind, requireInk: expectInk });
  };
  results.composerSurfaceFallbacks = {
    reducedTransparency: await verifyOpaqueFallback({
      name: 'reduced transparency',
      media: null,
      query: '(prefers-reduced-transparency: reduce)',
      fixtureKind: 'reduced-transparency',
    }),
    contrastMore: await verifyOpaqueFallback({
      name: 'increased contrast',
      media: { contrast: 'more' },
      query: '(prefers-contrast: more)',
      fixtureKind: 'contrast',
      expectInk: true,
    }),
    contrastMoreDark: await verifyOpaqueFallback({
      name: 'increased contrast dark',
      media: { contrast: 'more' },
      query: '(prefers-contrast: more)',
      fixtureKind: 'contrast',
      colorScheme: 'dark',
      expectInk: true,
    }),
    forcedColors: await verifyOpaqueFallback({
      name: 'forced colors',
      media: { forcedColors: 'active' },
      query: '(forced-colors: active)',
      fixtureKind: 'forced-colors',
    }),
    noBackdropSupport: await verifyOpaqueFallback({
      name: 'no backdrop-filter support',
      media: null,
      query: null,
      fixtureKind: 'no-backdrop',
    }),
  };
  results.contrastHover = {};
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference', contrast: 'more', forcedColors: 'none' });
  await page.evaluate(async () => {
    const { fresh, up, waitForComposerReveal } = window.bottomFixture;
    await fresh();
    await up(24);
    await waitForComposerReveal();
  });
  for (const [name, selector] of [['photo', '#open-image-picker'], ['voice', '#record-voice']]) {
    await page.locator(selector).hover();
    results.contrastHover[name] = await page.evaluate(({ label, target }) => {
      const element = document.querySelector(target);
      const probe = document.createElement('span');
      probe.style.border = '1px solid var(--line-strong)';
      probe.style.color = 'var(--ink)';
      document.body.append(probe);
      const expected = getComputedStyle(probe);
      const actual = getComputedStyle(element);
      const snapshot = { borderColor: actual.borderColor, color: actual.color };
      const required = { borderColor: expected.borderColor, color: expected.color };
      probe.remove();
      if (snapshot.borderColor !== required.borderColor || snapshot.color !== required.color) {
        throw Error(`Dark high-contrast ${label} hover lost its strong boundary: ${JSON.stringify({ snapshot, required })}`);
      }
      return snapshot;
    }, { label: name, target: selector });
  }
  await page.emulateMedia({ colorScheme: null, reducedMotion: null, contrast: null, forcedColors: null });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: process.env.QUIET_ROOM_TEST_BROWSER ?? 'chromium', ...results }, null, 2));
} finally {
  await browser?.close(); await server.close();
}
