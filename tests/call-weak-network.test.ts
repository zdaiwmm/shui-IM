import { describe, expect, it, vi } from 'vitest';
import { Peer, Track, pair, setup, SDP, getUserMedia } from './helpers/call-harness';
import { sealCallSignal } from '../src/lib/call-crypto';
import { WEAK_NETWORK_PROFILES } from '../src/lib/call-network-policy';
import { networkDelay } from '../src/lib/network-operation';
import { CallStageMonitor, CALL_STAGE_POLICY } from '../src/lib/call-connection';
import type { CallConnectionStage } from '../src/lib/call-connection';

async function attempt(relay = false) {
  const { a, b } = await pair();
  const harness = setup(a);
  if (relay) harness.getIceConfig.mockResolvedValue({ iceServers: [{ urls: ['turn:one.test?transport=udp', 'turn:two.test?transport=tcp', 'turns:three.test?transport=tcp'], username: 'fixture', credential: 'fixture' }], iceTransportPolicy: 'all', relayConfigured: true, expiresAt: Date.now() + 7_200_000, verifiedPeerIds: [b.identity.publicBundle.deviceId] });
  await harness.controller.start('video');
  await harness.controller.receive(await sealCallSignal(b, a.identity.publicBundle.deviceId, harness.sent[0]!.callId, 'accept', { kind: 'video', description: { type: 'answer', sdp: SDP } }));
  return { ...harness, a, b, peer: Peer.instances.at(-1)! };
}

function stats(rttMs = 100, uplinkLoss = 0, downlinkLoss = 0, protocol = 'udp', type = 'host') {
  return new Map([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: rttMs / 1000, availableOutgoingBitrate: rttMs >= 800 ? 90_000 : 2_000_000, localCandidateId: 'local' }],
    ['local', { id: 'local', type: 'local-candidate', candidateType: type, protocol: 'udp', relayProtocol: protocol, address: 'must-not-log', url: 'turn:must-not-log' }],
    ['in', { id: 'in', type: 'inbound-rtp', packetsReceived: 1000, packetsLost: downlinkLoss * 1000, jitter: rttMs >= 800 ? 0.13 : 0.01 }],
    ['out', { id: 'out', type: 'remote-inbound-rtp', fractionLost: uplinkLoss, packetsReceived: 1000, packetsLost: uplinkLoss * 1000 }],
  ] as [string, any][]);
}

describe('controlled weak-network controller injection (simulated paths, no TURN infrastructure claim)', () => {
  for (const profile of WEAK_NETWORK_PROFILES) it(`${profile.name}: connects, retains audio, cleans up and allows the next call`, async () => {
    const h = await attempt();
    vi.useFakeTimers();
    h.peer.getStats.mockResolvedValue(stats(profile.latencyMs, profile.uplinkLoss, profile.downlinkLoss));
    await vi.advanceTimersByTimeAsync(profile.latencyMs);
    h.peer.connect();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.controller.state.phase).toBe('connected');
    expect(h.controller.diagnosticsSnapshot?.setupMs).toBeGreaterThanOrEqual(profile.latencyMs);
    expect(h.controller.diagnosticsSnapshot?.setupMs).toBeLessThan(5000);
    const stream = h.controller.state.localStream!;
    const audio = stream.getAudioTracks()[0]!;
    if ('disconnectMs' in profile) {
      h.controller.setConnection(false);
      await vi.advanceTimersByTimeAsync(profile.disconnectMs);
      expect(h.controller.active).toBe(true);
      h.controller.setConnection(true);
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(audio.readyState).toBe('live');
    expect(audio.enabled).toBe(true);
    expect(h.controller.active).toBe(true);
    expect(h.peer.createOffer).toHaveBeenCalledTimes(1);
    expect(new Set(h.sent.map(frame => frame.eventId)).size).toBe(h.sent.length);
    const snapshot = JSON.stringify(h.controller.diagnosticsSnapshot);
    expect(snapshot).not.toContain('must-not-log');
    expect(snapshot).not.toContain(h.a.identity.publicBundle.deviceId);
    expect(snapshot).not.toContain(h.sent[0]!.callId);
    await h.controller.hangup();
    expect(stream.getTracks().every(track => track.readyState === 'ended')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await h.controller.start('audio');
    expect(h.controller.state.phase).toBe('outgoing');
    expect(h.controller.state.callId).not.toBe(h.sent[0]!.callId);
  });

  it('distinguishes ICE, DTLS and remote media readiness', async () => {
    const h = await attempt();
    vi.useFakeTimers();
    h.peer.iceConnectionState = 'connected';
    h.peer.onconnectionstatechange?.();
    expect(h.controller.state.phase).toBe('connecting');
    expect(h.controller.diagnosticsSnapshot?.stage).toBe('dtls-srtp');
    h.peer.connectionState = 'connected';
    h.peer.onconnectionstatechange?.();
    expect(h.controller.state.startedAt).toBeNull();
    expect(h.controller.diagnosticsSnapshot?.stage).toBe('media');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(h.controller.state.phase).toBe('ended');
    expect(h.controller.diagnosticsSnapshot?.errorCode).toBe('media:MEDIA_TIMEOUT');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('advances recollect → refreshed config → relay and ends explicitly if relay fails', async () => {
    const h = await attempt(true);
    vi.useFakeTimers();
    h.peer.iceConnectionState = 'failed'; h.peer.connectionState = 'failed'; h.peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(501);
    await vi.waitFor(() => expect(h.peer.createOffer).toHaveBeenCalledTimes(2));
    expect(h.getIceConfig).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect((h.controller as any).recoveryBusy).toBe(false));
    await vi.advanceTimersByTimeAsync(12_500);
    await vi.waitFor(() => expect(h.getIceConfig).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.peer.createOffer).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect((h.controller as any).recoveryBusy).toBe(false));
    await vi.advanceTimersByTimeAsync(12_500);
    await vi.waitFor(() => expect(h.peer.getConfiguration().iceTransportPolicy).toBe('relay'));
    await vi.waitFor(() => expect((h.controller as any).recoveryBusy).toBe(false));
    await vi.advanceTimersByTimeAsync(13_000);
    expect(h.controller.active).toBe(false);
    expect(h.controller.diagnosticsSnapshot?.errorCode).toBe('ice-checking:RELAY_FAILED');
    expect(h.controller.diagnosticsSnapshot?.iceRestarts).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const protocol of ['tcp', 'tls']) it(`retains surviving TURN ${protocol} when earlier transports fail`, async () => {
    const h = await attempt(true);
    vi.useFakeTimers();
    (h.peer as any).onicecandidateerror?.({ errorCode: 701 });
    if (protocol === 'tls') (h.peer as any).onicecandidateerror?.({ errorCode: 701 });
    expect(h.controller.active).toBe(true);
    h.peer.getStats.mockResolvedValue(stats(100, 0, 0, protocol, 'relay'));
    h.peer.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.controller.state.phase).toBe('connected');
    expect(h.controller.diagnosticsSnapshot).toMatchObject({ candidateType: 'relay', candidateProtocol: protocol, relay: true });
    expect(h.peer.createOffer).toHaveBeenCalledTimes(1);
  });

  it('recovers after the first ICE failure using a relay candidate on the second gathering', async () => {
    const h = await attempt(true);
    vi.useFakeTimers();
    h.peer.iceConnectionState = 'failed'; h.peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(501);
    await vi.waitFor(() => expect(h.peer.createOffer).toHaveBeenCalledTimes(2));
    h.peer.getStats.mockResolvedValue(stats(100, 0, 0, 'udp', 'relay'));
    h.peer.connect();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.controller.state.phase).toBe('connected');
    expect(h.controller.diagnosticsSnapshot?.relay).toBe(true);
    expect(h.controller.diagnosticsSnapshot?.iceRestarts).toBe(1);
  });

  it('keeps a successful path during a short network switch and restarts after a sustained outage', async () => {
    const h = await attempt();
    vi.useFakeTimers(); h.peer.getStats.mockResolvedValue(stats()); h.peer.connect();
    const audio = h.controller.state.localStream!.getAudioTracks()[0]!;
    h.peer.iceConnectionState = 'disconnected'; h.peer.connectionState = 'disconnected'; h.peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(1000); h.peer.connect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.peer.createOffer).toHaveBeenCalledTimes(1);
    h.peer.iceConnectionState = 'disconnected'; h.peer.connectionState = 'disconnected'; h.peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(3001);
    await vi.waitFor(() => expect(h.peer.createOffer).toHaveBeenCalledTimes(2));
    h.peer.connect();
    expect(audio.readyState).toBe('live');
    expect(h.controller.state.phase).toBe('connected');
  });

  it('pauses video only after sustained degradation and restores one step at a time', async () => {
    const h = await attempt();
    vi.useFakeTimers(); h.peer.getStats.mockResolvedValue(stats(800, 0.2, 0.2)); h.peer.connect();
    const audio = h.controller.state.localStream!.getAudioTracks()[0]!;
    const video = h.controller.state.localStream!.getVideoTracks()[0]!;
    await vi.advanceTimersByTimeAsync(50_000);
    await vi.waitFor(() => expect(h.controller.state.quality).toBe('audio-only')); expect(video.enabled).toBe(false); expect(audio.enabled).toBe(true);
    h.peer.getStats.mockResolvedValue(stats());
    await vi.advanceTimersByTimeAsync(32_000);
    await vi.waitFor(() => expect(h.controller.state.quality).toBe('recovering')); expect(video.enabled).toBe(true);
    const sender = h.peer.getSenders()[1]!;
    expect(sender.setParameters.mock.lastCall?.[0].encodings[0].maxBitrate).toBe(180_000);
    await vi.advanceTimersByTimeAsync(96_000);
    expect(h.controller.state.quality).toBe('good');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('retains established audio during a 15-second track interruption without restarting healthy ICE', async () => {
    const h = await attempt(); vi.useFakeTimers(); h.peer.connect();
    const localAudio = h.controller.state.localStream!.getAudioTracks()[0]!;
    const remoteAudio = h.controller.state.remoteStream!.getAudioTracks()[0]!;
    Object.defineProperty(remoteAudio, 'muted', { value: true, configurable: true });
    remoteAudio.onmute?.(new Event('mute'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.controller.active).toBe(true); expect(localAudio.readyState).toBe('live');
    expect(h.peer.createOffer).toHaveBeenCalledTimes(1);
    Object.defineProperty(remoteAudio, 'muted', { value: false, configurable: true });
    remoteAudio.onunmute?.(new Event('unmute'));
    expect(h.controller.state.phase).toBe('connected');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.controller.active).toBe(true);
  });

  it('retains healthy media when refresh fails but forbids expired credentials in a new restart', async () => {
    const h = await attempt(true); vi.useFakeTimers(); h.peer.connect();
    const audio = h.controller.state.localStream!.getAudioTracks()[0]!;
    (h.controller as any).configuration.expiresAt = Date.now() - 1;
    h.getIceConfig.mockRejectedValue(new TypeError('unreachable'));
    expect(await (h.controller as any).restartIce((h.controller as any).context)).toBe(false);
    expect(h.peer.createOffer).toHaveBeenCalledTimes(1); expect(audio.readyState).toBe('live');
    expect(h.controller.state.phase).toBe('connected');
    expect(h.controller.diagnosticsSnapshot?.failureStage).toBe('config');
  });

  it('never automatically reopens a camera explicitly disabled during audio-only mode', async () => {
    const h = await attempt();
    vi.useFakeTimers(); h.peer.getStats.mockResolvedValue(stats(800)); h.peer.connect();
    await vi.advanceTimersByTimeAsync(50_000);
    await h.controller.toggleCamera();
    h.peer.getStats.mockResolvedValue(stats());
    await vi.advanceTimersByTimeAsync(150_000);
    expect(h.controller.state.cameraEnabled).toBe(false);
    expect(h.controller.state.localStream!.getVideoTracks()).toHaveLength(0);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('cancels delayed configuration and ignores the old call result before a new call', async () => {
    const { a } = await pair(); const h = setup(a);
    const config = await h.getIceConfig();
    vi.useFakeTimers();
    h.getIceConfig.mockImplementationOnce(async () => { await networkDelay(800); return config; });
    const starting = h.controller.start('audio');
    await vi.waitFor(() => expect(h.getIceConfig).toHaveBeenCalledTimes(2));
    await h.controller.hangup();
    await vi.advanceTimersByTimeAsync(801); await starting;
    expect(Peer.instances).toHaveLength(0); expect(getUserMedia).not.toHaveBeenCalled();
    await h.controller.start('audio');
    expect(h.controller.state.phase).toBe('outgoing');
  });
});

describe('independent, idempotent stage clocks', () => {
  for (const stage of Object.keys(CALL_STAGE_POLICY) as CallConnectionStage[]) it(`${stage} has its own error, deadline and recovery action`, async () => {
    vi.useFakeTimers(); const events: unknown[] = []; const expired = vi.fn();
    const clock = new CallStageMonitor(event => events.push(event), expired);
    clock.begin(stage); clock.begin(stage);
    await vi.advanceTimersByTimeAsync(CALL_STAGE_POLICY[stage].timeoutMs);
    expect(expired).toHaveBeenCalledExactlyOnceWith(stage);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ stage, state: 'failed', code: CALL_STAGE_POLICY[stage].code, action: CALL_STAGE_POLICY[stage].action });
    clock.clear(); expect(vi.getTimerCount()).toBe(0);
  });
});
