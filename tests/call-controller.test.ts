import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallController } from '../src/lib/call-controller';
import { openCallSignal, sealCallSignal } from '../src/lib/call-crypto';
import { CALL_CAPABILITY, type CallEnvelope, type CallIceConfiguration } from '../src/lib/call-types';
import { generateIdentity } from '../src/lib/crypto';
import { authenticatedMlsCallMembers } from '../src/lib/call-membership';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, prepareMlsMembership, processMlsMembership } from '../src/lib/mls';
import type { Vault } from '../src/lib/types';

const SDP = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=sendrecv\r\n`;
class Track {
  id = crypto.randomUUID(); enabled = true; readyState = 'live'; onended: (() => void) | null = null;
  onmute = null; onunmute = null;
  constructor(public kind: string) {}
  stop = vi.fn(() => { this.readyState = 'ended'; });
}
class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  addTrack(track: Track) { this.tracks.push(track); }
  removeTrack(track: Track) { this.tracks = this.tracks.filter((item) => item !== track); }
}
class Sender {
  constructor(public track: Track | null) {}
  replaceTrack = vi.fn(async (track: Track | null) => { this.track = track; });
  setStreams() {}
  getParameters() { return { encodings: [{}] }; }
  setParameters = vi.fn(async () => {});
}
class Peer {
  static instances: Peer[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState = 'new'; iceConnectionState = 'new'; signalingState = 'stable';
  onicecandidate: ((event: unknown) => void) | null = null;
  ontrack = null; onconnectionstatechange: (() => void) | null = null; oniceconnectionstatechange = null;
  transceivers: { sender: Sender; receiver: { track: Track }; direction: string }[] = [];
  constructor() { Peer.instances.push(this); }
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: SDP }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: SDP }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    // Exercise the browser race where gathering starts before setLocalDescription resolves.
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 }) } });
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    if (!this.transceivers.length) { this.addTransceiver('audio'); this.addTransceiver('video'); }
  });
  addTransceiver(track: Track | string) {
    const kind = typeof track === 'string' ? track : track.kind;
    const transceiver = { sender: new Sender(typeof track === 'string' ? null : track), receiver: { track: new Track(kind) }, direction: 'sendrecv' };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() { return [...this.transceivers]; }
  getSenders() { return this.transceivers.map((item) => item.sender); }
  addIceCandidate = vi.fn(async () => {});
  close = vi.fn(() => { this.connectionState = 'closed'; });
  getStats = vi.fn(async () => new Map());
  getConfiguration() { return { iceServers: [] }; }
  setConfiguration = vi.fn();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { resolve, reject, promise };
}
async function pair() {
  const [a, b] = await Promise.all([generateIdentity(), generateIdentity()]);
  const common = { v: 3 as const, roomId: crypto.randomUUID(), accessToken: 'unused', pairingSecret: '', creatorFingerprint: '', lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const,
    members: [{ ...a.publicBundle, role: 'creator' as const, status: 'active' as const, joinProof: null, capabilities: [CALL_CAPABILITY] }, { ...b.publicBundle, role: 'joiner' as const, status: 'active' as const, joinProof: null, capabilities: [CALL_CAPABILITY] }] };
  const creator: Vault = { ...common, role: 'creator', identity: a, mls: await createCreatorMlsState(common.roomId, a, common.members) };
  creator.mls = await prepareCreatorWelcome(creator);
  const joiner: Vault = { ...common, role: 'joiner', identity: b, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
  joiner.mls = await joinMlsGroup(joiner, creator.mls.pendingWelcome!);
  creator.mls.pendingWelcome = undefined;
  await Promise.all([authenticatedMlsCallMembers(creator), authenticatedMlsCallMembers(joiner)]);
  return { a: creator, b: joiner };
}
const controllers: CallController[] = [];
function setup(vault: Vault) {
  const session = { vault: vault as Vault | null };
  const sent: CallEnvelope[] = [];
  const onPermissionChange = vi.fn();
  const getIceConfig = vi.fn(async (): Promise<CallIceConfiguration> => ({ iceServers: [], iceTransportPolicy: 'all' as const, relayConfigured: false, verifiedPeerIds: vault.members.filter((member) => member.status === 'active' && member.role !== vault.role).map((member) => member.deviceId) }));
  const controller = new CallController({ getVault: () => session.vault, send: (envelope) => { sent.push(envelope); }, getIceConfig, onChange: vi.fn(), onPermissionChange });
  controllers.push(controller);
  return { controller, session, sent, onPermissionChange, getIceConfig };
}
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Peer.instances = [];
  getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => new Stream([...(constraints.audio ? [new Track('audio')] : []), ...(constraints.video ? [new Track('video')] : [])]));
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => [{ kind: 'videoinput' }, { kind: 'videoinput' }]) } });
});
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.destroy());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function invite(a: Vault, b: Vault) {
  return sealCallSignal(a, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', { kind: 'video', description: { type: 'offer', sdp: SDP }, cameraEnabled: true });
}

describe('foreground call controller security lifecycle', () => {
  it('fails closed when an adapter returns raw ICE config without local identity verification', async () => {
    const { a } = await pair();
    const { controller, getIceConfig, sent } = setup(a);
    getIceConfig.mockImplementation(async () => ({ iceServers: [], iceTransportPolicy: 'all', relayConfigured: false }));
    await controller.start('audio');
    expect(Peer.instances).toHaveLength(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(controller.state.statusText).toContain('对方未准备好安全通话');
  });
  it('does not emit an offer or request capture for an unattested substituted encryption key', async () => {
    const { a, b } = await pair();
    const attacker = await generateIdentity();
    const substituted = { ...a, members: a.members.map((member) => member.deviceId === b.identity.publicBundle.deviceId ? { ...member, encryptionKey: attacker.publicBundle.encryptionKey } : member) };
    // The MLS leaf binds the signing key; an independent signed identity proof is required for this ECDH metadata.
    await authenticatedMlsCallMembers(substituted);
    const { controller, getIceConfig, sent } = setup(substituted);
    getIceConfig.mockImplementation(async () => ({ iceServers: [], iceTransportPolicy: 'all', relayConfigured: false, verifiedPeerIds: [] }));
    await controller.start('video');
    expect(Peer.instances).toHaveLength(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(controller.state.statusText).toContain('对方未准备好安全通话');
  });
  it('sends invitations only to devices in the locally verified identity-proof list', async () => {
    const { a, b } = await pair();
    const extraIdentity = await generateIdentity();
    const extra = { ...extraIdentity.publicBundle, role: 'joiner' as const, status: 'active' as const, joinProof: null, addedBy: b.identity.publicBundle.deviceId, capabilities: [CALL_CAPABILITY] };
    const added = await prepareMlsMembership(b, 'add', extra);
    const vault: Vault = { ...a, members: [...a.members, extra], mls: { ...a.mls! } };
    vault.mls!.groupState = await processMlsMembership(vault, added.event, 1);
    vault.mls!.lastEventSeq = 1;
    await authenticatedMlsCallMembers(vault);
    const { controller, getIceConfig, sent } = setup(vault);
    getIceConfig.mockImplementation(async () => ({ iceServers: [], iceTransportPolicy: 'all', relayConfigured: false, verifiedPeerIds: [b.identity.publicBundle.deviceId] }));
    await controller.start('audio');
    expect(sent.map((envelope) => envelope.recipientId)).toEqual([b.identity.publicBundle.deviceId]);
  });
  it('requires the caller identity proof before accepting and capturing media', async () => {
    const { a, b } = await pair();
    const { controller, getIceConfig, sent } = setup(b);
    getIceConfig.mockImplementation(async () => ({ iceServers: [], iceTransportPolicy: 'all', relayConfigured: false, verifiedPeerIds: [] }));
    await controller.receive(await invite(a, b));
    await controller.accept();
    expect(Peer.instances).toHaveLength(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(controller.state.statusText).toContain('对方未准备好安全通话');
  });
  it('verifies an incoming invitation before showing it and never requests media before acceptance', async () => {
    const { a, b } = await pair();
    const { controller, sent } = setup(b);
    const envelope = await invite(a, b);
    await controller.receive({ ...envelope, callId: crypto.randomUUID() });
    expect(controller.state.phase).toBe('idle');
    await controller.receive(envelope);
    expect(controller.state.phase).toBe('incoming');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(Peer.instances).toHaveLength(0);
    await controller.accept();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(sent[0]?.action).toBe('accept');
    expect(sent.slice(1).every((item) => item.action === 'signal')).toBe(true);
    expect((await openCallSignal(a, sent[0]!)).description?.type).toBe('answer');
  });
  it('processes a queued signed cancellation even when its invite is still decrypting', async () => {
    const { a, b } = await pair();
    const { controller } = setup(b);
    const envelope = await invite(a, b);
    const canceled = await sealCallSignal(a, b.identity.publicBundle.deviceId, envelope.callId, 'end', { kind: 'video', reason: 'canceled' });
    await Promise.all([controller.receive(envelope), controller.receive(canceled)]);
    expect(controller.state.phase).toBe('ended');
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('does not resurrect an invitation after a terminal server state arrived during decryption', async () => {
    const { a, b } = await pair();
    const { controller } = setup(b);
    const envelope = await invite(a, b);
    const receiving = controller.receive(envelope);
    controller.serverEvent({ type: 'call-state', callId: envelope.callId, state: 'ended', code: 'CALL_ENDED' });
    await receiving;
    expect(controller.state.phase).toBe('idle');
    const sibling = setup(b);
    const next = await invite(a, b);
    const nextReceiving = sibling.controller.receive(next);
    sibling.controller.serverEvent({ type: 'call-state', callId: next.callId, state: 'accepted', acceptedBy: crypto.randomUUID() });
    await nextReceiving;
    expect(sibling.controller.state.phase).toBe('idle');
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('prevents replayed invites from ringing again after the call is dismissed', async () => {
    const { a, b } = await pair();
    const { controller } = setup(b);
    const envelope = await invite(a, b);
    await controller.receive(envelope);
    await controller.decline();
    controller.dismiss();
    await controller.receive(envelope);
    expect(controller.state.phase).toBe('idle');
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('immediately closes the peer and stops a late permission grant after privacy lock', async () => {
    const { a } = await pair();
    const { controller, session, sent, onPermissionChange } = setup(a);
    const permission = deferred<Stream>();
    getUserMedia.mockReturnValue(permission.promise);
    const starting = controller.start('video');
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    const peer = Peer.instances[0]!;
    controller.destroy();
    session.vault = null;
    expect(peer.close).toHaveBeenCalledOnce();
    expect(onPermissionChange.mock.calls.map(([active]) => active)).toEqual([true, false]);
    const granted = new Stream([new Track('audio'), new Track('video')]);
    permission.resolve(granted);
    await starting;
    await Promise.resolve();
    expect(granted.getTracks().every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(sent).toHaveLength(0);
  });
  it('invalidates a late ICE configuration response and never starts capture after hangup', async () => {
    const { a } = await pair();
    const { controller, getIceConfig } = setup(a);
    const config = deferred<{ iceServers: never[]; iceTransportPolicy: 'all'; relayConfigured: false }>();
    getIceConfig.mockReturnValue(config.promise);
    const starting = controller.start('audio');
    await controller.hangup();
    config.resolve({ iceServers: [], iceTransportPolicy: 'all', relayConfigured: false });
    await starting;
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(Peer.instances).toHaveLength(0);
  });
  it('sends no caller ICE to ringing siblings and stops capture synchronously when hung up', async () => {
    const { a } = await pair();
    const { controller, sent } = setup(a);
    await controller.start('video');
    expect(sent.map((envelope) => envelope.action)).toEqual(['invite']);
    const stream = controller.state.localStream as unknown as Stream;
    const ending = controller.hangup();
    expect(stream.getTracks().every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(Peer.instances[0]!.close).toHaveBeenCalledOnce();
    await ending;
    expect(sent.at(-1)?.action).toBe('end');
  });
  it('honors first-device acceptance and tears down the losing callee without ending the winner', async () => {
    const { a, b } = await pair();
    const { controller, sent } = setup(b);
    const envelope = await invite(a, b);
    await controller.receive(envelope);
    const permission = deferred<Stream>();
    getUserMedia.mockReturnValue(permission.promise);
    const accepting = controller.accept();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    controller.serverEvent({ type: 'call-state', callId: envelope.callId, state: 'accepted', acceptedBy: crypto.randomUUID() });
    expect(controller.state.statusText).toContain('其他设备');
    const granted = new Stream([new Track('audio'), new Track('video')]);
    permission.resolve(granted);
    await accepting;
    expect(granted.getTracks().every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(sent).toHaveLength(0);
  });
  it('rejects late answers and stops an established call when the peer is revoked', async () => {
    const { a, b } = await pair();
    const { controller, session, sent } = setup(a);
    await controller.start('audio');
    const callId = sent[0]!.callId;
    const answer = await sealCallSignal(b, a.identity.publicBundle.deviceId, callId, 'accept', { kind: 'audio', description: { type: 'answer', sdp: SDP } });
    await controller.receive(answer);
    const peer = Peer.instances[0]!;
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
    session.vault = { ...a, members: a.members.map((member) => member.deviceId === b.identity.publicBundle.deviceId ? { ...member, status: 'revoked' } : member) };
    controller.updateMembers();
    expect(controller.active).toBe(false);
    expect(peer.close).toHaveBeenCalledOnce();
    await controller.receive(await sealCallSignal(b, a.identity.publicBundle.deviceId, callId, 'accept', { kind: 'audio', description: { type: 'answer', sdp: SDP } }));
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
  });
  it('stops video capture when camera is off and upgrades audio without renegotiation', async () => {
    const { a, b } = await pair();
    const { controller, sent } = setup(a);
    await controller.start('audio');
    await controller.receive(await sealCallSignal(b, a.identity.publicBundle.deviceId, sent[0]!.callId, 'accept', { kind: 'audio', description: { type: 'answer', sdp: SDP } }));
    const peer = Peer.instances[0]!;
    expect(peer.transceivers.map((item) => item.receiver.track.kind)).toEqual(['audio', 'video']);
    await controller.toggleCamera();
    expect(controller.state.cameraEnabled).toBe(true);
    const video = (controller.state.localStream as unknown as Stream).getVideoTracks()[0]!;
    await controller.toggleCamera();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(controller.state.cameraEnabled).toBe(false);
    expect(peer.createOffer).toHaveBeenCalledOnce();
    const media = await openCallSignal(b, sent.at(-1)!);
    expect(media.cameraEnabled).toBe(false);
    controller.toggleMicrophone();
    expect(controller.state.micMuted).toBe(true);
    expect(controller.state.localStream!.getAudioTracks()[0]!.enabled).toBe(false);
  });
  it('keeps ringing other devices after one recipient is unavailable and ends on a deliberate decline', async () => {
    const { a, b } = await pair();
    const extraIdentity = await generateIdentity();
    const extra = { ...extraIdentity.publicBundle, role: 'joiner' as const, status: 'active' as const, joinProof: null, addedBy: b.identity.publicBundle.deviceId, capabilities: [CALL_CAPABILITY] };
    const added = await prepareMlsMembership(b, 'add', extra);
    const vault: Vault = { ...a, members: [...a.members, extra], mls: { ...a.mls! } };
    vault.mls!.groupState = await processMlsMembership(vault, added.event, 1);
    vault.mls!.lastEventSeq = 1;
    await authenticatedMlsCallMembers(vault);
    const { controller, sent } = setup(vault);
    await controller.start('audio');
    const callId = sent[0]!.callId;
    controller.serverEvent({ type: 'call-state', callId, state: 'error', code: 'CALL_UNAVAILABLE', recipientId: extra.deviceId });
    expect(controller.state.phase).toBe('outgoing');
    const declined = await sealCallSignal(b, a.identity.publicBundle.deviceId, callId, 'decline', { kind: 'audio', reason: 'declined' });
    await controller.receive(declined);
    expect(controller.active).toBe(false);
    expect(controller.state.statusText).toContain('拒绝');
    const next = setup(vault);
    await next.controller.start('audio');
    const nextCallId = next.sent[0]!.callId;
    next.controller.serverEvent({ type: 'call-state', callId: nextCallId, state: 'error', code: 'CALL_UNAVAILABLE', recipientId: extra.deviceId });
    next.controller.serverEvent({ type: 'call-state', callId: nextCallId, state: 'error', code: 'CALL_UNAVAILABLE', recipientId: b.identity.publicBundle.deviceId });
    expect(next.controller.active).toBe(false);
    expect(next.controller.state.statusText).toContain('不在线');
  });
  it('ignores a late sibling-invite rejection after the server selected a device', async () => {
    const { a, b } = await pair();
    const { controller, sent } = setup(a);
    await controller.start('audio');
    const callId = sent[0]!.callId;
    controller.serverEvent({ type: 'call-state', callId, state: 'accepted', acceptedBy: b.identity.publicBundle.deviceId });
    controller.serverEvent({ type: 'call-state', callId, state: 'error', code: 'CALL_ALREADY_ACCEPTED', recipientId: crypto.randomUUID() });
    expect(controller.active).toBe(true);
  });
  it('refreshes ICE credentials on the scheduled renewal and cancels future renewal on teardown', async () => {
    const { a, b } = await pair();
    const { controller, sent, getIceConfig } = setup(a);
    await controller.start('audio');
    await controller.receive(await sealCallSignal(b, a.identity.publicBundle.deviceId, sent[0]!.callId, 'accept', { kind: 'audio', description: { type: 'answer', sdp: SDP } }));
    const peer = Peer.instances[0]!;
    vi.useFakeTimers();
    peer.connectionState = 'connected';
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(getIceConfig).toHaveBeenCalledTimes(2);
    expect(peer.setConfiguration).toHaveBeenCalledOnce();
    expect(peer.createOffer).toHaveBeenCalledTimes(2);
    controller.destroy();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(getIceConfig).toHaveBeenCalledTimes(2);
  });
  it('bounds ringing to 45 seconds and ignores an expired replay', async () => {
    const { a, b } = await pair();
    const envelope = await invite(a, b);
    vi.useFakeTimers();
    const { controller } = setup(b);
    await controller.receive(envelope);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(controller.state.phase).toBe('ended');
    expect(controller.state.statusText).toBe('未接听');
    controller.dismiss();
    await controller.receive(envelope);
    expect(controller.state.phase).toBe('idle');
  });
});
