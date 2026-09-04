import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/lib/crypto';
import { sealCallSignal, openCallSignal } from '../src/lib/call-crypto';
import { authenticatedMlsCallMembers } from '../src/lib/call-membership';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup } from '../src/lib/mls';
import { CALL_CAPABILITY } from '../src/lib/call-types';
import type { Vault } from '../src/lib/types';

const SDP = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n`;
async function pair() {
  const [a, b] = await Promise.all([generateIdentity(), generateIdentity()]);
  const common = { v: 3 as const, roomId: crypto.randomUUID(), accessToken: 'unused', pairingSecret: '', creatorFingerprint: '', lastSeq: 0, createdAt: new Date().toISOString(),
    protocol: 'mls-rfc9420' as const,
    members: [ { ...a.publicBundle, role: 'creator' as const, status: 'active' as const, joinProof: null, capabilities: [CALL_CAPABILITY] }, { ...b.publicBundle, role: 'joiner' as const, status: 'active' as const, joinProof: null, capabilities: [CALL_CAPABILITY] } ] };
  const creator: Vault = { ...common, role: 'creator', identity: a, mls: await createCreatorMlsState(common.roomId, a, common.members) };
  creator.mls = await prepareCreatorWelcome(creator);
  const joiner: Vault = { ...common, role: 'joiner', identity: b, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
  joiner.mls = await joinMlsGroup(joiner, creator.mls.pendingWelcome!);
  creator.mls.pendingWelcome = undefined;
  await Promise.all([authenticatedMlsCallMembers(creator), authenticatedMlsCallMembers(joiner)]);
  return { a: creator, b: joiner };
}
const offer = { kind: 'video' as const, description: { type: 'offer' as const, sdp: SDP }, cameraEnabled: true };

describe('authenticated encrypted call signaling', () => {
  it('refuses even a genuine MLS roster until that exact vault snapshot has been authenticated', async () => {
    const { a, b } = await pair();
    const copied = structuredClone(a);
    await expect(sealCallSignal(copied, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', offer)).rejects.toThrow('本机 MLS');
    await authenticatedMlsCallMembers(copied);
    const envelope = await sealCallSignal(copied, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', offer);
    await expect(openCallSignal(b, envelope)).resolves.toEqual(offer);
    const injected = await generateIdentity();
    copied.members.push({ ...injected.publicBundle, role: 'joiner', status: 'active', joinProof: null, capabilities: [CALL_CAPABILITY] });
    await expect(sealCallSignal(copied, injected.publicBundle.deviceId, crypto.randomUUID(), 'invite', offer)).rejects.toThrow('本机 MLS');
  });
  it('encrypts the complete SDP and fingerprints and exposes no identity private key', async () => {
    const { a, b } = await pair();
    const envelope = await sealCallSignal(a, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', offer);
    await expect(openCallSignal(b, envelope)).resolves.toEqual(offer);
    const serialized = JSON.stringify(envelope);
    for (const secret of [SDP, 'fingerprint', a.identity.encryptionPrivateKey.d!, a.identity.signingPrivateKey.d!]) expect(serialized).not.toContain(secret);
    expect(Object.keys(envelope).sort()).toEqual(['v', 'protocol', 'roomId', 'callId', 'eventId', 'senderId', 'recipientId', 'action', 'createdAt', 'expiresAt', 'iv', 'ciphertext', 'signature'].sort());
  });
  it('binds every routing field, ciphertext, and lifetime to the sender signature', async () => {
    const { a, b } = await pair();
    const envelope = await sealCallSignal(a, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', offer);
    for (const patch of [
      { callId: crypto.randomUUID() }, { eventId: crypto.randomUUID() }, { roomId: crypto.randomUUID() },
      { senderId: b.identity.publicBundle.deviceId }, { recipientId: a.identity.publicBundle.deviceId },
      { action: 'accept' as const }, { createdAt: envelope.createdAt - 1 }, { expiresAt: envelope.expiresAt - 1 },
      { ciphertext: (envelope.ciphertext.startsWith('A') ? 'B' : 'A') + envelope.ciphertext.slice(1) },
    ]) await expect(openCallSignal(b, { ...envelope, ...patch })).rejects.toThrow();
    await expect(openCallSignal(a, envelope)).rejects.toThrow();
  });
  it('rejects stale, future-dated and extended lifetime invites', async () => {
    const { a, b } = await pair();
    const now = Date.now();
    const envelope = await sealCallSignal(a, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', offer, now);
    await expect(openCallSignal(b, envelope, now + 45_000)).rejects.toThrow('过期');
    await expect(openCallSignal(b, envelope, now - 10_001)).rejects.toThrow('过期');
    await expect(openCallSignal(b, { ...envelope, expiresAt: now + 100_000 }, now)).rejects.toThrow();
  });
  it('requires an authenticated active opposite-role device, capability and active MLS session', async () => {
    const { a, b } = await pair();
    const envelope = await sealCallSignal(a, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', offer);
    for (const patch of [{ status: 'revoked' as const }, { status: 'pending' as const }, { role: 'joiner' as const }, { capabilities: [] }]) {
      const changed = { ...b, members: b.members.map((member) => member.deviceId === a.identity.publicBundle.deviceId ? { ...member, ...patch } : member) };
      await expect(openCallSignal(changed, envelope)).rejects.toThrow();
    }
    await expect(openCallSignal({ ...b, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } }, envelope)).rejects.toThrow();
    const impostor = await generateIdentity();
    await expect(openCallSignal({ ...b, members: b.members.map((member) => member.deviceId === a.identity.publicBundle.deviceId ? { ...member, signingKey: impostor.publicBundle.signingKey } : member) }, envelope)).rejects.toThrow();
  });
  it('rejects unsigned media endpoints, insecure RTP, wrong offer type and oversized payloads', async () => {
    const { a, b } = await pair();
    for (const description of [
      { type: 'offer', sdp: SDP.replace(/^a=fingerprint:.*\r\n/m, '') },
      { type: 'offer', sdp: SDP.replace('UDP/TLS/RTP/SAVPF', 'RTP/AVP') },
      { type: 'answer', sdp: SDP },
      { type: 'offer', sdp: SDP + 'a=x:' + 'x'.repeat(70_000) },
      { type: 'offer', sdp: SDP.replace(/^a=fingerprint:.*\r\n/m, '') + 'a=fingerprint:sha-256 AA\r\n' },
    ]) await expect(sealCallSignal(a, b.identity.publicBundle.deviceId, crypto.randomUUID(), 'invite', { ...offer, description: description as RTCSessionDescriptionInit })).rejects.toThrow();
  });
  it('uses fresh authenticated encryption for each direction and each signal', async () => {
    const { a, b } = await pair();
    const callId = crypto.randomUUID();
    const payload = { kind: 'audio' as const, micMuted: true };
    const first = await sealCallSignal(a, b.identity.publicBundle.deviceId, callId, 'signal', payload);
    const next = await sealCallSignal(a, b.identity.publicBundle.deviceId, callId, 'signal', payload);
    const reverse = await sealCallSignal(b, a.identity.publicBundle.deviceId, callId, 'signal', payload);
    expect(first.iv).not.toBe(next.iv);
    expect(first.ciphertext).not.toBe(next.ciphertext);
    await expect(openCallSignal(a, reverse)).resolves.toEqual(payload);
    await expect(openCallSignal(b, { ...first, ciphertext: reverse.ciphertext, iv: reverse.iv })).rejects.toThrow();
  });
});
