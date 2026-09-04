import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// The actual app binding and browser recorder run against Chrome's synthetic
// microphone. Only completed-draft transport is replaced with a local counter;
// the paired-device voice-flow test verifies encrypted delivery separately.
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__voice_gestures', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
});
const screenshotDirectory = process.argv[2];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__voice_gestures`);
  await page.evaluate(async () => {
    for (const style of ['styles', 'chat-layout', 'gallery', 'auth-recovery', 'chat-interactions', 'cover', 'voice-messages', 'call']) await import(`/src/${style}.css`);
    const { QuietRoomApp } = await import('/src/app.ts');
    const { MAX_VOICE_SAMPLES, VOICE_SAMPLE_RATE } = await import('/src/lib/voice-audio.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.flushUiPreferencesSave = () => {};
    const tracks = [], sends = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const capture = async options => {
      const stream = await getUserMedia(options); tracks.push(...stream.getTracks()); return stream;
    };
    navigator.mediaDevices.getUserMedia = capture;
    const begin = app.beginVoiceRecording.bind(app);
    app.beginVoiceRecording = mode => {
      const recorder = begin(mode);
      if (recorder) recorder.callbacks.send = async (draft, signal) => {
        signal.throwIfAborted();
        sends.push({ clientMsgId: draft.clientMsgId, durationMs: draft.durationMs, mimeType: draft.file.type, size: draft.file.size, waveform: draft.waveform });
        app.closeVoiceRecorder(true);
      };
      return recorder;
    };
    const fresh = () => {
      app.lockNow();
      const own = { deviceId: 'voice-own', role: 'creator', status: 'active', capabilities: ['voice-message-v1'] };
      app.session = { vault: { roomId: 'voice-gestures', role: 'creator', protocol: 'legacy-v1', members: [own], identity: { publicBundle: own } } };
      app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
      const sentAt = new Date().toISOString();
      app.messages.set(1, { seq: 1, clientMsgId: 'fixture-incoming', senderId: 'voice-peer', payload: { v: 1, kind: 'text', text: '有空的时候，给我留一段语音吧。', sentAt }, acceptedAt: sentAt, status: 'delivered' });
      app.messages.set(2, { seq: 2, clientMsgId: 'fixture-outgoing', senderId: own.deviceId, payload: { v: 1, kind: 'text', text: '好，刚好有件事想和你分享。', sentAt }, acceptedAt: sentAt, status: 'delivered' });
      app.renderChat();
    };
    window.voiceGestures = { app, fresh, capture, tracks, sends, MAX_VOICE_SAMPLES, VOICE_SAMPLE_RATE };
    fresh();
  });
  const cdp = await page.context().newCDPSession(page);
  const recorder = page.locator('.voice-recorder');
  const recorded = () => page.waitForFunction(() => document.querySelector('.voice-recorder')?.dataset.state === 'recording');
  const paused = () => page.waitForFunction(() => document.querySelector('.voice-recorder')?.dataset.state === 'paused');
  const stopped = () => page.waitForFunction(() => window.voiceGestures.tracks.every(track => track.readyState === 'ended'));
  const sentCount = () => page.evaluate(() => window.voiceGestures.sends.length);
  const closed = () => page.waitForFunction(() => !window.voiceGestures.app.voiceRecorder);
  const reset = async () => { await page.evaluate(() => window.voiceGestures.fresh()); await page.locator('#record-voice').waitFor({ state: 'visible' }); };
  let origin;
  const touch = async (type, dx = 0, dy = 0) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x: origin.x + dx, y: origin.y + dy, id: 1 }],
    });
    // CDP may acknowledge a coalesced move before Chrome paints its pointer
    // event. Inspect the rendered gesture after that frame has been delivered.
    if (type === 'touchMove') await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const hold = async ({ permission = false } = {}) => {
    const bounds = await page.locator('#record-voice').boundingBox();
    assert(bounds, 'Microphone trigger is missing');
    origin = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await touch('touchStart');
    await recorder.waitFor({ state: 'visible' });
    if (!permission) await recorded();
    assert.equal(await recorder.getAttribute('data-mode'), 'hold');
  };
  const release = () => touch('touchEnd');
  const inspectLayout = async label => {
    const geometry = await recorder.evaluate(host => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      buttons: [...host.querySelectorAll('button')].filter(button => {
        const style = getComputedStyle(button); const rect = button.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }).map(button => { const rect = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label'), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; }),
      width: innerWidth, height: innerHeight,
    }));
    assert.equal(geometry.overflow, false, `${label}: horizontal overflow`);
    for (const button of geometry.buttons) {
      assert(button.width >= 43.5 && button.height >= 43.5, `${label}: target smaller than 44px: ${JSON.stringify(button)}`);
      assert(button.x >= -1 && button.right <= geometry.width + 1 && button.y >= -1 && button.bottom <= geometry.height + 1, `${label}: button outside viewport: ${JSON.stringify(button)}`);
    }
  };

  // A real held touch records and releasing it sends one complete portable file,
  // including after the upward movement that used to lock the recording.
  await page.evaluate(() => {
    window.voiceGrowthSamples = [];
    const deadline = performance.now() + 1600;
    const sample = () => {
      const orb = document.querySelector('.voice-hold-orb');
      if (orb && !orb.hidden) window.voiceGrowthSamples.push(orb.getBoundingClientRect().width);
      if (performance.now() < deadline) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await hold(); await page.waitForTimeout(750); await touch('touchMove', 0, -100);
  assert.equal(await recorder.getAttribute('data-mode'), 'hold');
  await release(); await closed(); await stopped();
  const growth = await page.evaluate(() => window.voiceGrowthSamples);
  assert(growth.some(width => width > 55 && width < 90), 'Microphone growth must render intermediate sizes instead of jumping to its final size');
  assert(growth.at(-1) >= 95, 'Microphone growth did not settle at its full size');
  assert.equal(await sentCount(), 1, 'Release must send exactly once');
  const draft = await page.evaluate(() => window.voiceGestures.sends[0]);
  assert(draft.durationMs >= 500 && draft.size > 44 && draft.mimeType === 'audio/wav');
  assert.equal(draft.waveform.length, 48);
  await page.waitForTimeout(250);
  assert.equal(await sentCount(), 1, 'Synthesized click after hold resent or reopened the recorder');
  assert.equal(await recorder.isVisible(), false);

  await hold(); await page.waitForTimeout(650);
  const restingY = await page.locator('.voice-hold-orb').evaluate(orb => orb.getBoundingClientRect().y);
  await touch('touchMove', -115, -70);
  assert.equal(await recorder.getAttribute('data-mode'), 'hold', 'The previous cancel distance must leave room to adjust the gesture');
  const firstDrag = await page.locator('.voice-hold-orb').evaluate(orb => ({ x: new DOMMatrixReadOnly(getComputedStyle(orb).transform).m41, y: orb.getBoundingClientRect().y }));
  assert(Math.abs(firstDrag.y - restingY) < 0.5, 'Held microphone must stay on the same horizontal rail');
  assert(firstDrag.x > -115 && firstDrag.x < -40, 'Held microphone should follow with resistance');
  await touch('touchMove', -145, -20);
  const furtherDrag = await page.locator('.voice-hold-orb').evaluate(orb => ({ x: new DOMMatrixReadOnly(getComputedStyle(orb).transform).m41, y: orb.getBoundingClientRect().y }));
  assert(furtherDrag.x < firstDrag.x && furtherDrag.x > -145, `Resistance must keep responding instead of reaching a hard stop: ${JSON.stringify({ firstDrag, furtherDrag })}`);
  assert(Math.abs(furtherDrag.y - restingY) < 0.5, 'Diagonal finger movement must not change the microphone height');
  await touch('touchMove', -165, -20);
  const cancelled = await page.evaluate(() => ({
    aborted: window.voiceGestures.app.voiceRecorder?.signal.aborted,
    samples: window.voiceGestures.app.voiceRecorder?.samples.length,
    tracksStopped: window.voiceGestures.tracks.every(track => track.readyState === 'ended'),
    retiring: document.querySelector('.voice-recorder')?.dataset.gesture,
    controls: document.querySelector('.voice-recorder')?.querySelectorAll('button, time, .voice-waveform').length,
  }));
  assert.deepEqual(cancelled, { aborted: true, samples: 0, tracksStopped: true, retiring: 'cancelling', controls: 0 }, 'Cancelling must discard capture and plaintext before its visual exit');
  const beforeRetire = await page.locator('.voice-cancel-orb').evaluate(orb => new DOMMatrixReadOnly(getComputedStyle(orb).transform).m41);
  await page.waitForTimeout(120);
  const duringRetire = await page.locator('.voice-cancel-orb').evaluate(orb => new DOMMatrixReadOnly(getComputedStyle(orb).transform).m41);
  assert(duringRetire > beforeRetire, 'Cancellation should retire toward the right');
  await closed(); await release(); await stopped();
  assert.equal(await sentCount(), 1, 'Left-slide cancellation sent a draft');

  await hold(); await page.waitForTimeout(650); await touch('touchCancel'); await closed(); await stopped();
  assert.equal(await sentCount(), 1, 'A cancelled pointer sent a draft');

  // Vertical swipes stay in hold mode and never expose the old lock rail.
  await hold(); await page.waitForTimeout(650); await touch('touchMove', 0, -100);
  assert.equal(await recorder.getAttribute('data-gesture'), 'hold');
  assert.equal(await recorder.getAttribute('data-mode'), 'hold');
  assert.equal(await recorder.locator('.voice-lock-guide').count(), 0, 'Upward lock affordance must be removed');
  await touch('touchCancel'); await closed(); await stopped();
  assert.equal(await sentCount(), 1, 'Pointer cancellation after vertical movement sent a draft');
  // Tap remains a deliberate hands-free entry with pause, preview and resume.
  await page.locator('#record-voice').tap(); await recorded(); await page.waitForTimeout(750);
  await page.getByRole('button', { name: '暂停录音', exact: true }).click(); await paused(); await stopped();
  await page.getByRole('button', { name: '试听录音', exact: true }).click();
  await page.getByRole('button', { name: '暂停试听', exact: true }).waitFor();
  await page.getByRole('button', { name: '继续录音', exact: true }).click(); await recorded();
  assert.equal(await recorder.getAttribute('data-mode'), 'locked');
  await page.waitForTimeout(650);
  await page.getByRole('button', { name: '发送语音', exact: true }).click(); await closed(); await stopped();
  assert.equal(await sentCount(), 2, 'Locked live-send must finish and send once');

  // Finger release and cancel while permission is unresolved cannot leave a
  // future capture or turn a delayed grant into a send.
  for (const cancel of [false, true]) {
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.voiceGestures.resolvePermission = resolve; }); });
    await hold({ permission: true });
    if (cancel) await touch('touchMove', -165, 0);
    await release(); await closed();
    await page.evaluate(async () => {
      const state = window.voiceGestures;
      state.resolvePermission(await state.capture({ audio: true }));
      navigator.mediaDevices.getUserMedia = state.capture;
    });
    await stopped();
    assert.equal(await sentCount(), 2, 'Late microphone permission sent discarded audio');
  }

  // Short tap and keyboard activation remain accessible hands-free entry.
  await page.locator('#record-voice').tap(); await recorded();
  assert.equal(await recorder.getAttribute('data-mode'), 'locked');
  await page.getByRole('button', { name: '取消录音', exact: true }).click(); await closed(); await stopped();
  await page.locator('#record-voice').focus(); await page.keyboard.press('Enter'); await recorded();
  assert.equal(await recorder.getAttribute('data-mode'), 'locked');
  await page.getByRole('button', { name: '取消录音', exact: true }).click(); await closed(); await stopped();
  assert.equal(await sentCount(), 2, 'Tap or keyboard entry unexpectedly sent a draft');

  // Hardware interruption and the five-minute ceiling retain a reviewable
  // draft. Releasing the original held finger must never authorize auto-send.
  for (const reason of ['interruption', 'recorder-stop', 'limit']) {
    await hold(); await page.waitForTimeout(750);
    await page.evaluate(reason => {
      const state = window.voiceGestures;
      if (reason === 'interruption') state.tracks.at(-1).dispatchEvent(new Event('ended'));
      else if (reason === 'recorder-stop') {
        // The inactive state can be visible before the browser delivers onstop.
        state.app.voiceRecorder.recorder.stop();
        state.app.voiceRecorder.releaseHold();
      }
      else {
        state.app.voiceRecorder.samples = new Float32Array(state.MAX_VOICE_SAMPLES - state.VOICE_SAMPLE_RATE / 4);
        state.app.voiceRecorder.startedAt -= 2000;
      }
    }, reason);
    await paused(); await stopped(); await release();
    assert.equal(await sentCount(), 2, `${reason}: release auto-sent a stopped recording`);
    assert.equal(await recorder.getAttribute('data-mode'), 'locked');
    if (reason === 'limit') assert(await page.getByRole('button', { name: '继续录音', exact: true }).isDisabled());
    await page.getByRole('button', { name: '取消录音', exact: true }).click(); await closed();
  }

  await hold(); await page.waitForTimeout(550);
  await touch('touchMove', -165, 0);
  assert.equal(await recorder.getAttribute('data-gesture'), 'cancelling');
  const teardown = await page.evaluate(() => {
    const { app } = window.voiceGestures;
    const oldButton = document.querySelector('#record-voice');
    const begin = app.beginVoiceRecording;
    let starts = 0;
    app.beginVoiceRecording = mode => { starts++; return begin.call(app, mode); };
    try {
      window.dispatchEvent(new Event('pagehide'));
      // Holding a test-only reference lets us verify listener removal without
      // relying on nondeterministic garbage collection of the detached chat.
      oldButton.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      return { detached: !oldButton.isConnected, bindingReleased: app.voiceGesture === null, starts, retiringShapes: document.querySelectorAll('.voice-cancel-orb, .voice-cancel-bar').length };
    } finally { app.beginVoiceRecording = begin; }
  });
  assert.deepEqual(teardown, { detached: true, bindingReleased: true, starts: 0, retiringShapes: 0 }, 'Privacy teardown retained the old chat gesture, its listeners, or cancellation shapes');
  await release(); await stopped();
  assert.equal(await sentCount(), 2, 'Page teardown sent a held draft');
  assert.equal(await page.locator('.cover-trigger').count(), 1);
  await reset();
  const rebound = await page.evaluate(() => {
    const { app } = window.voiceGestures;
    const begin = app.beginVoiceRecording;
    let starts = 0;
    app.beginVoiceRecording = mode => { starts++; return begin.call(app, mode); };
    try {
      document.querySelector('#record-voice').click();
      return { bound: app.voiceGesture !== null, starts };
    } finally { app.beginVoiceRecording = begin; }
  });
  assert.deepEqual(rebound, { bound: true, starts: 1 }, 'Re-entering chat did not bind the new microphone exactly once');
  await recorded();
  await page.getByRole('button', { name: '取消录音', exact: true }).click(); await closed(); await stopped();
  assert.equal(await sentCount(), 2, 'Re-entering chat unexpectedly sent a draft');

  // Pointer capture must also survive a desktop mouse drag away from the
  // trigger while its large floating recording control replaces the composer.
  const mouseBounds = await page.locator('#record-voice').boundingBox();
  await page.mouse.move(mouseBounds.x + mouseBounds.width / 2, mouseBounds.y + mouseBounds.height / 2);
  // A newly acquired microphone can encode less audio than wall-clock time;
  // leave enough margin above the half-second minimum after the rebinding check.
  await page.mouse.down(); await recorded(); await page.waitForTimeout(1000);
  await page.mouse.move(mouseBounds.x - 25, mouseBounds.y - 20, { steps: 8 });
  await page.mouse.up();
  await closed().catch(async cause => {
    const state = await page.evaluate(() => {
      const { app, sends } = window.voiceGestures;
      const active = app.voiceRecorder;
      return { sends: sends.length, state: active?.state, mode: active?.mode, durationMs: active?.durationMs,
        holdReleased: active?.holdReleased, sendAfterProcessing: active?.sendAfterProcessing,
        message: active?.message, recorderState: active?.recorder?.state };
    });
    throw new Error(`Mouse release left a recorder active: ${JSON.stringify(state)}`, { cause });
  });
  await stopped();
  assert.equal(await sentCount(), 3, 'Mouse release failed to send exactly once');

  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.evaluate(color => { document.documentElement.dataset.colorScheme = color; }, colorScheme);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 }); await reset();
      const capture = async state => {
        // Capture the settled layout after microphone inflation and pause FLIP
        // transitions; the recording-dot pulse intentionally keeps running.
        await recorder.evaluate(async host => {
          await Promise.all(host.getAnimations({ subtree: true })
            .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations))
            .map(animation => animation.finished.catch(() => {})));
        });
        await inspectLayout(`${colorScheme}/${width}/${state}`);
        if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `voice-${state}-${colorScheme}-${width}.png`) });
      };
      await hold(); await page.waitForTimeout(700); await capture('hold');
      await touch('touchCancel'); await closed(); await stopped();
      await page.locator('#record-voice').tap(); await recorded(); await page.waitForTimeout(700); await capture('locked');
      await page.getByRole('button', { name: '暂停录音', exact: true }).click(); await paused(); await stopped(); await capture('paused');
      await page.getByRole('button', { name: '取消录音', exact: true }).click(); await closed();
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await hold(); await page.waitForTimeout(250); await inspectLayout('reduced-motion/hold');
  assert.equal(await recorder.evaluate(host => host.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length), 0, 'Reduced motion must stop both recording pulses and control animations');
  await touch('touchCancel'); await closed(); await stopped();
  assert.equal(await sentCount(), 3, 'Visual-state exercise unexpectedly sent a draft');
  assert.deepEqual(errors, []);
  process.stdout.write('Voice gestures E2E passed: native touch/mouse hold, release send, longer horizontal slide cancel with continuous resistance, immediate recording discard before rightward exit, no vertical lock/drag, pointer cancellation, pause/preview/resume, live hands-free send, late permission discard, tap/keyboard access, interruption/limit review, privacy teardown during cancellation and gesture rebinding, 320/390/1280px light/dark layouts and reduced motion.\n');
} finally { await browser?.close(); await server.close(); }
