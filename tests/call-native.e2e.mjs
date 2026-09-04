import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ configFile: false, appType: 'custom', root: projectRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__call_native', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body></body></html>');
});
let browser;
try {
  await server.listen();
  const executable = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' };
  browser = await chromium.launch({ ...executable, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__call_native`);
  const result = await page.evaluate(async () => {
    const { CallController } = await import('/src/lib/call-controller.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { CALL_CAPABILITY } = await import('/src/lib/call-types.ts');
    const { authenticatedMlsCallMembers, signCallIdentityAttestation, verifyCallIdentityAttestations } = await import('/src/lib/call-membership.ts');
    const { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup } = await import('/src/lib/mls.ts');
    const check = (value, label) => { if (!value) throw new Error(label); };
    const wait = async (predicate, label, limit = 10_000) => {
      const deadline = Date.now() + limit;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      check(predicate(), typeof label === 'function' ? label() : label);
    };
    const [callerIdentity, calleeIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
    const members = [
      { ...callerIdentity.publicBundle, role: 'creator', status: 'active', joinProof: null, capabilities: [CALL_CAPABILITY] },
      { ...calleeIdentity.publicBundle, role: 'joiner', status: 'active', joinProof: null, capabilities: [CALL_CAPABILITY] },
    ];
    const common = {
      v: 3, roomId: crypto.randomUUID(), accessToken: 'unused', pairingSecret: '', creatorFingerprint: '',
      lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420',
      members,
    };
    const callerVault = { ...common, role: 'creator', identity: callerIdentity, mls: await createCreatorMlsState(common.roomId, callerIdentity, members) };
    callerVault.mls = await prepareCreatorWelcome(callerVault);
    const calleeVault = { ...common, role: 'joiner', identity: calleeIdentity, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
    calleeVault.mls = await joinMlsGroup(calleeVault, callerVault.mls.pendingWelcome);
    callerVault.mls.pendingWelcome = undefined;
    await Promise.all([authenticatedMlsCallMembers(callerVault), authenticatedMlsCallMembers(calleeVault)]);
    const callIdentities = await Promise.all([signCallIdentityAttestation(callerVault), signCallIdentityAttestation(calleeVault)]);
    let caller;
    let callee;
    let configRequests = 0;
    const actions = [];
    const options = (vault) => ({
      getVault: () => vault,
      getIceConfig: async () => {
        configRequests += 1;
        return { iceServers: [], iceTransportPolicy: 'all', relayConfigured: false, verifiedPeerIds: await verifyCallIdentityAttestations(vault, callIdentities) };
      },
      onChange: () => {}, onPermissionChange: () => {},
    });
    // Native browser media and DTLS run normally; only the already-tested authenticated server route is in-process.
    const route = (envelope, recipient) => {
      actions.push(envelope.action);
      if (envelope.action === 'accept') {
        const event = { type: 'call-state', callId: envelope.callId, state: 'accepted', acceptedBy: envelope.senderId };
        caller.serverEvent(event);
        callee.serverEvent(event);
      }
      void recipient.receive(envelope);
    };
    caller = new CallController({ ...options(callerVault), send: (envelope) => route(envelope, callee) });
    callee = new CallController({ ...options(calleeVault), send: (envelope) => route(envelope, caller) });
    try {
      await caller.start('audio');
      await wait(() => callee.state.phase === 'incoming', `Incoming invite missing: ${caller.state.statusText}`);
      check(callee.state.localStream === null, 'Incoming media started before acceptance');
      await callee.accept();
      await wait(() => caller.state.phase === 'connected' && callee.state.phase === 'connected', 'Native DTLS connection failed');

      await caller.toggleCamera();
      await wait(() => callee.state.remoteVideoEnabled, 'Remote camera state was not delivered');
      await wait(() => callee.state.remoteStream.getVideoTracks().some((track) => !track.muted), 'Remote video media did not arrive after audio upgrade');
      const videoTrack = caller.state.localStream.getVideoTracks()[0];
      await caller.toggleCamera();
      check(videoTrack.readyState === 'ended', 'Camera capture did not stop');
      await wait(() => !callee.state.remoteVideoEnabled, 'Remote camera-off state was not delivered');

      // Exercise a genuine ICE restart and both endpoints' fresh-credential path through the public online event.
      window.dispatchEvent(new Event('online'));
      await wait(() => configRequests >= 4 && caller.state.phase === 'connected' && callee.state.phase === 'connected', () => `ICE recovery failed: ${JSON.stringify({ configRequests, caller: caller.state.phase, callee: callee.state.phase, callerStatus: caller.state.statusText, calleeStatus: callee.state.statusText, callerSignaling: caller.pc?.signalingState, calleeSignaling: callee.pc?.signalingState, callerIce: caller.pc?.iceConnectionState, calleeIce: callee.pc?.iceConnectionState, actions })}`);

      const streams = [caller.state.localStream, callee.state.localStream];
      await caller.hangup();
      await wait(() => !callee.active, 'Remote end was not received');
      check(streams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')), 'Capture remained active after hangup');

      // A fresh initial video call in the opposite direction must deliver actual video at both endpoints.
      caller.dismiss();
      callee.dismiss();
      await callee.start('video');
      await wait(() => caller.state.phase === 'incoming', 'Reverse video invite missing');
      await caller.accept();
      await wait(() => caller.state.phase === 'connected' && callee.state.phase === 'connected', 'Initial video connection failed');
      await wait(() => [caller, callee].every((controller) => controller.state.remoteStream?.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted)), () => `Initial video tracks missing: ${JSON.stringify([caller, callee].map((controller) => ({ phase: controller.state.phase, localVideo: controller.state.cameraEnabled, remoteVideo: controller.state.remoteVideoEnabled, transceivers: controller.pc?.getTransceivers().map((item) => ({ direction: item.currentDirection, senderKind: item.sender.track?.kind, senderState: item.sender.track?.readyState, receiverKind: item.receiver.track.kind, receiverMuted: item.receiver.track.muted })) })))}`);
      const videoStreams = [caller.state.localStream, callee.state.localStream];
      await callee.hangup();
      await wait(() => !caller.active, 'Reverse video end was not received');
      check(videoStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')), 'Initial video capture remained after hangup');
      return { nativeDtlsConnection: true, audioToVideoUpgrade: true, cameraOffStopsCapture: true, iceRestartRefreshesBothEndpoints: true, initialBidirectionalVideo: true, hangupStopsBothEnds: true, actions };
    } finally {
      caller.destroy();
      callee.destroy();
    }
  });
  assert.deepEqual(errors, []);
  process.stdout.write(`Native call E2E passed: ${JSON.stringify(result)}\n`);
} finally {
  await browser?.close();
  await server.close();
}
