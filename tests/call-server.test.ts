import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../server/index.mjs';
import { callIceConfiguration, createCallService, validateCallEnvelope } from '../server/calls.mjs';
import { generateIdentity } from '../src/lib/crypto';
import { signCallIdentityAttestation } from '../src/lib/call-membership';
import { canonicalStringify } from '../src/lib/canonical';
import { randomBase64Url, toBase64Url } from '../src/lib/base64';
import type { PrivateIdentity, RoomMember } from '../src/lib/types';
import type { CallAction, CallEnvelope } from '../src/lib/call-types';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const encoder = new TextEncoder();

async function signed(identity: PrivateIdentity, body: Omit<CallEnvelope, 'signature'>): Promise<CallEnvelope> {
  const key = await crypto.subtle.importKey('jwk', identity.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(canonicalStringify(body)));
  return { ...body, signature: toBase64Url(signature) };
}

async function envelope(identity: PrivateIdentity, recipientId: string, roomId: string, callId: string, action: CallAction, patch: Partial<CallEnvelope> = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify({ kind: 'video', description: { type: action === 'accept' ? 'answer' : 'offer', sdp: 'private-sdp-never-on-server' } })));
  const now = Date.now();
  return signed(identity, {
    v: 1, protocol: 'quiet-room-call-v1', roomId, callId, eventId: crypto.randomUUID(),
    senderId: identity.publicBundle.deviceId, recipientId, action,
    createdAt: now, expiresAt: now + 60_000,
    iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext), ...patch,
  });
}

type Frame = { type: string; callId?: string; state?: string; code?: string; acceptedBy?: string; envelope?: CallEnvelope; [key: string]: unknown };
async function connect(server: Awaited<ReturnType<typeof startServer>>, roomId: string, identity: PrivateIdentity, token: string, callIdentity?: unknown) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const frames: Frame[] = [];
  socket.on('message', (raw) => { frames.push(JSON.parse(raw.toString())); });
  const waitFor = async (predicate: (frame: Frame) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = frames.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Missing frame; observed ${JSON.stringify(frames)}`);
  };
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  cleanups.push(() => { socket.terminate(); });
  socket.send(JSON.stringify({ type: 'auth', roomId, accessToken: token, deviceId: identity.publicBundle.deviceId, capabilities: ['webrtc-call-v1'], ...(callIdentity === undefined ? {} : { callIdentity }) }));
  await waitFor((frame) => frame.type === 'ready');
  return { socket, frames, waitFor, send: (value: unknown) => socket.send(JSON.stringify(value)) };
}

async function setup(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-calls-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true, ...options });
  cleanups.push(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const [caller, callee] = await Promise.all([generateIdentity(), generateIdentity()]);
  const callerToken = randomBase64Url(32), calleeToken = randomBase64Url(32);
  const room = server.store.createRoom(caller.publicBundle, callerToken, randomBase64Url(32), '主设备', ['webrtc-call-v1']);
  server.store.joinRoom(room.roomId, callee.publicBundle, 'test-proof', calleeToken, '对方', ['webrtc-call-v1']);
  const [a, b] = await Promise.all([connect(server, room.roomId, caller, callerToken), connect(server, room.roomId, callee, calleeToken)]);
  const callId = crypto.randomUUID();
  const make = (action: CallAction, fromCallee = false, patch = {}) => envelope(fromCallee ? callee : caller, (fromCallee ? caller : callee).publicBundle.deviceId, room.roomId, callId, action, patch);
  return { server, roomId: room.roomId, caller, callee, callerToken, calleeToken, a, b, callId, make };
}

describe('ephemeral encrypted call transport', () => {
  it('constructs a valid maximum-TTL fixture even when clock reads advance across milliseconds', async () => {
    const [caller, callee] = await Promise.all([generateIdentity(), generateIdentity()]);
    let now = 1_780_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const value = await envelope(caller, callee.publicBundle.deviceId, crypto.randomUUID(), crypto.randomUUID(), 'invite');
    expect(value.expiresAt - value.createdAt).toBe(60_000);
    expect(validateCallEnvelope(value, value.roomId, value.createdAt)).toBeNull();
    expect(validateCallEnvelope(value, value.roomId, value.expiresAt)).toBe('CALL_EXPIRED');
    expect(validateCallEnvelope({ ...value, expiresAt: value.expiresAt + 1 }, value.roomId, value.createdAt)).toBe('INVALID_CALL');
  });

  it('forwards authenticated ciphertext, arbitrates acceptance and never adds media signals to history', async () => {
    const { server, roomId, caller, callee, a, b, callId, make } = await setup();
    const invite = await make('invite');
    a.send({ type: 'call', envelope: invite });
    expect(await b.waitFor((frame) => frame.type === 'call')).toEqual({ type: 'call', envelope: invite });
    expect(JSON.stringify(b.frames)).not.toContain('private-sdp-never-on-server');
    a.send({ type: 'call', envelope: invite });
    await a.waitFor((frame) => frame.code === 'CALL_REPLAY');
    expect(b.frames.filter((frame) => frame.type === 'call')).toHaveLength(1);
    const accept = await make('accept', true);
    b.send({ type: 'call', envelope: accept });
    await a.waitFor((frame) => frame.state === 'accepted' && frame.acceptedBy === callee.publicBundle.deviceId);
    expect(await a.waitFor((frame) => frame.envelope?.action === 'accept')).toEqual({ type: 'call', envelope: accept });
    const signal = await make('signal');
    a.send({ type: 'call', envelope: signal });
    expect(await b.waitFor((frame) => frame.envelope?.action === 'signal')).toEqual({ type: 'call', envelope: signal });
    b.send({ type: 'call', envelope: await make('end', true) });
    await a.waitFor((frame) => frame.state === 'ended' && frame.callId === callId);
    expect(server.store.messagesAfter(roomId, 0, 500, caller.publicBundle.deviceId)).toEqual([]);
    expect(server.store.receiptsAfter(roomId, 0, 500, caller.publicBundle.deviceId)).toEqual([]);
    a.send({ type: 'call', envelope: await make('signal') });
    await a.waitFor((frame) => frame.code === 'CALL_NOT_FOUND');
  });

  it('rejects signature tampering, sender impersonation, cross-room and malformed or expired envelopes', async () => {
    const { a, b, caller, callee, make } = await setup();
    const original = await make('invite');
    a.send({ type: 'call', envelope: { ...original, action: 'accept' } });
    await a.waitFor((frame) => frame.code === 'INVALID_CALL_SIGNATURE');
    const forged = await make('invite', true);
    a.send({ type: 'call', envelope: forged });
    await a.waitFor((frame) => frame.code === 'CALL_FORBIDDEN');
    a.send({ type: 'call', envelope: await make('invite', false, { roomId: crypto.randomUUID() }) });
    await a.waitFor((frame) => frame.code === 'INVALID_CALL');
    // One clock snapshot keeps the expired fixture within the valid 60s TTL.
    const expiredAt = Date.now() - 10_000;
    a.send({ type: 'call', envelope: await make('invite', false, { createdAt: expiredAt - 60_000, expiresAt: expiredAt }) });
    await a.waitFor((frame) => frame.code === 'CALL_EXPIRED');
    const unknown = { ...original, plaintextSdp: 'not-allowed' };
    expect(validateCallEnvelope(unknown, original.roomId)).toBe('INVALID_CALL');
    expect(validateCallEnvelope({ ...original, expiresAt: original.createdAt + 60_001 }, original.roomId)).toBe('INVALID_CALL');
    expect(validateCallEnvelope({ ...original, iv: randomBase64Url(13) }, original.roomId)).toBe('INVALID_CALL');
    expect(validateCallEnvelope({ ...original, ciphertext: toBase64Url(new Uint8Array(64 * 1024 + 1)) }, original.roomId)).toBe('INVALID_CALL');
    expect(validateCallEnvelope({ ...original, senderId: callee.publicBundle.deviceId, recipientId: callee.publicBundle.deviceId }, original.roomId)).toBe('INVALID_CALL');
    expect(caller.publicBundle.deviceId).not.toBe(callee.publicBundle.deviceId);
    expect(b.frames.some((frame) => frame.type === 'call')).toBe(false);
  });

  it('fails closed on cancellation versus late accept and permits a fresh call after endpoint disconnects', async () => {
    const { a, b, callId, make } = await setup();
    a.send({ type: 'call', envelope: await make('signal') });
    await a.waitFor((frame) => frame.code === 'CALL_NOT_FOUND');
    a.send({ type: 'call', envelope: await make('invite') });
    await b.waitFor((frame) => frame.envelope?.action === 'invite');
    a.send({ type: 'call', envelope: await make('end') });
    await b.waitFor((frame) => frame.state === 'ended');
    b.send({ type: 'call', envelope: await make('accept', true) });
    await b.waitFor((frame) => frame.code === 'CALL_NOT_FOUND');
    expect(a.frames.some((frame) => frame.state === 'accepted')).toBe(false);
    const nextId = crypto.randomUUID();
    a.send({ type: 'call', envelope: await make('invite', false, { callId: nextId }) });
    await b.waitFor((frame) => frame.envelope?.callId === nextId);
    b.send({ type: 'call', envelope: await make('accept', true, { callId: nextId }) });
    await a.waitFor((frame) => frame.callId === nextId && frame.state === 'accepted');
    b.socket.terminate();
    await a.waitFor((frame) => frame.callId === nextId && frame.code === 'CALL_DISCONNECTED');
    expect(nextId).not.toBe(callId);
  });

  it('requires live device authentication for TURN credentials and never returns the shared secret', async () => {
    const secret = randomBase64Url(32);
    const { server, roomId, callerToken } = await setup({ turnSecret: secret, turnUrls: 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp', callRelayOnly: true });
    const endpoint = `http://127.0.0.1:${server.port}/api/rooms/${roomId}/call-config`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${randomBase64Url(32)}` } })).status).toBe(401);
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${callerToken}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('permissions-policy')).toContain('camera=(self)');
    const config = await response.json();
    expect(config.iceTransportPolicy).toBe('relay');
    expect(config.relayConfigured).toBe(true);
    const credentials = config.iceServers[0];
    expect(credentials.credential).toBe(createHmac('sha1', secret).update(credentials.username).digest('base64'));
    expect(Number(credentials.username.split(':')[0]) - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(7198);
    expect(JSON.stringify(config)).not.toContain(secret);
    expect(callIceConfiguration({ callStunUrls: '', turnUrls: '', turnSecret: '', callRelayOnly: false })).toEqual({ iceServers: [], iceTransportPolicy: 'all', relayConfigured: false });
    for (const turnUrls of ['https://turn.example.test', 'turn:user:pass@host', 'turn:host/path', 'turn:host:99999', 'turn:host,,turn:other', 'turns:host?transport=udp']) {
      expect(() => callIceConfiguration({ turnUrls, turnSecret: secret })).toThrow('CALL_CONFIG_INVALID');
    }
    expect(() => callIceConfiguration({ turnUrls: '', turnSecret: '', callRelayOnly: true })).toThrow('CALL_CONFIG_INVALID');
    expect(() => callIceConfiguration({ turnUrls: 'turn:host', turnSecret: 'too-short' })).toThrow('CALL_CONFIG_INVALID');
  });

  it('returns only live authenticated socket identity attestations, deduplicates tabs and forgets closed proofs', async () => {
    const { server, roomId, caller, callee, callerToken, calleeToken } = await setup();
    const endpoint = `http://127.0.0.1:${server.port}/api/rooms/${roomId}/call-config`;
    const configuration = async () => (await fetch(endpoint, { headers: { Authorization: `Bearer ${callerToken}` } })).json();
    expect((await configuration()).callIdentities).toEqual([]);
    const callerProof = await signCallIdentityAttestation({ roomId, role: 'creator', identity: caller });
    const calleeProof = await signCallIdentityAttestation({ roomId, role: 'joiner', identity: callee });
    const aProof = await connect(server, roomId, caller, callerToken, callerProof);
    const bProof = await connect(server, roomId, callee, calleeToken, calleeProof);
    const bDuplicate = await connect(server, roomId, callee, calleeToken, calleeProof);
    expect((await configuration()).callIdentities).toEqual(expect.arrayContaining([callerProof, calleeProof]));
    expect((await configuration()).callIdentities).toHaveLength(2);
    bProof.socket.terminate();
    await new Promise<void>((resolve) => bProof.socket.once('close', resolve));
    expect((await configuration()).callIdentities).toHaveLength(2);
    bDuplicate.socket.terminate();
    await new Promise<void>((resolve) => bDuplicate.socket.once('close', resolve));
    // The original proof-less callee socket still exists, but must not inherit a proof.
    expect((await configuration()).callIdentities).toEqual([callerProof]);
    aProof.socket.terminate();
    await new Promise<void>((resolve) => aProof.socket.once('close', resolve));
    expect((await configuration()).callIdentities).toEqual([]);
    expect((await fetch(endpoint)).status).toBe(401);
  });

  it('rejects forged identity proofs and signed role, room, bundle or device substitutions before socket registration', async () => {
    const { server, roomId, caller, callee, callerToken, calleeToken } = await setup();
    const proof = await signCallIdentityAttestation({ roomId, role: 'creator', identity: caller });
    const wrongRole = await signCallIdentityAttestation({ roomId, role: 'joiner', identity: caller });
    const wrongRoom = await signCallIdentityAttestation({ roomId: crypto.randomUUID(), role: 'creator', identity: caller });
    const differentEcdh = await signCallIdentityAttestation({ roomId, role: 'creator', identity: { ...caller, publicBundle: { ...caller.publicBundle, encryptionKey: callee.publicBundle.encryptionKey } } });
    const wrongDevice = await signCallIdentityAttestation({ roomId, role: 'joiner', identity: callee });
    const attempts = [
      { proof: { ...proof, signature: toBase64Url(new Uint8Array(64)) }, token: callerToken },
      { proof: wrongRole, token: callerToken },
      { proof: wrongRoom, token: callerToken },
      { proof: differentEcdh, token: callerToken },
      { proof: wrongDevice, token: callerToken },
      { proof: { ...proof, extra: true }, token: callerToken },
      { proof, token: calleeToken },
    ];
    for (const attempt of attempts) {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      cleanups.push(() => socket.terminate());
      await new Promise<void>((resolve) => socket.once('open', resolve));
      const frames: Frame[] = [];
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
      const closed = new Promise<number>((resolve) => socket.once('close', resolve));
      socket.send(JSON.stringify({ type: 'auth', roomId, accessToken: attempt.token, deviceId: caller.publicBundle.deviceId, capabilities: ['webrtc-call-v1'], callIdentity: attempt.proof }));
      expect(await closed).toBe(4401);
      expect(frames.some((frame) => frame.type === 'ready')).toBe(false);
    }
    const response = await fetch(`http://127.0.0.1:${server.port}/api/rooms/${roomId}/call-config`, { headers: { Authorization: `Bearer ${callerToken}` } });
    expect((await response.json()).callIdentities).toEqual([]);
  });

  it('filters revoked and recovery-fenced proofs even when sockets remain open and rechecks auth after signature verification', async () => {
    const { server, roomId, caller, callee, callerToken, calleeToken } = await setup();
    const callerProof = await signCallIdentityAttestation({ roomId, role: 'creator', identity: caller });
    const calleeProof = await signCallIdentityAttestation({ roomId, role: 'joiner', identity: callee });
    await connect(server, roomId, caller, callerToken, callerProof);
    await connect(server, roomId, callee, calleeToken, calleeProof);
    const endpoint = `http://127.0.0.1:${server.port}/api/rooms/${roomId}/call-config`;
    const configuration = async () => (await fetch(endpoint, { headers: { Authorization: `Bearer ${callerToken}` } })).json();
    const originalPending = server.store.deviceRecoveryPending;
    const pending = vi.spyOn(server.store, 'deviceRecoveryPending').mockImplementation((room: string, id: string) => id === callee.publicBundle.deviceId || originalPending(room, id));
    expect((await configuration()).callIdentities).toEqual([callerProof]);
    pending.mockRestore();
    const originalMember = server.store.getMember;
    const revoked = vi.spyOn(server.store, 'getMember').mockImplementation((room: string, id: string) => {
      const member = originalMember(room, id);
      return id === callee.publicBundle.deviceId ? { ...member, status: 'revoked' } : member;
    });
    expect((await configuration()).callIdentities).toEqual([callerProof]);
    revoked.mockRestore();
    const originalAuthenticate = server.store.authenticatedDevice;
    let authChecks = 0;
    const auth = vi.spyOn(server.store, 'authenticatedDevice').mockImplementation((...args: unknown[]) => {
      if (args[1] === calleeToken && ++authChecks > 1) return null;
      return originalAuthenticate(...args);
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(() => socket.terminate());
    await new Promise<void>((resolve) => socket.once('open', resolve));
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'auth', roomId, accessToken: calleeToken, deviceId: callee.publicBundle.deviceId, callIdentity: calleeProof }));
    expect(await closed).toBe(4401);
    expect(authChecks).toBe(2);
    auth.mockRestore();
  });

  it('rejects calls before authentication', async () => {
    const { server, make } = await setup();
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(() => socket.terminate());
    await new Promise<void>((resolve) => socket.once('open', resolve));
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'call', envelope: await make('invite') }));
    expect(await closed).toBe(4401);
  });
});

async function arbitrationHarness() {
  const identities = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
  const roomId = crypto.randomUUID();
  const members = new Map<string, RoomMember>(identities.map((identity, index) => [identity.publicBundle.deviceId, { ...identity.publicBundle, role: index === 0 ? 'creator' : 'joiner', status: 'active', joinProof: null, capabilities: ['webrtc-call-v1'] }]));
  const fenced = new Set<string>();
  const sockets = identities.map(() => ({ open: true, frames: [] as Frame[] }));
  const sessions = identities.map((identity, index) => ({ roomId, deviceId: identity.publicBundle.deviceId, role: index === 0 ? 'creator' : 'joiner' }));
  const socketSessions = new WeakMap(sockets.map((socket, index) => [socket, sessions[index]]));
  const service = createCallService({
    store: { getMember: (room: string, device: string) => room === roomId ? members.get(device) : null, deviceRecoveryPending: (_room: string, device: string) => fenced.has(device) },
    clientsByRoom: new Map([[roomId, new Set(sockets)]]), socketSessions,
    send: (socket: typeof sockets[number], frame: Frame) => { socket.frames.push(frame); },
    isOpen: (socket: typeof sockets[number]) => socket.open,
  });
  cleanups.push(() => service.close());
  const callId = crypto.randomUUID();
  const make = (from: number, to: number, action: CallAction, patch = {}) => envelope(identities[from]!, identities[to]!.publicBundle.deviceId, roomId, callId, action, patch);
  const transmit = async (from: number, to: number, action: CallAction, patch = {}) => service.handle(sockets[from], sessions[from], { type: 'call', envelope: await make(from, to, action, patch) });
  return { service, sockets, sessions, members, fenced, identities, callId, make, transmit };
}

describe('multi-device selection and lifecycle fences', () => {
  it('atomically selects one callee and prevents an unselected sibling from ending or injecting into the accepted call', async () => {
    const { sockets, transmit, identities } = await arbitrationHarness();
    await transmit(0, 1, 'invite');
    await transmit(0, 2, 'invite');
    await Promise.all([transmit(1, 0, 'accept'), transmit(2, 0, 'accept')]);
    const accepted = sockets[0]!.frames.filter((frame) => frame.state === 'accepted');
    expect(accepted).toHaveLength(1);
    const chosen = accepted[0]!.acceptedBy === identities[1]!.publicBundle.deviceId ? 1 : 2;
    const other = chosen === 1 ? 2 : 1;
    expect(sockets[other]!.frames.some((frame) => frame.code === 'CALL_ALREADY_ACCEPTED')).toBe(true);
    await transmit(other, 0, 'end');
    await transmit(other, 0, 'decline');
    await transmit(other, 0, 'signal');
    expect(sockets[other]!.frames.filter((frame) => frame.code === 'CALL_FORBIDDEN')).toHaveLength(3);
    expect(sockets[0]!.frames.some((frame) => frame.state === 'ended')).toBe(false);
    await transmit(chosen, 0, 'signal');
    expect(sockets[0]!.frames.filter((frame) => frame.envelope?.action === 'signal')).toHaveLength(1);
    await transmit(chosen, 0, 'end');
    expect(sockets.every((socket) => socket.frames.some((frame) => frame.state === 'ended'))).toBe(true);
  });

  it('scopes an offline sibling invitation error while another device can still accept', async () => {
    const { sockets, transmit, identities } = await arbitrationHarness();
    sockets[1]!.open = false;
    await transmit(0, 1, 'invite');
    expect(sockets[0]!.frames.at(-1)).toMatchObject({ state: 'error', code: 'CALL_UNAVAILABLE', recipientId: identities[1]!.publicBundle.deviceId });
    await transmit(0, 2, 'invite');
    expect(sockets[2]!.frames.some((frame) => frame.envelope?.action === 'invite')).toBe(true);
    await transmit(2, 0, 'accept');
    await transmit(2, 0, 'signal');
    expect(sockets[0]!.frames.some((frame) => frame.state === 'accepted' && frame.acceptedBy === identities[2]!.publicBundle.deviceId)).toBe(true);
    expect(sockets[0]!.frames.some((frame) => frame.envelope?.action === 'signal')).toBe(true);
    expect(sockets[0]!.frames.some((frame) => frame.state === 'ended')).toBe(false);
  });

  it('honors caller cancellation encrypted for another sibling during the acceptance race', async () => {
    const { sockets, transmit, service, sessions, make } = await arbitrationHarness();
    await transmit(0, 1, 'invite');
    await transmit(0, 2, 'invite');
    const cancellation = await make(0, 1, 'end');
    await transmit(2, 0, 'accept');
    await service.handle(sockets[0], sessions[0], { type: 'call', envelope: cancellation });
    expect(sockets.every((socket) => socket.frames.some((frame) => frame.state === 'ended'))).toBe(true);
    expect(sockets[2]!.frames.some((frame) => frame.envelope?.eventId === cancellation.eventId)).toBe(false);
    await transmit(2, 0, 'signal');
    expect(sockets[2]!.frames.at(-1)?.code).toBe('CALL_NOT_FOUND');
    const next = { callId: crypto.randomUUID() };
    await transmit(0, 2, 'invite', next);
    expect(sockets[2]!.frames.at(-1)?.envelope?.callId).toBe(next.callId);
  });

  it('expires ringing calls without allowing old invitations to resurrect them', async () => {
    const { sockets, service, transmit } = await arbitrationHarness();
    await transmit(0, 1, 'invite');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 46_000);
    service.sweep();
    expect(sockets[0]!.frames.some((frame) => frame.code === 'CALL_TIMEOUT')).toBe(true);
    await transmit(0, 1, 'invite');
    expect(sockets[0]!.frames.at(-1)?.code).toBe('CALL_NOT_FOUND');
    await transmit(1, 0, 'accept');
    expect(sockets[1]!.frames.at(-1)?.code).toBe('CALL_NOT_FOUND');
  });

  it('terminates on revocation/recovery fences, even if a socket still appears open', async () => {
    const { sockets, service, transmit, fenced, identities, members } = await arbitrationHarness();
    await transmit(0, 1, 'invite');
    await transmit(1, 0, 'accept');
    fenced.add(identities[1]!.publicBundle.deviceId);
    service.sweep();
    expect(sockets[0]!.frames.at(-1)?.code).toBe('CALL_DEVICE_INACTIVE');
    await transmit(1, 0, 'signal');
    expect(sockets[1]!.frames.at(-1)?.code).toBe('CALL_FORBIDDEN');
    fenced.clear();
    const next = { callId: crypto.randomUUID() };
    await transmit(0, 2, 'invite', next);
    await transmit(2, 0, 'accept', next);
    members.get(identities[2]!.publicBundle.deviceId)!.status = 'revoked';
    service.sweep();
    expect(sockets[0]!.frames.at(-1)?.code).toBe('CALL_DEVICE_INACTIVE');
  });

  it('allows a decline to cancel all ringing devices and rejects signal before acceptance', async () => {
    const { sockets, transmit } = await arbitrationHarness();
    await transmit(0, 1, 'invite');
    await transmit(0, 2, 'invite');
    await transmit(0, 1, 'signal');
    expect(sockets[0]!.frames.at(-1)?.code).toBe('CALL_FORBIDDEN');
    await transmit(1, 0, 'decline');
    expect(sockets.every((socket) => socket.frames.some((frame) => frame.code === 'CALL_DECLINED'))).toBe(true);
    await transmit(2, 0, 'accept');
    expect(sockets[2]!.frames.at(-1)?.code).toBe('CALL_NOT_FOUND');
  });
});
