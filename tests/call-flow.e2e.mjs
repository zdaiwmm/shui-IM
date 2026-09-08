import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

/** Exercise the shipped app and its authenticated WebSocket route using synthetic browser devices. */
export async function verifyCallFlow({ creator, joiner, unlock, visualQaDirectory }) {
  const pages = [creator, joiner];
  const errors = [];
  const onError = (error) => errors.push(error.message);
  const phase = (page, value) => page.locator(`.call-view[data-phase="${value}"]`);
  const tracksStopped = async (page) => {
    await page.waitForFunction(() => window.__callFlow?.tracks.every((track) => track.readyState === 'ended'));
  };
  const ready = async (page) => {
    await page.locator('.chat-shell').waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector('#start-video-call');
      return button instanceof HTMLButtonElement && !button.disabled;
    }, null, { timeout: 15_000 });
  };
  const start = async (page, kind) => {
    await ready(page);
    await page.locator('#open-chat-tools').click();
    await page.locator(`#chat-tools #start-${kind}-call`).click();
    await phase(page, 'outgoing').waitFor();
  };
  const connect = async (caller, callee, kind) => {
    const before = await callee.evaluate(() => window.__callFlow.requests);
    await start(caller, kind);
    await phase(callee, 'incoming').waitFor({ timeout: 15_000 });
    assert.equal(await callee.evaluate(() => window.__callFlow.requests), before, 'An incoming call must not capture before user acceptance');
    await callee.locator('.call-answer').click();
    await Promise.all(pages.map((page) => phase(page, 'connected').waitFor({ timeout: 20_000 })));
  };
  const dismiss = async (page) => {
    await phase(page, 'ended').waitFor();
    await page.locator('.call-dismiss').click();
    await page.locator('.call-view').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#app').evaluate((element) => element.inert), false, 'Returning to chat must restore interaction');
    await ready(page);
  };
  const capture = async (page, name) => {
    if (visualQaDirectory) await page.screenshot({ path: path.join(visualQaDirectory, name) });
  };
  const remoteVideoArrives = async (page) => {
    await page.waitForFunction(() => {
      const video = document.querySelector('.call-remote-video');
      return video instanceof HTMLVideoElement && video.srcObject instanceof MediaStream &&
        video.srcObject.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
    }, null, { timeout: 15_000 }).catch(async (cause) => {
      const diagnostics = await Promise.all(pages.map(async (participant, index) => ({
        participant: index === 0 ? 'creator' : 'joiner',
        media: await participant.evaluate(async () => {
          const trackState = (track) => ({ kind: track.kind, readyState: track.readyState, muted: track.muted, enabled: track.enabled });
          const view = document.querySelector('.call-view');
          const video = document.querySelector('.call-remote-video');
          const peers = await Promise.all(window.__callFlow.peers.filter((peer) => peer.connectionState !== 'closed').map(async (peer) => ({
            connection: peer.connectionState, ice: peer.iceConnectionState, signaling: peer.signalingState,
            transceivers: peer.getTransceivers().map((item) => ({ direction: item.direction, currentDirection: item.currentDirection, sender: item.sender.track && trackState(item.sender.track), receiver: trackState(item.receiver.track) })),
            statistics: [...(await peer.getStats()).values()].filter((item) => ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(item.type)).map((item) => ({ type: item.type, kind: item.kind, bytesSent: item.bytesSent, bytesReceived: item.bytesReceived, framesEncoded: item.framesEncoded, framesDecoded: item.framesDecoded, frames: item.frames })),
          })));
          return { phase: view?.dataset.phase, classes: view?.className, status: view?.querySelector('.call-status')?.textContent, remoteTracks: video?.srcObject instanceof MediaStream ? video.srcObject.getTracks().map(trackState) : null, localTracks: window.__callFlow.tracks.map(trackState), peers };
        }),
      })));
      process.stderr.write(`Call media failure: ${JSON.stringify(diagnostics)}\n`);
      if (visualQaDirectory) await writeFile(path.join(visualQaDirectory, 'call-media-failure.json'), JSON.stringify(diagnostics, null, 2));
      throw new Error(`Remote video did not arrive for ${page === creator ? 'creator' : 'joiner'}`, { cause });
    });
    const playback = page.locator('.call-playback');
    if (await playback.isVisible()) await playback.click();
  };

  for (const page of pages) {
    page.on('pageerror', onError);
    await page.evaluate(() => {
      const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const setTimer = window.setTimeout.bind(window);
      const clearTimer = window.clearTimeout.bind(window);
      const peerConstructor = window.RTCPeerConnection;
      window.__callFlow = { media, setTimer, clearTimer, peerConstructor, peers: [], tracks: [], requests: 0, idleTimers: new Set(), deferNext: false, resolvePermission: null };
      window.RTCPeerConnection = new Proxy(peerConstructor, { construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        window.__callFlow.peers.push(peer);
        return peer;
      } });
      navigator.mediaDevices.getUserMedia = async (options) => {
        const state = window.__callFlow;
        state.requests += 1;
        if (state.deferNext) {
          state.deferNext = false;
          return new Promise((resolve) => { state.resolvePermission = resolve; });
        }
        const stream = await media(options);
        state.tracks.push(...stream.getTracks());
        return stream;
      };
      // Observe actual app idle-lock scheduling without accelerating clocks, signaling expiry or media timers.
      window.setTimeout = (callback, delay, ...args) => {
        const id = setTimer(callback, delay, ...args);
        if (delay === 10 * 60_000) window.__callFlow.idleTimers.add(id);
        return id;
      };
      window.clearTimeout = (id) => {
        window.__callFlow.idleTimers.delete(id);
        return clearTimer(id);
      };
    });
  }

  try {
    await Promise.all(pages.map(ready));

    // Launch through the real More menu, answer, mute remotely, then upgrade the negotiated audio call.
    await connect(creator, joiner, 'audio');
    assert.equal(await creator.locator('.call-type').innerText(), '语音通话');
    await creator.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    assert.equal(await creator.evaluate(() => window.__callFlow.idleTimers.size), 0, 'An active call must suspend the ten-minute idle lock, including after activity');
    await capture(creator, 'call-audio-connected-mobile.png');
    await creator.locator('.call-mic').click();
    await creator.locator('.call-mic[aria-pressed="true"]').waitFor();
    await joiner.locator('.call-remote-hint').filter({ hasText: '对方已静音' }).waitFor();
    assert(await creator.evaluate(() => window.__callFlow.tracks.filter((track) => track.kind === 'audio' && track.readyState === 'live').every((track) => !track.enabled)), 'Mute must disable the actual microphone track');
    await creator.locator('.call-mic').click();
    await creator.locator('.call-mic[aria-pressed="false"]').waitFor();
    await creator.locator('.call-camera').click();
    await creator.locator('.call-view.call-has-local-video').waitFor();
    await joiner.locator('.call-view.call-has-remote-video').waitFor();
    await remoteVideoArrives(joiner);
    await capture(joiner, 'call-audio-upgraded-video-mobile.png');
    await creator.evaluate(() => { window.__callFlow.toggledCamera = window.__callFlow.tracks.filter((track) => track.kind === 'video' && track.readyState === 'live'); });
    await creator.locator('.call-camera').click();
    await creator.waitForFunction(() => window.__callFlow.toggledCamera.every((track) => track.readyState === 'ended'));
    await joiner.locator('.call-view.call-has-remote-video').waitFor({ state: 'hidden' });
    await creator.locator('.call-hangup').click();
    await Promise.all(pages.map((page) => phase(page, 'ended').waitFor()));
    await Promise.all(pages.map(tracksStopped));
    assert((await creator.evaluate(() => window.__callFlow.idleTimers.size)) > 0, 'The idle lock must resume once the call ends');
    await dismiss(creator);
    await dismiss(joiner);

    // Full video works in the opposite direction; pagehide must immediately release both kinds of capture.
    const creatorRequests = await creator.evaluate(() => window.__callFlow.requests);
    await start(joiner, 'video');
    await phase(creator, 'incoming').waitFor();
    assert.equal(await creator.evaluate(() => window.__callFlow.requests), creatorRequests);
    await capture(creator, 'call-video-incoming-mobile.png');
    await creator.locator('.call-answer').click();
    await Promise.all(pages.map((page) => phase(page, 'connected').waitFor({ timeout: 20_000 })));
    await Promise.all(pages.map(remoteVideoArrives));
    await capture(creator, 'call-video-connected-mobile.png');
    if (visualQaDirectory) {
      const viewport = creator.viewportSize();
      await creator.setViewportSize({ width: 844, height: 390 });
      await capture(creator, 'call-video-connected-landscape.png');
      if (viewport) await creator.setViewportSize(viewport);
    }
    await joiner.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await joiner.locator('.cover-trigger').waitFor();
    await tracksStopped(joiner);
    assert.equal(await joiner.locator('.call-view').count(), 0, 'Privacy lock must remove every call media node');
    await phase(creator, 'ended').waitFor({ timeout: 15_000 });
    await tracksStopped(creator);
    await dismiss(creator);
    await unlock(joiner);
    await ready(joiner);

    // A deliberate refusal and a caller cancellation each stop ringing without capturing at the callee.
    for (const outcome of ['decline', 'cancel']) {
      const before = await joiner.evaluate(() => window.__callFlow.requests);
      await start(creator, 'video');
      await phase(joiner, 'incoming').waitFor();
      if (outcome === 'decline') await joiner.locator('.call-decline').click();
      else await creator.locator('.call-hangup').click();
      await Promise.all(pages.map((page) => phase(page, 'ended').waitFor()));
      assert.equal(await joiner.evaluate(() => window.__callFlow.requests), before, 'Refused or canceled incoming calls must never request media');
      await Promise.all(pages.map(tracksStopped));
      await dismiss(creator);
      await dismiss(joiner);
    }

    // Browser suspension is a lock as well, and cannot leave an audio-only call capturing.
    await connect(creator, joiner, 'audio');
    await creator.evaluate(() => document.dispatchEvent(new Event('freeze')));
    await creator.locator('.cover-trigger').waitFor();
    await tracksStopped(creator);
    await phase(joiner, 'ended').waitFor({ timeout: 15_000 });
    await tracksStopped(joiner);
    await dismiss(joiner);
    await unlock(creator);
    await ready(creator);

    // An unanswered native permission request may resolve after the app locks; its tracks must be discarded.
    await creator.bringToFront();
    await creator.evaluate(() => { window.__callFlow.deferNext = true; });
    await start(creator, 'audio');
    await creator.waitForFunction(() => typeof window.__callFlow.resolvePermission === 'function');
    await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await creator.locator('.cover-trigger').count(), 0, 'The owned foreground call permission prompt must not lock the app');
    await creator.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('blur'));
    });
    await creator.locator('.cover-trigger').waitFor();
    await creator.evaluate(async () => {
      const state = window.__callFlow;
      const stream = await state.media({ audio: true });
      state.lateTracks = stream.getTracks();
      state.tracks.push(...state.lateTracks);
      state.resolvePermission(stream);
      state.resolvePermission = null;
    });
    await creator.waitForFunction(() => window.__callFlow.lateTracks.every((track) => track.readyState === 'ended'));
    assert.equal(await creator.locator('.call-view').count(), 0, 'A late permission result must not recreate the call screen');
    assert.equal(await joiner.locator('.call-view').count(), 0, 'No invite may be sent after the caller locked during permission');
    await unlock(creator);
    await ready(creator);
    assert.deepEqual(errors, []);
    process.stdout.write('App call E2E passed: authenticated voice/video, acceptance, microphone mute, camera upgrade/stop, idle suspension, decline/cancel, pagehide/freeze, and late permission cleanup.\n');
  } finally {
    for (const page of pages) {
      page.off('pageerror', onError);
      if (!page.isClosed()) await page.evaluate(() => {
        const state = window.__callFlow;
        if (!state) return;
        navigator.mediaDevices.getUserMedia = state.media;
        window.RTCPeerConnection = state.peerConstructor;
        window.setTimeout = state.setTimer;
        window.clearTimeout = state.clearTimer;
        // Ensure test failures cannot leave synthetic capture running before the suite's browser teardown.
        state.tracks.forEach((track) => { if (track.readyState === 'live') track.stop(); });
      }).catch(() => {});
    }
  }
}
