import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../server/storage.mjs';
import { verifyPersonalDeviceBinding as verifyServerBinding } from '../server/personal-protocol.mjs';
import { bindPersonalDevice, verifyPersonalDeviceBinding } from '../src/lib/personal-device-binding';
import { generateIdentity } from '../src/lib/crypto';
import { randomBase64Url } from '../src/lib/base64';

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chamber-invitation-')); directories.push(dataDir);
  const store = await createStore({ dataDir });
  const device = await generateIdentity(), binding = await bindPersonalDevice(new Uint8Array(16).fill(1), device);
  const creatorToken = randomBase64Url(32), inviteToken = randomBase64Url(32), secret = randomBase64Url(32);
  const room = store.createRoom(device.publicBundle, creatorToken, inviteToken, 'Creator', [], binding);
  const joiner = await generateIdentity(), peerBinding = await bindPersonalDevice(new Uint8Array(16).fill(2), joiner);
  const candidate = { bundle: joiner.publicBundle, proof: randomBase64Url(32), binding: peerBinding };
  return { store, ...room, secret, inviteToken, creatorToken, device, binding, candidate };
}

describe('Chamber invitation ownership and lifetime', () => {
  it('recovers the same durable creator intent and rejects capability or identity substitution', async () => {
    const f = await fixture();
    try {
      const id = crypto.randomUUID(), first = f.store.createRoom(f.device.publicBundle, f.creatorToken, f.inviteToken, 'Creator', [], f.binding, id);
      expect(f.store.createRoom(f.device.publicBundle, f.creatorToken, f.inviteToken, 'Creator', [], f.binding, id)).toEqual(first);
      for (const args of [
        [f.candidate.bundle, f.creatorToken, f.inviteToken, f.candidate.binding],
        [f.device.publicBundle, randomBase64Url(32), f.inviteToken, f.binding],
        [f.device.publicBundle, f.creatorToken, randomBase64Url(32), f.binding],
      ]) expect(() => f.store.createRoom(args[0], args[1], args[2], 'Creator', [], args[3], id)).toThrow('ROOM_CREATE_CONFLICT');
      expect(f.store.chamberInvitations.state(id).creatorBinding).toEqual(f.binding);
    } finally { f.store.close(); }
  });
  it('verifies cross-signed root/device bindings identically on browser and server', async () => {
    const f = await fixture();
    try {
      expect(await verifyServerBinding(f.binding, f.device.publicBundle)).toBe(true);
      expect(await verifyPersonalDeviceBinding(f.binding, f.device.publicBundle)).toBe(true);
      for (const changed of [{ bundleHash: randomBase64Url(32) }, { rootSignature: randomBase64Url(64) }, { deviceSignature: randomBase64Url(64) }]) {
        expect(await verifyServerBinding({ ...f.binding, ...changed }, f.device.publicBundle)).toBe(false);
        expect(await verifyPersonalDeviceBinding({ ...f.binding, ...changed }, f.device.publicBundle)).toBe(false);
      }
    } finally { f.store.close(); }
  });

  it('has one atomic claimant, a fixed 30-minute deadline and no code in invite-visible state', async () => {
    const f = await fixture();
    try {
      expect(f.store.chamberInvitations.state(f.roomId).stage).toBe('available');
      const first = f.store.chamberInvitations.claim(f.roomId, f.secret);
      expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(30 * 60_000 - 1000);
      expect(() => f.store.chamberInvitations.claim(f.roomId, randomBase64Url(32))).toThrow('INVITATION_CLAIMED');
      expect(f.store.chamberInvitations.claim(f.roomId, f.secret).expiresAt).toBe(first.expiresAt);
      f.store.chamberInvitations.ready(f.roomId, f.secret, f.candidate);
      expect(f.store.chamberInvitations.state(f.roomId).code).toBeUndefined();
      const code = f.store.chamberInvitations.state(f.roomId, true).code;
      expect(code).toMatch(/^\d{4}$/);
      expect(() => f.store.joinRoom(f.roomId, f.candidate.bundle, f.candidate.proof, randomBase64Url(32), 'Joiner', [])).toThrow();
      const state = f.store.joinRoom(f.roomId, f.candidate.bundle, f.candidate.proof, randomBase64Url(32), 'Joiner', [], { secret: f.secret, code, binding: f.candidate.binding });
      expect(state.members).toHaveLength(2);
      expect(state.chamber.stage).toBe('joined');
    } finally { f.store.close(); }
  });

  it('ends the entire invite at expiry or five failures and invalidates previous claims on rotation', async () => {
    const f = await fixture();
    try {
      const first = f.store.chamberInvitations.claim(f.roomId, f.secret);
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(first.expiresAt));
      expect(() => f.store.chamberInvitations.claim(f.roomId, f.secret)).toThrow('INVITATION_ENDED');
      vi.useRealTimers();
      const nextToken = randomBase64Url(32);
      const rotated = f.store.rotateChamberInvitation(f.roomId, nextToken);
      expect(rotated.version).toBe(2);
      expect(f.store.rotateChamberInvitation(f.roomId, nextToken).version).toBe(2);
      expect(f.store.authenticateInvite(f.roomId, f.inviteToken)).toBe(false);
      const secondSecret = randomBase64Url(32); f.store.chamberInvitations.claim(f.roomId, secondSecret);
      expect(() => f.store.chamberInvitations.ready(f.roomId, f.secret, f.candidate)).toThrow('INVITATION_CLAIMED');
      for (let i = 0; i < 5; i++) f.store.chamberInvitations.recordWrongCode(f.roomId, secondSecret);
      expect(() => f.store.chamberInvitations.ready(f.roomId, secondSecret, f.candidate)).toThrow('INVITATION_ENDED');
      expect(f.store.chamberInvitations.state(f.roomId).stage).toBe('expired');
      expect(f.store.cleanupOrphanRooms(new Date(Date.now() + 2 * 60 * 60_000).toISOString())).toBe(0);
    } finally { f.store.close(); }
  });
});
