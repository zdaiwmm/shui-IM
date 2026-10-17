import { describe, expect, it } from 'vitest';
import { randomBase64Url } from '../src/lib/base64';
import { signPersonalProof, withPersonalKeys, type PersonalProof } from '../src/lib/personal-identity';
import { jointHistoryEnvelopeHash, releaseJointHistoryLayer, sealJointHistoryKey, useJointHistoryKey } from '../src/lib/joint-history-keys';

const a = new Uint8Array(16).fill(1), b = new Uint8Array(16).fill(2), stranger = new Uint8Array(16).fill(3);
async function fixture() {
  const owner = await withPersonalKeys(a, k => k.publicIdentity), peer = await withPersonalKeys(b, k => k.publicIdentity);
  const context = { owner, peer, roomId: crypto.randomUUID(), backupId: crypto.randomUUID(), revision: 1, contentDigest: randomBase64Url(32) };
  const key = crypto.getRandomValues(new Uint8Array(32));
  const envelope = await sealJointHistoryKey(key, context, a);
  const request: PersonalProof = { v: 1, purpose: 'chamber-personal-proof-v1', action: 'restore-history', identityId: owner.id,
    roomId: context.roomId, deviceId: crypto.randomUUID(), requestId: crypto.randomUUID(), version: 1,
    challenge: randomBase64Url(32), expiresAt: new Date(Date.now() + 30 * 60_000 - 1000).toISOString(), payloadHash: jointHistoryEnvelopeHash(envelope) };
  const signature = await signPersonalProof(a, request);
  return { context, key, envelope, request, signature };
}

describe('cryptographic two-person history key', () => {
  it('requires both original roots and wipes the released key after use', async () => {
    const f = await fixture();
    await expect(releaseJointHistoryLayer(f.envelope, f.context, f.request, f.signature, a)).rejects.toThrow();
    await expect(releaseJointHistoryLayer(f.envelope, f.context, f.request, f.signature, stranger)).rejects.toThrow();
    const release = await releaseJointHistoryLayer(f.envelope, f.context, f.request, f.signature, b);
    await expect(useJointHistoryKey(f.envelope, f.context, f.request, f.signature, release, b, () => undefined)).rejects.toThrow();
    let held: Uint8Array | undefined;
    await useJointHistoryKey(f.envelope, f.context, f.request, f.signature, release, a, key => { held = key; expect(key).toEqual(f.key); });
    expect(held!.every(byte => byte === 0)).toBe(true);
  });

  it('rejects missing participation, substituted identities and ciphertext corruption', async () => {
    const f = await fixture(), release = await releaseJointHistoryLayer(f.envelope, f.context, f.request, f.signature, b);
    await expect(useJointHistoryKey(f.envelope, f.context, f.request, f.signature, undefined!, a, () => undefined)).rejects.toThrow();
    await expect(releaseJointHistoryLayer(f.envelope, { ...f.context, peer: f.context.owner }, f.request, f.signature, b)).rejects.toThrow();
    const corrupt = structuredClone(release); corrupt.inner.ciphertext = randomBase64Url(48);
    await expect(useJointHistoryKey(f.envelope, f.context, f.request, f.signature, corrupt, a, () => undefined)).rejects.toThrow();
    const swapped = structuredClone(f.envelope); swapped.context.revision++;
    await expect(releaseJointHistoryLayer(swapped, swapped.context, f.request, f.signature, b)).rejects.toThrow();
  });

  it('rejects expired, differently scoped and replayed releases from a different challenge', async () => {
    const f = await fixture(), release = await releaseJointHistoryLayer(f.envelope, f.context, f.request, f.signature, b);
    for (const change of [{ roomId: crypto.randomUUID() }, { version: 2 }, { challenge: randomBase64Url(32) },
      { expiresAt: new Date(Date.now() - 1000).toISOString() }, { action: 'restore-room' as const }]) {
      const request = { ...f.request, ...change };
      const signature = change.expiresAt ? f.signature : await signPersonalProof(a, request);
      await expect(useJointHistoryKey(f.envelope, f.context, request, signature, release, a, () => undefined)).rejects.toThrow();
    }
  });
});
