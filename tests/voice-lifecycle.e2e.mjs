import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__voice_lifecycle', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><div id="app"></div></body></html>');
});
let browser;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__voice_lifecycle`);
  const results = await page.evaluate(async () => {
    const { QuietRoomApp } = await import('/src/app.ts');
    const { VoicePlayer, VoicePlayback } = await import('/src/lib/voice-player.ts');
    const { VoiceRecorder } = await import('/src/lib/voice-recorder.ts');
    const { MAX_VOICE_SAMPLES } = await import('/src/lib/voice-audio.ts');
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    app.updateSafetyCode = async () => {}; app.updateBackgroundNotificationControl = async () => {};
    app.flushUiPreferencesSave = () => {};
    const fresh = (capabilities = ['voice-message-v1']) => {
      app.lockNow();
      const own = { deviceId: 'own', role: 'creator', status: 'active', capabilities };
      app.session = { vault: { role: 'creator', protocol: 'legacy-v1', members: [own], identity: { publicBundle: own } } };
      app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
      app.renderChat();
    };
    const check = (value, message) => { if (!value) throw Error(message); };
    fresh([]);
    let requests = 0;
    navigator.mediaDevices.getUserMedia = () => { requests++; return new Promise(() => {}); };
    app.beginVoiceRecording();
    check(requests === 0 && !app.voiceRecorder, 'Old device gate requested a microphone');
    check(document.querySelector('#notice').textContent.includes('所有已授权设备'), 'Compatibility explanation missing');

    // Cancel one prompt and start a second; a late first grant cannot clear the
    // second request's ownership or revive its discarded UI.
    fresh();
    const grants = [];
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => grants.push(resolve));
    app.beginVoiceRecording(); const oldRecorder = app.voiceRecorder;
    app.closeVoiceRecorder(); app.beginVoiceRecording(); const currentRecorder = app.voiceRecorder;
    let stops = 0; grants[0]({ getTracks: () => [{ stop: () => stops++ }] });
    await Promise.resolve(); await Promise.resolve();
    check(stops === 1 && oldRecorder.signal.aborted && app.voiceRecorder === currentRecorder && app.microphonePromptActive, 'Late grant crossed recorder ownership');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;
    check(document.querySelector('.cover-trigger') && currentRecorder.signal.aborted, 'Hidden permission request did not lock');
    grants[1]({ getTracks: () => [{ stop: () => stops++ }] });
    await Promise.resolve(); check(stops === 2, 'Late locked grant retained microphone');

    // Bound prompt lifetime even if the user leaves permission unanswered.
    fresh();
    const originalTimeout = window.setTimeout;
    let expire;
    window.setTimeout = (fn, delay, ...args) => {
      if (delay === 30_000) { expire = fn; return 0; }
      return originalTimeout(fn, delay, ...args);
    };
    app.beginVoiceRecording(); window.setTimeout = originalTimeout; expire();
    check(!app.voiceRecorder && !app.microphonePromptActive, 'Prompt timeout left a recorder active');
    check(document.querySelector('#notice').textContent.includes('超时'), 'Prompt timeout has no explanation');

    fresh();
    const message = { seq: 1, clientMsgId: 'voice-receipt', senderId: 'own', payload: { v: 1, kind: 'audio', durationMs: 1000, waveform: [1, 50], audio: {}, sentAt: new Date().toISOString() }, status: 'stored', acceptedAt: new Date().toISOString() };
    app.messages.set(1, message); app.renderMessages();
    const receiptPlayer = root.querySelector('.voice-player');
    let releases = 0;
    app.voicePlayback.current = { element: receiptPlayer, release: () => releases++ };
    message.status = 'delivered'; app.renderMessages();
    check(root.querySelector('.voice-player') === receiptPlayer && releases === 0, 'Delivery receipt interrupted playback');
    app.lockNow();

    // Verify cancellation across an unresolved download. Only the active
    // player's verified Blob may ever receive an object URL.
    root.replaceChildren();
    const playback = new VoicePlayback();
    const payload = { durationMs: 1000, waveform: [0, 20, 100], audio: {} };
    let resolveFirst, resolveSecond, firstSignal, secondSignal;
    const first = new VoicePlayer(payload, playback, signal => { firstSignal = signal; return new Promise(resolve => { resolveFirst = resolve; }); });
    const second = new VoicePlayer(payload, playback, signal => { secondSignal = signal; return new Promise(resolve => { resolveSecond = resolve; }); });
    root.append(first.element, second.element);
    first.element.querySelector('button').click(); second.element.querySelector('button').click();
    check(firstSignal.aborted && !secondSignal.aborted, 'Two audio downloads remained active');
    playback.stop(); check(secondSignal.aborted, 'Lock did not abort active audio download');
    resolveFirst(new Blob(['discard'])); resolveSecond(new Blob(['discard']));
    await Promise.resolve(); await Promise.resolve();
    check(!first.audio.src && !second.audio.src && !first.url && !second.url, 'Late download created playable plaintext');

    // Limit state is reviewable, never auto-sent; late send completion after
    // teardown cannot restore controls or plaintext.
    const host = document.createElement('section'); root.append(host);
    let sent = 0, settle;
    const recorder = new VoiceRecorder(host, { permission: () => {}, cancel: () => {}, fail: () => {}, send: () => { sent++; return new Promise(resolve => { settle = resolve; }); } });
    recorder.samples = new Float32Array(MAX_VOICE_SAMPLES); recorder.state = 'paused'; recorder.update();
    check(host.querySelector('.voice-toggle').disabled && !host.querySelector('.voice-send').disabled && sent === 0, 'Duration limit auto-sent or allowed more recording');
    const sending = recorder.send(); recorder.destroy(); settle(); await sending;
    check(host.childElementCount === 0 && recorder.signal.aborted && recorder.samples.length === 0, 'Late send revived a destroyed draft');
    return { compatibilityGate: true, latePermissionIsolation: true, hiddenPromptLocks: true, promptTimeout: true, receiptPreservesPlayback: true, singlePlayback: true, lateDownloadDiscarded: true, limitRequiresSend: true, lateSendDiscarded: true };
  });
  assert.deepEqual(errors, []);
  process.stdout.write(`Voice lifecycle E2E passed: ${JSON.stringify(results)}\n`);
} finally { await browser?.close(); await server.close(); }
