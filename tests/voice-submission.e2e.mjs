import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Real pointer/keyboard binding and recorder state transitions, with synthetic
// decoded audio and deliberately delayed local transport. No microphone or
// production room is accessed; voice-gestures covers Chrome's native recorder.
const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'voice-submission-fixture', configureServer(vite) {
    vite.middlewares.use('/__voice_submission', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body class="app-mode"><main id="app"><form id="composer" class="composer"><button id="record-voice" class="icon-button voice-record-button" type="button" aria-label="录制语音消息"></button><section class="voice-recorder" aria-label="录制语音消息" hidden></section></form></main></body></html>');
    });
  } }],
});
const directory = process.argv[2];
let browser;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__voice_submission`);
  await page.evaluate(async () => {
    for (const style of ['styles', 'chat-layout', 'gallery', 'auth-recovery', 'chat-interactions', 'cover', 'voice-messages', 'call']) await import(`/src/${style}.css`);
    const { VoiceRecorder } = await import('/src/lib/voice-recorder.ts');
    const { bindVoiceRecordGesture } = await import('/src/lib/voice-gesture.ts');
    const { voiceIcons } = await import('/src/lib/voice-audio.ts');
    const button = document.querySelector('#record-voice');
    const host = document.querySelector('.voice-recorder');
    button.innerHTML = voiceIcons.mic;
    const fixture = { active: null, attempts: [], snapshots: [], trackStops: 0, duration: 900 };
    const close = () => {
      fixture.active?.destroy(); fixture.active = null;
      host.hidden = true; button.hidden = false; button.focus({ preventScroll: true });
    };
    const begin = mode => {
      fixture.decode = null;
      button.hidden = true; host.hidden = false;
      const recorder = new VoiceRecorder(host, {
        permission: () => {}, cancel: close,
        fail: message => { fixture.failure = message; close(); },
        send: async (draft, signal) => {
          fixture.attempts.push(draft);
          await new Promise((resolve, reject) => { fixture.complete = resolve; fixture.reject = reject; });
          if (!signal.aborted) close();
        },
      }, mode);
      fixture.active = recorder;
      const track = { readyState: 'live', stop() { if (this.readyState === 'live') fixture.trackStops++; this.readyState = 'ended'; } };
      recorder.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      recorder.recorder = { state: 'recording', stop() {
        this.state = 'inactive';
        queueMicrotask(() => { if (!recorder.signal.aborted) void recorder.finishSegment('audio/wav'); });
      } };
      recorder.context = { state: 'running', decodeAudioData: () => new Promise(resolve => {
        fixture.decode = () => resolve(new AudioBuffer({ length: 24_000, sampleRate: 24_000, numberOfChannels: 1 }));
      }), close() { this.state = 'closed'; return Promise.resolve(); } };
      recorder.chunks = [new Blob(['synthetic recording'])];
      recorder.startedAt = performance.now() - fixture.duration;
      recorder.state = 'recording'; recorder.update();
      return recorder;
    };
    const binding = bindVoiceRecordGesture(button, begin);
    const visible = element => Boolean(element && !element.closest('[hidden]') && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden');
    fixture.inspect = () => ({
      state: host.dataset.state, submitting: host.dataset.submitting,
      controls: [...host.querySelectorAll('.voice-discard,.voice-draft-timeline,.voice-preview,.voice-send,.voice-toggle,.voice-cancel')].filter(visible).map(element => element.className),
      status: host.querySelector('.voice-recording-state')?.textContent,
      label: visible(host.querySelector('.voice-submit-label')),
    });
    fixture.watch = () => {
      fixture.snapshots = []; fixture.watching = true;
      const frame = () => { if (!fixture.watching) return; fixture.snapshots.push(fixture.inspect()); requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    };
    fixture.close = close; fixture.binding = binding;
    window.voiceSubmission = fixture;
  });
  if (directory) await mkdir(directory, { recursive: true });
  const screenshot = async name => { if (directory) await page.screenshot({ path: path.join(directory, `${name}.png`) }); };
  const hold = async () => {
    const box = await page.locator('#record-voice').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => window.voiceSubmission.active?.state === 'recording');
  };
  const assertBusy = async state => {
    await page.waitForFunction(state => document.querySelector('.voice-recorder').dataset.state === state, state);
    const view = await page.evaluate(() => window.voiceSubmission.inspect());
    assert.equal(view.submitting, 'true'); assert.deepEqual(view.controls, [], `${state}: draft controls flashed`);
    assert.equal(view.label, true); assert(view.status?.includes(state === 'processing' ? '处理' : '发送'));
  };

  await page.keyboard.press('Tab');
  await page.locator('#record-voice').focus();
  assert(await page.locator('#record-voice').evaluate(button => button.matches(':focus-visible') && parseFloat(getComputedStyle(button).outlineWidth) >= 2), 'Keyboard trigger lost its visible focus indicator');
  await hold();
  await page.evaluate(() => window.voiceSubmission.watch());
  await page.mouse.up(); await assertBusy('processing');
  await page.waitForTimeout(180); await screenshot('hold-release-processing');
  assert.equal(await page.evaluate(() => window.voiceSubmission.trackStops), 1, 'Release retained the capture track');
  await page.waitForFunction(() => typeof window.voiceSubmission.decode === 'function');
  await page.evaluate(() => window.voiceSubmission.decode()); await assertBusy('sending');
  await page.waitForTimeout(180); await screenshot('hold-release-sending');
  const snapshots = await page.evaluate(() => { window.voiceSubmission.watching = false; return window.voiceSubmission.snapshots; });
  assert(snapshots.some(sample => sample.state === 'processing') && snapshots.some(sample => sample.state === 'sending'));
  assert(snapshots.every(sample => sample.controls.length === 0), 'A rendered frame exposed draft controls during automatic submission');

  await page.evaluate(() => window.voiceSubmission.reject(new Error('合成上传失败')));
  await page.waitForFunction(() => window.voiceSubmission.active?.state === 'paused');
  assert.equal(await page.locator('.voice-discard').isVisible(), true);
  assert.equal(await page.locator('.voice-draft-timeline').isVisible(), true);
  assert.equal(await page.locator('.voice-send').isEnabled(), true);
  assert.equal(await page.locator('.voice-toggle').isDisabled(), true, 'Failed frozen draft allowed editing after send');
  assert.match(await page.locator('.voice-recording-hint').textContent(), /录音已保留/);
  await screenshot('failed-draft-recovered');
  await page.locator('.voice-send').click(); await assertBusy('sending');
  assert.equal(await page.evaluate(() => {
    const attempts = window.voiceSubmission.attempts;
    return attempts.length === 2 && attempts[0] === attempts[1] && attempts[0].file === attempts[1].file && attempts[0].clientMsgId === attempts[1].clientMsgId;
  }), true, 'Retry changed the frozen file or message identity');
  await page.evaluate(() => window.voiceSubmission.complete());
  await page.waitForFunction(() => !window.voiceSubmission.active);
  assert.equal(await page.locator('#record-voice').evaluate(button => getComputedStyle(button).outlineStyle === 'none' && document.activeElement === button), true, 'Pointer send completion restored the microphone with a blue focus ring');
  await screenshot('pointer-focus-restored');

  await page.keyboard.press('Tab'); await page.locator('#record-voice').focus();
  assert(await page.locator('#record-voice').evaluate(button => button.matches(':focus-visible') && parseFloat(getComputedStyle(button).outlineWidth) >= 2), 'Keyboard navigation did not restore its focus ring after pointer recording');
  await screenshot('keyboard-focus-restored');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.voice-recorder').getAttribute('data-mode'), 'locked');
  await page.locator('.voice-toggle').click();
  await page.waitForFunction(() => document.querySelector('.voice-recorder').dataset.state === 'processing');
  assert.equal(await page.locator('.voice-draft-timeline').isVisible(), true, 'An explicit pause lost draft review');
  await page.waitForFunction(() => typeof window.voiceSubmission.decode === 'function');
  await page.evaluate(() => window.voiceSubmission.decode());
  await page.waitForFunction(() => window.voiceSubmission.active?.state === 'paused');
  assert.equal(await page.locator('.voice-preview').isEnabled(), true);
  await page.locator('.voice-discard').click();

  await page.evaluate(() => { window.voiceSubmission.duration = 10; });
  await hold(); await page.evaluate(() => { window.voiceSubmission.active.startedAt = performance.now() - 100; });
  await page.mouse.up(); await assertBusy('processing');
  await page.waitForFunction(() => typeof window.voiceSubmission.decode === 'function');
  await page.evaluate(() => window.voiceSubmission.decode());
  await page.waitForFunction(() => window.voiceSubmission.active?.state === 'paused');
  assert.equal(await page.locator('.voice-send').isDisabled(), true);
  assert.equal(await page.locator('.voice-toggle').isEnabled(), true);
  assert.match(await page.locator('.voice-recording-hint').textContent(), /至少半秒/);
  assert.equal(await page.evaluate(() => window.voiceSubmission.attempts.length), 2, 'A short hold bypassed the minimum recording duration');
  await page.locator('.voice-discard').click();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pointerFocusQuiet: true, keyboardFocusVisible: true, processingAndSendingFrames: snapshots.length, draftControlsDuringSubmission: 0, failedDraftRestored: true, retryRetainsSameDraftFileAndId: true, explicitPauseReview: true, shortRecordingReview: true, browserErrors: 0 }));
} finally { await browser?.close(); await server.close(); }
