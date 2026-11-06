import assert from 'node:assert/strict';
import { chromium, webkit, devices } from 'playwright';
import { startChatRenderHarness } from './helpers/chat-render-harness.mjs';

const harness = await startChatRenderHarness();
try {
  for (const [engine, mobile, listScroll = false] of [[chromium, false], [chromium, true], [webkit, true], [webkit, true, true]]) {
    const browser = await engine.launch(engine === chromium && !process.env.CI ? { channel: 'chrome' } : {});
    try {
      const context = await browser.newContext({ locale: 'zh-CN', ...(mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }) });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await harness.setup(page, 10000, { listScroll });
      const result = await page.evaluate(async () => {
        const app = chatTest, list = document.querySelector('#message-list');
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const check = (condition, message) => { if (!condition) throw Error(message); };
        const row = id => list.querySelector(`[data-client-msg-id="window-${id}"]`);
        const bounded = () => check(list.querySelectorAll(':scope > .message').length <= 200 && document.querySelectorAll('*').length <= 5000, 'DOM is not bounded');
        await settle(); bounded(); check(Boolean(row(10000)), 'latest row not mounted');
        await app.jumpToReplyTarget('window-6000', 6000); await settle();
        check(Boolean(row(6000)) && row(6000).getBoundingClientRect().bottom > app.chatViewportTop, 'reply target not visible');
        const target = row(6000), top = target.getBoundingClientRect().top;
        app.messages.set(10001, chatMessage(10001)); app.chatNewMessageIds.add('window-10001');
        app.renderMessages(); await settle();
        check(row(6000) === target && Math.abs(target.getBoundingClientRect().top - top) < 2, 'arrival lost reading anchor');
        check(app.chatNewMessageIds.has('window-10001'), 'offscreen arrival was read');
        const selection = getSelection(), range = document.createRange(); range.selectNodeContents(target.querySelector('.message-text'));
        selection.removeAllRanges(); selection.addRange(range);
        const selected = selection.toString(), beforeStart = app.chatRenderWindow.start;
        app.chatUnreadJumpId = 'window-10001'; app.renderMessages();
        check(app.chatUnreadJumpId === 'window-10001' && row(6000) === target && selection.toString() === selected, 'late unread lookup interrupted selection');
        app.chatUnreadJumpId = null;
        app.setChatScrollTop(app.chatScrollTop - 15000); app.refreshChatWindow(); app.renderMessages({ scroll: 'position' });
        check(selection.toString() === selected && row(6000) === target && app.chatRenderWindow.start === beforeStart, 'selection was recycled');
        selection.removeAllRanges(); app.refreshChatWindow(); await settle(); bounded();
        check(app.chatRenderWindow.start < beforeStart, 'released window did not follow scroll');
        await app.jumpToReplyTarget('window-4000', 4000); await settle();
        const anchor = app.captureChatAnchor(true, true), anchorRow = list.querySelector(`[data-client-msg-id="${anchor.clientMsgId}"]`);
        const anchorTop = anchorRow.getBoundingClientRect().top;
        const beforeGrowth = { anchor, scroll: app.chatScrollTop, measuredScroll: app.chatWindowLastScroll };
        const earlier = app.renderedMessageOrder.find(element => element !== anchorRow && element.getBoundingClientRect().bottom < anchorTop);
        check(Boolean(earlier), 'fixture needs an earlier mounted row');
        earlier.querySelector('.message-bubble').style.minHeight = '500px'; await settle(); await settle();
        check(Math.abs(anchorRow.getBoundingClientRect().top - anchorTop) < 3,
          `decoded height shifted the reading anchor: ${JSON.stringify({ beforeGrowth, afterTop: anchorRow.getBoundingClientRect().top, anchorTop, afterScroll: app.chatScrollTop, afterAnchor: app.uiPreferences.chatAnchor })}`);
        // Cross a large spacer using the real scroll owner, then inspect coverage.
        app.setChatScrollTop(app.chatScrollTop + 100000); app.chatScrollIntent = 'down';
        await settle(); app.refreshChatWindow(); await settle(); bounded();
        check(app.renderedMessageOrder.some(element => {
          const bounds = element.getBoundingClientRect(); return bounds.bottom > app.chatViewportTop && bounds.top < app.chatViewportTop + app.chatViewportHeight;
        }), 'fling left a blank viewport');
        app.chatUnreadJumpId = 'window-10001'; app.renderMessages(); await settle();
        check(Boolean(row(10001)) && Boolean(list.querySelector('.chat-unread-divider')), 'unread target was not mounted');
        await app.jumpToReplyTarget('window-2000', 2000); await settle();
        const focused = row(2000); focused.focus({ preventScroll: true });
        app.setChatScrollTop(app.chatScrollTop + 100000); app.refreshChatWindow(); await settle();
        check(row(2000) === focused && document.activeElement === focused, 'keyboard focus was recycled'); bounded();
        focused.blur(); app.renderMessages({ scroll: 'bottom' }); await settle();
        check(Boolean(row(10001)), 'return to latest failed');
        const beforeLock = { rows: list.querySelectorAll(':scope > .message').length, nodes: document.querySelectorAll('*').length, scrollOwner: app.usesListScrolling ? 'list' : 'document' };
        return beforeLock;
      });
      // A real, muted native audio player with a synthetic WAV exercises the
      // media pin independently of encrypted attachment transport fixtures.
      await page.evaluate(async () => {
        const app = chatTest;
        await app.jumpToReplyTarget('window-7000', 7000);
        const { VoicePlayer } = await import('/src/lib/voice-player.ts');
        const data = new ArrayBuffer(44 + 160000), view = new DataView(data);
        const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
        text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        text(36, 'data'); view.setUint32(40, 160000, true);
        const player = new VoicePlayer({ v: 1, kind: 'audio', durationMs: 10000 }, app.voicePlayback, async () => new Blob([data], { type: 'audio/wav' }));
        player.audio.muted = true;
        const source = document.querySelector('[data-client-msg-id="window-7000"] .message-bubble');
        source.replaceChildren(player.element); window.windowVoice = player;
      });
      await page.locator('[data-client-msg-id="window-7000"] .voice-play').click();
      await page.waitForFunction(() => windowVoice.playing);
      await page.evaluate(async () => {
        const app = chatTest, element = windowVoice.element;
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const previousScroll = app.chatScrollTop;
        app.setChatScrollTop(app.chatScrollTop - 100000); await settle(); app.refreshChatWindow(); await settle();
        if (Math.abs(app.chatScrollTop - previousScroll) < 1000 || app.chatRenderWindow.start <= 6999 && app.chatRenderWindow.end > 6999)
          throw Error('voice pin fixture did not leave the playing row window');
        if (!element.isConnected || !windowVoice.playing) throw Error('window recycle interrupted active voice');
        if (element.closest('.message').contains(document.activeElement)) document.activeElement.blur();
        app.voicePlayback.stop(); await settle(); app.renderMessages({ scroll: 'position' }); await settle();
        if (element.isConnected || windowVoice.url !== null) throw Error(`inactive off-window voice pin was not released: ${JSON.stringify({ connected: element.isConnected, state: element.dataset.playbackState, hasUrl: windowVoice.url !== null, start: app.chatRenderWindow.start, end: app.chatRenderWindow.end, focus: document.activeElement?.className })}`);
        app.lockNow();
        if (app.messages.size || app.chatRenderWindow.length || app.chatWindowSpacers.size || app.chatWindowSteps.size
          || app.chatWindowObserved.size || app.chatWindowObserver || document.querySelector('#message-list')) throw Error('lock retained plaintext window state');
      });
      assert.deepEqual(errors, []);
      console.log('CHAT_WINDOW', JSON.stringify({ engine: engine.name(), mobile, forcedListScroll: listScroll, nativeVoicePin: true, ...result }));
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await harness.close(); }
