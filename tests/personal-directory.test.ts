import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../server/storage.mjs';
import { verifyPersonalDirectoryRecord, verifyPersonalProof as verifyServerProof } from '../server/personal-protocol.mjs';
import { generateIdentity, bundleFingerprint } from '../src/lib/crypto';
import { bindPersonalDevice } from '../src/lib/personal-device-binding';
import { openPersonalDirectory, sealPersonalDirectory, type PersonalDirectoryEntry } from '../src/lib/personal-directory';
import { signPersonalProof } from '../src/lib/personal-identity';
import { randomBase64Url } from '../src/lib/base64';

const directories: string[] = [], a = new Uint8Array(16).fill(1), b = new Uint8Array(16).fill(2);
afterEach(async () => { vi.useRealTimers(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chamber-directory-')); directories.push(dataDir);
  const store = await createStore({ dataDir }), device = await generateIdentity(), binding = await bindPersonalDevice(a, device);
  const token = randomBase64Url(32), inviteToken = randomBase64Url(32), secret = randomBase64Url(32);
  const room = store.createRoom(device.publicBundle, token, inviteToken, 'Creator', [], binding);
  const peer = await generateIdentity(), peerBinding = await bindPersonalDevice(b, peer), candidate = { bundle: peer.publicBundle, proof: randomBase64Url(32), binding: peerBinding };
  store.chamberInvitations.claim(room.roomId, secret); store.chamberInvitations.ready(room.roomId, secret, candidate);
  store.joinRoom(room.roomId, candidate.bundle, candidate.proof, randomBase64Url(32), 'Joiner', [], { secret, code: store.chamberInvitations.state(room.roomId, true).code, binding: peerBinding });
  const entry: PersonalDirectoryEntry = { v: 1, roomId: room.roomId, role: 'creator', name: 'Synthetic private directory name', heads: [],
    creatorFingerprint: await bundleFingerprint(device.publicBundle), participants: [
      { role: 'creator', binding, bundle: device.publicBundle }, { role: 'joiner', binding: peerBinding, bundle: peer.publicBundle },
    ] };
  return { store, device, binding, peer, peerBinding, entry, token };
}

describe('personal encrypted directory and scoped proof', () => {
  it('encrypts only public membership and names, and requires the matching directory root', async () => {
    const f = await fixture();
    try {
      const record = await sealPersonalDirectory(f.entry, 1, f.device, f.binding);
      expect(await verifyPersonalDirectoryRecord(record, f.binding.identity, f.device.publicBundle)).toBe(true);
      expect(JSON.stringify(record)).not.toContain(f.entry.name);
      expect(JSON.stringify(record)).not.toContain('signingPrivateKey');
      expect(await openPersonalDirectory(record, f.binding.identity, a)).toEqual(f.entry);
      await expect(openPersonalDirectory(record, f.binding.identity, b)).rejects.toThrow();
      await expect(sealPersonalDirectory({ ...f.entry, checkpoint: f.device } as never, 1, f.device, f.binding)).rejects.toThrow();
    } finally { f.store.close(); }
  });

  it('rejects swapped rooms, participants, signatures and versions below a local trusted minimum', async () => {
    const f = await fixture();
    try {
      const record = await sealPersonalDirectory(f.entry, 1, f.device, f.binding);
      await expect(openPersonalDirectory(record, f.binding.identity, a, 2)).rejects.toThrow();
      await expect(openPersonalDirectory({ ...record, roomId: crypto.randomUUID() }, f.binding.identity, a)).rejects.toThrow();
      const swapped = structuredClone(record); swapped.author.binding = f.peerBinding;
      expect(await verifyPersonalDirectoryRecord(swapped, f.binding.identity, f.device.publicBundle)).toBe(false);
      await expect(openPersonalDirectory(swapped, f.binding.identity, a)).rejects.toThrow();
    } finally { f.store.close(); }
  });

  it('consumes a server-issued directory challenge once and cannot reuse a different action', async () => {
    const f = await fixture();
    try {
      const record = await sealPersonalDirectory(f.entry, 1, f.device, f.binding);
      await f.store.personalDirectory.save(f.entry.roomId, f.device.publicBundle.deviceId, record);
      expect(f.store.personalDirectory.revision(f.entry.roomId, f.device.publicBundle.deviceId)).toBe(1);
      const proof = f.store.personalDirectory.challenge(f.binding.identity.id, { action: 'read-directory', roomId: 'directory',
        deviceId: crypto.randomUUID(), version: 1, payloadHash: randomBase64Url(32) });
      const signature = await signPersonalProof(a, proof);
      expect(verifyServerProof(f.binding.identity, proof, signature)).toBe(true);
      expect(f.store.personalDirectory.read(proof, signature)).toEqual([record]);
      expect(() => f.store.personalDirectory.read(proof, signature)).toThrow('PERSONAL_PROOF_EXPIRED');
      const close = f.store.personalDirectory.challenge(f.binding.identity.id, { action: 'close-room', roomId: 'directory', deviceId: crypto.randomUUID(), version: 1, payloadHash: randomBase64Url(32) });
      const closeSignature = await signPersonalProof(a, close);
      expect(() => f.store.personalDirectory.read(close, closeSignature)).toThrow('UNAUTHORIZED');
      expect(() => f.store.personalDirectory.read({ ...proof, requestId: close.requestId }, signature)).toThrow('UNAUTHORIZED');
    } finally { f.store.close(); }
  });

  it('expires exactly at the absolute 30-minute deadline', async () => {
    const f = await fixture();
    try {
      const proof = f.store.personalDirectory.challenge(f.binding.identity.id, { action: 'read-directory', roomId: 'directory', deviceId: crypto.randomUUID(), version: 1, payloadHash: randomBase64Url(32) });
      const signature = await signPersonalProof(a, proof);
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(proof.expiresAt));
      expect(verifyServerProof(f.binding.identity, proof, signature)).toBe(false);
      expect(() => f.store.personalDirectory.read(proof, signature)).toThrow('UNAUTHORIZED');
    } finally { f.store.close(); }
  });
});
