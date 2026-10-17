import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/lib/crypto';
import { bindPersonalDevice } from '../src/lib/personal-device-binding';
import { withPersonalKeys, signPersonalProof, type PersonalProof } from '../src/lib/personal-identity';
import { randomBase64Url } from '../src/lib/base64';
import { jointHistoryEnvelopeHash, releaseJointHistoryLayer, prepareJointHistoryScope, jointHistoryScopeHash, type JointHistoryScope } from '../src/lib/joint-history-keys';
import { sealChamberHistoryRecord, openChamberHistoryRecord, chamberHistoryRecordHash } from '../src/lib/chamber-history-record';
import { verifyChamberHistoryRecord } from '../server/personal-protocol.mjs';

const ownerEntropy = new Uint8Array(16).fill(1), peerEntropy = new Uint8Array(16).fill(2);
async function fixture() {
  const device = await generateIdentity(), binding = await bindPersonalDevice(ownerEntropy, device);
  const peer = await withPersonalKeys(peerEntropy, k => k.publicIdentity), roomId = crypto.randomUUID();
  const payload = { v: 1 as const, kind: 'messages' as const, roomId, ownerId: binding.identity.id, messages: [], attachments: [], afterSeq: 0, upperSeq: 0, previous: null };
  const record = await sealChamberHistoryRecord(payload, randomBase64Url(32), 1, peer, device, binding);
  const request: PersonalProof = { v: 1, purpose: 'chamber-personal-proof-v1', action: 'restore-history', identityId: binding.identity.id,
    roomId, deviceId: device.publicBundle.deviceId, requestId: crypto.randomUUID(), version: 1, challenge: randomBase64Url(32),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), payloadHash: jointHistoryEnvelopeHash(record.keyEnvelope) };
  const signature = await signPersonalProof(ownerEntropy, request);
  return { device, binding, peer, payload, record, request, signature };
}

describe('data-only Chamber history format', () => {
  it('automatically seals using device authorization and still requires both personal roots for cloud decryption', async () => {
    const f = await fixture();
    expect(await verifyChamberHistoryRecord(f.record, f.binding.identity, f.peer, f.device.publicBundle)).toBe(true);
    const release = await releaseJointHistoryLayer(f.record.keyEnvelope, f.record.keyEnvelope.context, f.request, f.signature, peerEntropy);
    expect(await openChamberHistoryRecord(f.record, f.binding.identity, f.peer, f.request, f.signature, release, ownerEntropy)).toEqual(f.payload);
    await expect(openChamberHistoryRecord(f.record, f.binding.identity, f.peer, f.request, f.signature, undefined!, ownerEntropy)).rejects.toThrow();
    expect(JSON.stringify(f.record)).not.toContain('signingPrivateKey');
    expect(JSON.stringify(f.record)).not.toContain('encryptionPrivateKey');
  });

  it('rejects a whole-vault field and substituted ciphertext, signer or owner before restoring data', async () => {
    const f = await fixture();
    await expect(sealChamberHistoryRecord({ ...f.payload, checkpoint: f.device } as never, randomBase64Url(32), 1, f.peer, f.device, f.binding)).rejects.toThrow('未许可');
    const corrupt = structuredClone(f.record); corrupt.sealed.ciphertext = randomBase64Url(100);
    expect(await verifyChamberHistoryRecord(corrupt, f.binding.identity, f.peer, f.device.publicBundle)).toBe(false);
    const swapped = structuredClone(f.record); swapped.keyEnvelope.author!.bundle.deviceId = crypto.randomUUID();
    expect(await verifyChamberHistoryRecord(swapped, f.binding.identity, f.peer, f.device.publicBundle)).toBe(false);
    expect(await verifyChamberHistoryRecord(f.record, f.peer, f.binding.identity, f.device.publicBundle)).toBe(false);
  });

  it('uses independent encryption for each unit so an earlier release cannot decrypt future data', async () => {
    const f = await fixture(), release = await releaseJointHistoryLayer(f.record.keyEnvelope, f.record.keyEnvelope.context, f.request, f.signature, peerEntropy);
    const next = await sealChamberHistoryRecord(f.payload, randomBase64Url(32), 2, f.peer, f.device, f.binding);
    expect(next.sealed).not.toEqual(f.record.sealed);
    const request = { ...f.request, version: 2, payloadHash: jointHistoryEnvelopeHash(next.keyEnvelope) };
    const signature = await signPersonalProof(ownerEntropy, request);
    await expect(openChamberHistoryRecord(next, f.binding.identity, f.peer, request, signature, release, ownerEntropy)).rejects.toThrow();
  });

  it('binds a bulk recovery to an immutable signed snapshot and authenticates the peer release ciphertext', async () => {
    const f = await fixture();
    const scope: JointHistoryScope = { v: 1, purpose: 'chamber-joint-history-scope-v1', roomId: f.payload.roomId,
      ownerId: f.binding.identity.id, peerId: f.peer.id, scope: 'chat', generation: 1, target: f.device.publicBundle,
      heads: [{ deviceId: f.device.publicBundle.deviceId, id: f.record.id, digest: chamberHistoryRecordHash(f.record), revision: 1, afterSeq: 0, upperSeq: 0 }],
      units: [{ deviceId: f.device.publicBundle.deviceId, id: f.record.id, revision: 1, envelopeHash: jointHistoryEnvelopeHash(f.record.keyEnvelope) }] };
    const proof = { ...f.request, payloadHash: jointHistoryScopeHash(scope) }, signature = await signPersonalProof(ownerEntropy, proof);
    const grant = prepareJointHistoryScope(scope, proof, signature, f.binding.identity, f.peer);
    const release = await releaseJointHistoryLayer(f.record.keyEnvelope, f.record.keyEnvelope.context, proof, signature, peerEntropy, grant);
    expect(await openChamberHistoryRecord(f.record, f.binding.identity, f.peer, proof, signature, release, ownerEntropy, grant, f.device)).toEqual(f.payload);
    await expect(openChamberHistoryRecord(f.record, f.binding.identity, f.peer, proof, signature, release, ownerEntropy, grant)).rejects.toThrow();
    await expect(openChamberHistoryRecord(f.record, f.binding.identity, f.peer, proof, signature, release, ownerEntropy, grant, await generateIdentity())).rejects.toThrow();
    const altered = structuredClone(release); altered.delivery.ciphertext = randomBase64Url(48);
    await expect(openChamberHistoryRecord(f.record, f.binding.identity, f.peer, proof, signature, altered, ownerEntropy, grant, f.device)).rejects.toThrow();
    await expect(releaseJointHistoryLayer(f.record.keyEnvelope, f.record.keyEnvelope.context, proof, signature, peerEntropy, { ...grant })).rejects.toThrow();
    const next = await sealChamberHistoryRecord(f.payload, randomBase64Url(32), 2, f.peer, f.device, f.binding);
    await expect(releaseJointHistoryLayer(next.keyEnvelope, next.keyEnvelope.context, proof, signature, peerEntropy, grant)).rejects.toThrow();
    const wrongRoom = { ...scope, roomId: crypto.randomUUID() }, wrongProof = { ...proof, roomId: wrongRoom.roomId, payloadHash: jointHistoryScopeHash(wrongRoom) };
    const wrongSignature = await signPersonalProof(ownerEntropy, wrongProof), wrongGrant = prepareJointHistoryScope(wrongRoom, wrongProof, wrongSignature, f.binding.identity, f.peer);
    await expect(releaseJointHistoryLayer(f.record.keyEnvelope, f.record.keyEnvelope.context, wrongProof, wrongSignature, peerEntropy, wrongGrant)).rejects.toThrow();
  });
});
