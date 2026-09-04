import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyVoiceFlow({ creator, joiner, unlock, visualQaDirectory }) {
  const errors = [];
  const onError = error => errors.push(error.message);
  creator.on('pageerror', onError); joiner.on('pageerror', onError);
  await creator.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__voiceGetUserMedia = original; window.__voiceTracks = [];
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await original(options); window.__voiceTracks.push(...stream.getTracks()); return stream;
    };
  });
  const start = async () => {
    await creator.locator('#record-voice').click();
    await creator.locator('.voice-recorder[data-state="recording"]').waitFor();
  };
  const pause = async () => {
    await creator.getByRole('button', { name: '暂停录音', exact: true }).click();
    await creator.locator('.voice-recorder[data-state="paused"]').waitFor();
    assert(await creator.evaluate(() => window.__voiceTracks.every(track => track.readyState === 'ended')), 'Pause must release microphone tracks');
  };

  // Exercise the real browser recorder and local transcoder using a synthetic
  // microphone, never the developer's physical microphone.
  await start(); await creator.waitForTimeout(1200); await pause();
  await creator.getByRole('button', { name: '试听录音', exact: true }).click();
  await creator.getByRole('button', { name: '暂停试听', exact: true }).waitFor();
  await creator.getByRole('button', { name: '继续录音', exact: true }).click();
  await creator.locator('.voice-recorder[data-state="recording"]').waitFor();
  await creator.waitForTimeout(1200); await pause();
  if (visualQaDirectory) {
    await creator.screenshot({ path: path.join(visualQaDirectory, 'voice-draft-mobile.png') });
    await creator.setViewportSize({ width: 320, height: 720 });
    assert(await creator.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await creator.screenshot({ path: path.join(visualQaDirectory, 'voice-draft-small-mobile.png') });
    await creator.setViewportSize({ width: 390, height: 844 });
  }
  await creator.getByRole('button', { name: '发送语音', exact: true }).click();
  const incoming = joiner.locator('.message.incoming .voice-player').last();
  await incoming.waitFor();
  await creator.locator('.message.outgoing:has(.voice-player).is-delivered').waitFor();
  assert.equal(await incoming.locator('.voice-waveform i').count(), 48);
  await incoming.getByRole('button', { name: '播放语音', exact: true }).click();
  await incoming.getByRole('button', { name: '暂停语音', exact: true }).waitFor();
  await incoming.getByRole('button', { name: '暂停语音', exact: true }).click();
  assert.equal(await incoming.locator('input').isEnabled(), true);
  await incoming.locator('input').fill('1000');
  if (visualQaDirectory) {
    await joiner.screenshot({ path: path.join(visualQaDirectory, 'voice-message-mobile.png') });
    await joiner.emulateMedia({ colorScheme: 'dark' });
    await joiner.waitForTimeout(250);
    await joiner.screenshot({ path: path.join(visualQaDirectory, 'voice-message-dark.png') });
    await joiner.emulateMedia({ colorScheme: 'light' });
    await joiner.waitForTimeout(250);
    await creator.setViewportSize({ width: 1280, height: 900 });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'voice-message-desktop.png') });
    await creator.setViewportSize({ width: 390, height: 844 });
  }

  // Voice references remain ordinary encrypted replies, not copied transcripts.
  await joiner.locator('.message.incoming:has(.voice-player)').last().dispatchEvent('contextmenu');
  await joiner.getByRole('menuitem', { name: '回复', exact: true }).click();
  await joiner.locator('#message-input').fill('语音收到了');
  await joiner.locator('#composer').evaluate(form => form.requestSubmit());
  const reply = creator.locator('.message.incoming').filter({ hasText: '语音收到了' });
  await reply.waitFor();
  assert.match(await reply.locator('.message-reply-quote').innerText(), /语音/);

  // Holding the live composer trigger and releasing it must use the same real
  // encrypted attachment/outbox path and produce exactly one peer message.
  const beforeHold = await creator.locator('.voice-player').count();
  const beforePeerHold = await joiner.locator('.message.incoming .voice-player').count();
  const microphone = await creator.locator('#record-voice').boundingBox();
  assert(microphone, 'Microphone trigger must be visible for held recording');
  await creator.mouse.move(microphone.x + microphone.width / 2, microphone.y + microphone.height / 2);
  await creator.mouse.down();
  await creator.locator('.voice-recorder[data-mode="hold"][data-state="recording"]').waitFor();
  await creator.waitForTimeout(850);
  await creator.mouse.up();
  await creator.locator('.voice-recorder').waitFor({ state: 'hidden' });
  await creator.locator('.message.outgoing:has(.voice-player).is-delivered').nth(beforeHold).waitFor();
  await joiner.locator('.message.incoming .voice-player').nth(beforePeerHold).waitFor();
  assert.equal(await creator.locator('.voice-player').count(), beforeHold + 1);
  assert.equal(await joiner.locator('.message.incoming .voice-player').count(), beforePeerHold + 1);
  assert(await creator.evaluate(() => window.__voiceTracks.every(track => track.readyState === 'ended')), 'Hold release must stop every microphone track');

  const beforeCancel = await creator.locator('.voice-player').count();
  await start(); await creator.waitForTimeout(600);
  await creator.getByRole('button', { name: '取消录音', exact: true }).click();
  assert.equal(await creator.locator('.voice-player').count(), beforeCancel);
  assert(await creator.evaluate(() => window.__voiceTracks.every(track => track.readyState === 'ended')));

  // Failed uploads retain a frozen draft and retry as exactly one message.
  await start(); await creator.waitForTimeout(800); await pause();
  await creator.route('**/api/rooms/*/blobs', route => route.abort());
  await creator.getByRole('button', { name: '发送语音', exact: true }).click();
  await creator.locator('.voice-recording-hint').filter({ hasText: '录音已保留' }).waitFor();
  assert(await creator.getByRole('button', { name: '继续录音', exact: true }).isDisabled());
  await creator.unroute('**/api/rooms/*/blobs');
  await creator.getByRole('button', { name: '发送语音', exact: true }).click();
  await creator.locator('.message.outgoing:has(.voice-player).is-delivered').nth(beforeCancel).waitFor();
  assert.equal(await creator.locator('.voice-player').count(), beforeCancel + 1);

  // Re-locking tears down active playback and recording, including tracks and
  // Blob URLs; historical voice remains after a normal authenticated unlock.
  await creator.locator('.voice-player').first().getByRole('button', { name: '播放语音', exact: true }).click();
  await creator.locator('.voice-player').first().getByRole('button', { name: '暂停语音', exact: true }).waitFor();
  await creator.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await creator.locator('.cover-trigger').waitFor();
  await unlock(creator); await creator.locator('.chat-shell').waitFor();
  assert.equal(await creator.locator('.voice-player').count(), beforeCancel + 1);
  await start();
  await creator.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await creator.locator('.cover-trigger').waitFor();
  assert(await creator.evaluate(() => window.__voiceTracks.every(track => track.readyState === 'ended')));
  await unlock(creator); await creator.locator('.chat-shell').waitFor();

  // An unresolved permission prompt is not authorization to record after lock.
  await creator.evaluate(() => {
    window.__voiceWrappedGetUserMedia = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.__resolveVoicePermission = resolve; });
  });
  await creator.locator('#record-voice').click();
  await creator.locator('.voice-recorder[data-state="requesting"]').waitFor();
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await creator.locator('.cover-trigger').count(), 0, 'The first visible native permission blur must retain its requesting UI');
  await creator.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('blur')); });
  assert.equal(await creator.locator('.cover-trigger').count(), 1, 'A later unrelated blur must cover the conversation');
  await creator.evaluate(async () => {
    window.dispatchEvent(new Event('pagehide'));
    const stream = await window.__voiceGetUserMedia({ audio: true });
    window.__lateVoiceTracks = stream.getTracks();
    window.__resolveVoicePermission(stream);
    navigator.mediaDevices.getUserMedia = window.__voiceWrappedGetUserMedia;
  });
  await creator.waitForFunction(() => window.__lateVoiceTracks.every(track => track.readyState === 'ended'));
  assert.equal(await creator.locator('.cover-trigger').count(), 1);
  await unlock(creator); await creator.locator('.chat-shell').waitFor();

  await creator.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await creator.locator('#record-voice').click();
  await creator.locator('#notice').filter({ hasText: '麦克风权限' }).waitFor();
  assert.equal(await creator.locator('.voice-recorder').isVisible(), false);
  await creator.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__voiceWrappedGetUserMedia; });
  creator.off('pageerror', onError); joiner.off('pageerror', onError);
  assert.deepEqual(errors, []);
  process.stdout.write('Voice E2E passed: record, pause, resume, preview, held-release encrypted delivery, playback, seek, reply, cancel, upload retry, history and privacy cleanup.\n');
}
