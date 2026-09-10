import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__call_view', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><button id="behind">聊天</button></body></html>');
});
const screenshotDirectory = process.argv[2];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__call_view`);
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/call.css');
    const { CallView } = await import('/src/lib/call-view.ts');
    const events = [];
    const view = new CallView(Object.fromEntries(['accept', 'decline', 'hangup', 'toggleMicrophone', 'toggleCamera', 'switchCamera', 'dismiss'].map(name => [name, () => events.push(name)])));
    const state = { phase: 'incoming', callId: 'layout-check', kind: 'video', peerName: '对方', localStream: null, remoteStream: null, micMuted: false, cameraEnabled: false, remoteVideoEnabled: false, remoteMuted: false, facingMode: 'user', startedAt: null, statusText: '邀请你视频通话', quality: 'good', canSwitchCamera: false };
    document.body.append(view.element);
    view.update(state);
    window.callUi = { view, state, events };
  });
  await page.locator('.call-answer').waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('call-answer'));
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'call-control call-decline');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'call-control call-answer');
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => window.callUi.events), ['decline']);
  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDirectory, 'call-incoming-390.png') });
  }

  await page.evaluate(async () => {
    const ui = window.callUi;
    const local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    ui.state = { ...ui.state, phase: 'connected', localStream: local, remoteStream: local.clone(), cameraEnabled: true, remoteVideoEnabled: true, startedAt: Date.now() - 63000, statusText: '通话中', canSwitchCamera: true };
    ui.view.update(ui.state);
    ui.remoteNode = document.querySelector('.call-remote-video');
    ui.localNode = document.querySelector('.call-local-video');
    ui.remoteStream = ui.remoteNode.srcObject;
  });
  await page.waitForFunction(() => document.querySelector('.call-remote-video').readyState >= 2);
  const videoResult = await page.evaluate(() => {
    const ui = window.callUi;
    ui.state = { ...ui.state, micMuted: true, remoteMuted: true, quality: 'degraded' };
    ui.view.update(ui.state);
    return {
      sameRemoteNode: ui.remoteNode === document.querySelector('.call-remote-video'),
      sameLocalNode: ui.localNode === document.querySelector('.call-local-video'),
      sameStream: ui.remoteNode.srcObject === ui.remoteStream,
      localMuted: ui.localNode.muted,
      timer: document.querySelector('.call-timer').textContent,
      status: document.querySelector('.call-remote-hint').textContent,
    };
  });
  assert.equal(videoResult.sameRemoteNode && videoResult.sameLocalNode && videoResult.sameStream && videoResult.localMuted, true);
  assert.match(videoResult.timer, /^01:0[3-9]$/);
  assert.equal(videoResult.status, '对方已静音 · 视频画质已降低');

  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const bounds = await page.evaluate(() => {
      const screen = document.querySelector('.call-view').getBoundingClientRect();
      return [...document.querySelectorAll('.call-toolbar button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { label: button.getAttribute('aria-label'), fits: rect.left >= screen.left && rect.right <= screen.right && rect.top >= screen.top && rect.bottom <= screen.bottom, wide: rect.width >= 48, tall: rect.height >= 48 };
      });
    });
    assert.ok(bounds.every(button => button.fits && button.wide && button.tall), `Controls must fit at ${viewport.width}×${viewport.height}: ${JSON.stringify(bounds)}`);
    if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `call-connected-${viewport.width}.png`) });
  }

  await page.evaluate(() => {
    window.callUi.state = { ...window.callUi.state, facingMode: 'environment', phase: 'reconnecting', statusText: '正在重新连接…' };
    window.callUi.view.update(window.callUi.state);
  });
  assert.equal(await page.locator('.call-local-video').evaluate(video => getComputedStyle(video).transform), 'none');
  await page.evaluate(() => {
    const ui = window.callUi;
    ui.state = { ...ui.state, phase: 'ended', statusText: '对方已挂断' };
    ui.view.update(ui.state);
  });
  await page.waitForFunction(() => document.activeElement?.classList.contains('call-dismiss'));
  assert.equal(await page.locator('.call-timer').isVisible(), false);
  assert.equal(await page.locator('.call-status').textContent(), '对方已挂断');
  assert.equal(await page.locator('.call-remote-video').evaluate(video => video.srcObject), null);
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => window.callUi.events), ['decline', 'dismiss']);
  const destroyed = await page.evaluate(() => {
    const ui = window.callUi;
    for (const stream of [ui.state.localStream, ui.state.remoteStream]) stream.getTracks().forEach(track => track.stop());
    ui.view.destroy();
    return !document.querySelector('.call-view') && ui.localNode.srcObject === null && ui.remoteNode.srcObject === null;
  });
  assert.equal(destroyed, true);
  assert.deepEqual(errors, []);
  console.log('Call UI passed: focus trap, Escape, stable media elements, mute state, timer, 320px/landscape/desktop geometry, camera mirror and teardown.');
} finally {
  await browser?.close();
  await server.close();
}
