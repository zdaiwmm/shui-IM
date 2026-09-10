import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallController } from '../../src/lib/call-controller';
import { openCallSignal, sealCallSignal } from '../../src/lib/call-crypto';
import { CALL_CAPABILITY, type CallEnvelope, type CallIceConfiguration } from '../../src/lib/call-types';
import { generateIdentity } from '../../src/lib/crypto';
import { authenticatedMlsCallMembers } from '../../src/lib/call-membership';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, prepareMlsMembership, processMlsMembership } from '../../src/lib/mls';
import type { Vault } from '../../src/lib/types';

export const SDP = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=sendrecv\r\n`;
export class Track {
  id = crypto.randomUUID(); enabled = true; readyState = 'live'; onended: (() => void) | null = null;
  onmute = null; onunmute = null;
  constructor(public kind: string) {}
  stop = vi.fn(() => { this.readyState = 'ended'; });
}
export class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  addTrack(track: Track) { this.tracks.push(track); }
  removeTrack(track: Track) { this.tracks = this.tracks.filter((item) => item !== track); }
}
export class Sender {
  constructor(public track: Track | null) {}
  replaceTrack = vi.fn(async (track: Track | null) => { this.track = track; });
  setStreams() {}
  getParameters() { return { encodings: [{}] }; }
  setParameters = vi.fn(async () => {});
}
export class Peer {
  static instances: Peer[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState = 'new'; iceConnectionState = 'new'; signalingState = 'stable';
  onicecandidate: ((event: unknown) => void) | null = null;
  ontrack: ((event: { track: Track }) => void) | null = null; onconnectionstatechange: (() => void) | null = null; oniceconnectionstatechange = null;
  transceivers: { sender: Sender; receiver: { track: Track }; direction: string }[] = [];
  constructor(private config: RTCConfiguration = {}) { Peer.instances.push(this); }
  connect() {
    this.iceConnectionState = 'connected'; this.connectionState = 'connected';
    this.ontrack?.({ track: new Track('audio') }); this.onconnectionstatechange?.();
  }
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
  getConfiguration() { return this.config; }
  setConfiguration = vi.fn((config: RTCConfiguration) => { this.config = config; });
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { resolve, reject, promise };
}
export async function pair() {
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
export function setup(vault: Vault) {
  const session = { vault: vault as Vault | null };
  const sent: CallEnvelope[] = [];
  const onPermissionChange = vi.fn();
  const getIceConfig = vi.fn(async (): Promise<CallIceConfiguration> => ({ iceServers: [], iceTransportPolicy: 'all' as const, relayConfigured: false, verifiedPeerIds: vault.members.filter((member) => member.status === 'active' && member.role !== vault.role).map((member) => member.deviceId) }));
  const controller = new CallController({ getVault: () => session.vault, send: (envelope) => { sent.push(envelope); }, getIceConfig, onChange: vi.fn(), onPermissionChange });
  controllers.push(controller);
  return { controller, session, sent, onPermissionChange, getIceConfig };
}
export let getUserMedia: ReturnType<typeof vi.fn>;
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
export async function invite(a: Vault, b: Vault) {
  return sealCallSignal(a, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', { kind: 'video', description: { type: 'offer', sdp: SDP }, cameraEnabled: true });
}

