import { describe, expect, it } from 'vitest';
import { randomBase64Url } from '../src/lib/base64';
import {
  bundleFingerprint,
  createDeliveryReceipt,
  createJoinProof,
  decryptMessage,
  encryptMessage,
  generateIdentity,
  verifyDeliveryReceipt,
  verifyJoinProof,
} from '../src/lib/crypto';
import { decryptImageFile, encryptImageFile } from '../src/lib/file-crypto';
import type { ImageUploadPlan, MessagePayload, RoomMember, Vault } from '../src/lib/types';

async function pairedVaults() {
  const [creatorIdentity, joinerIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
  const pairingSecret = randomBase64Url(32);
  const proof = await createJoinProof(pairingSecret, joinerIdentity.publicBundle);
  const creator: RoomMember = { ...creatorIdentity.publicBundle, role: 'creator', joinProof: null };
  const joiner: RoomMember = { ...joinerIdentity.publicBundle, role: 'joiner', joinProof: proof };
  const members = [creator, joiner];
  const roomId = crypto.randomUUID();
  const common = {
    v: 1 as const,
    roomId,
    accessToken: randomBase64Url(32),
    pairingSecret,
    creatorFingerprint: await bundleFingerprint(creatorIdentity.publicBundle),
    members,
    lastSeq: 0,
    createdAt: new Date().toISOString(),
  };
  const creatorVault: Vault = { ...common, role: 'creator', identity: creatorIdentity };
  const joinerVault: Vault = { ...common, role: 'joiner', identity: joinerIdentity };
  return { creatorVault, joinerVault, proof };
}

describe('message encryption protocol', () => {
  it('authenticates the invited device without revealing the pairing secret', async () => {
    const { joinerVault, proof } = await pairedVaults();
    expect(await verifyJoinProof(joinerVault.pairingSecret, joinerVault.identity.publicBundle, proof)).toBe(true);
    expect(await verifyJoinProof(randomBase64Url(32), joinerVault.identity.publicBundle, proof)).toBe(false);
  });

  it('lets both enrolled devices decrypt but stores no plaintext', async () => {
    const { creatorVault, joinerVault } = await pairedVaults();
    const payload = { v: 1 as const, kind: 'text' as const, text: '只有两端能看到的句子', sentAt: new Date().toISOString() };
    const envelope = await encryptMessage(creatorVault, payload);

    expect(JSON.stringify(envelope)).not.toContain(payload.text);
    await expect(decryptMessage(creatorVault, envelope)).resolves.toEqual(payload);
    await expect(decryptMessage(joinerVault, envelope)).resolves.toEqual(payload);
  });

  it('accepts a creator gallery image as a distinct encrypted payload', async () => {
    const { creatorVault, joinerVault } = await pairedVaults();
    const payload: MessagePayload = {
      v: 1,
      kind: 'gallery-image',
      sentAt: new Date().toISOString(),
      image: {
        v: 1,
        blobId: crypto.randomUUID(),
        key: randomBase64Url(32),
        ivPrefix: randomBase64Url(8),
        chunkSize: 2 * 1024 * 1024,
        chunkCount: 1,
        originalSize: 12,
        originalName: 'gallery-only.svg',
        mimeType: 'image/svg+xml',
        lastModified: 1_700_000_000_000,
        sha256: 'a'.repeat(64),
      },
    };
    const envelope = await encryptMessage(creatorVault, payload);

    expect(JSON.stringify(envelope)).not.toContain(payload.image.originalName);
    await expect(decryptMessage(joinerVault, envelope)).resolves.toEqual(payload);
  });

  it('fails closed when ciphertext is modified', async () => {
    const { creatorVault, joinerVault } = await pairedVaults();
    const envelope = await encryptMessage(creatorVault, {
      v: 1,
      kind: 'text',
      text: 'integrity',
      sentAt: new Date().toISOString(),
    });
    const tampered = structuredClone(envelope);
    tampered.content.ciphertext = `${tampered.content.ciphertext.slice(0, -1)}${tampered.content.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    await expect(decryptMessage(joinerVault, tampered)).rejects.toThrow('签名');
  });

  it('uses a signed receiver receipt as proof of peer delivery', async () => {
    const { creatorVault, joinerVault } = await pairedVaults();
    const envelope = await encryptMessage(creatorVault, {
      v: 1,
      kind: 'text',
      text: 'receipt-bound',
      sentAt: new Date().toISOString(),
    });
    const receipt = await createDeliveryReceipt(joinerVault, { seq: 7, envelope });

    await expect(verifyDeliveryReceipt(creatorVault, receipt)).resolves.toBe(true);
    const tampered = { ...receipt, seq: 8 };
    await expect(verifyDeliveryReceipt(creatorVault, tampered)).resolves.toBe(false);
    await expect(createDeliveryReceipt(creatorVault, { seq: 7, envelope })).rejects.toThrow('本机消息');
  });
});

describe('original image encryption', () => {
  it('round-trips the exact original bytes through encrypted chunks', async () => {
    const original = new Uint8Array(2_350_123);
    for (let index = 0; index < original.length; index += 1) original[index] = (index * 31 + 17) % 256;
    const file = new File([original], 'original.png', { type: 'image/png', lastModified: 1_700_000_000_000 });
    const chunks = new Map<number, ArrayBuffer>();
    let savedPlan;
    const manifest = await encryptImageFile(file, {
      reserve: async (_blobId, chunkCount, encryptedSize) => {
        expect(chunkCount).toBe(2);
        expect(encryptedSize).toBe(file.size + 32);
      },
      status: async () => ({ uploadedIndexes: [], completed: false }),
      upload: async (_blobId, index, bytes) => { chunks.set(index, bytes); },
      complete: async () => undefined,
      savePlan: async (plan) => { savedPlan = plan; },
    });

    expect(savedPlan).toMatchObject({ blobId: manifest.blobId, originalSize: file.size });
    expect(Buffer.from(chunks.get(0)!).equals(Buffer.from(original.slice(0, chunks.get(0)!.byteLength)))).toBe(false);
    const restored = await decryptImageFile(manifest, async (_blobId, index) => chunks.get(index)!);
    expect(Buffer.from(await restored.arrayBuffer()).equals(Buffer.from(original))).toBe(true);
    expect(restored.type).toBe('image/png');
  });

  it('resumes an interrupted upload without replacing its key or blob id', async () => {
    const original = new Uint8Array(2_200_000);
    for (let index = 0; index < original.length; index += 1) original[index] = (index * 17 + 23) % 256;
    const file = new File([original], 'resume.png', { type: 'image/png', lastModified: 1_700_000_000_001 });
    const chunks = new Map<number, ArrayBuffer>();
    let plan: ImageUploadPlan | undefined;

    await expect(encryptImageFile(file, {
      reserve: async () => undefined,
      status: async () => ({ uploadedIndexes: [], completed: false }),
      upload: async (_blobId, index, bytes) => {
        if (index === 1) throw new Error('network interruption');
        chunks.set(index, bytes);
      },
      complete: async () => undefined,
      savePlan: async (value) => { plan = value; },
    })).rejects.toThrow('network interruption');

    const resumedUploads: number[] = [];
    const manifest = await encryptImageFile(file, {
      reserve: async () => undefined,
      status: async () => ({ uploadedIndexes: [0], completed: false }),
      upload: async (_blobId, index, bytes) => {
        resumedUploads.push(index);
        chunks.set(index, bytes);
      },
      complete: async () => undefined,
      savePlan: async () => undefined,
    }, plan);

    expect(resumedUploads).toEqual([1]);
    expect(manifest.blobId).toBe(plan?.blobId);
    const restored = await decryptImageFile(manifest, async (_blobId, index) => chunks.get(index)!);
    expect(Buffer.from(await restored.arrayBuffer()).equals(Buffer.from(original))).toBe(true);
  });
});
