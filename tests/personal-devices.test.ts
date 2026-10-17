import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../server/storage.mjs';
import { generateIdentity, createJoinProof, bundleFingerprint } from '../src/lib/crypto';
import { bindPersonalDevice } from '../src/lib/personal-device-binding';
import { randomBase64Url } from '../src/lib/base64';
import { personalDevicePayloadHash, type PersonalDeviceRequest } from '../src/lib/personal-device-request';
import { signPersonalProof } from '../src/lib/personal-identity';
import { sha256 } from '@noble/hashes/sha2.js';
import { toBase64Url } from '../src/lib/base64';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, prepareMlsMembership, joinMlsMembership, processMlsMembership, encryptMlsApplication, decryptMlsApplication } from '../src/lib/mls';
import { validateMlsMembershipShape, verifyEnvelopeSignature } from '../server/protocol.mjs';
import type { Vault } from '../src/lib/types';

const directories: string[] = [], a = new Uint8Array(16).fill(1), b = new Uint8Array(16).fill(2);
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chamber-devices-')); directories.push(dataDir);
  const store = await createStore({ dataDir }), creator = await generateIdentity(), joiner = await generateIdentity();
  const aBinding = await bindPersonalDevice(a, creator), bBinding = await bindPersonalDevice(b, joiner);
  const token = randomBase64Url(32), inviteToken = randomBase64Url(32), secret = randomBase64Url(32), pairingSecret = randomBase64Url(32);
  const room = store.createRoom(creator.publicBundle, token, inviteToken, 'Creator', [], aBinding);
  const proof = await createJoinProof(pairingSecret, joiner.publicBundle), candidate = { bundle: joiner.publicBundle, proof, binding: bBinding };
  store.chamberInvitations.claim(room.roomId, secret); store.chamberInvitations.ready(room.roomId, secret, candidate);
  const state = store.joinRoom(room.roomId, candidate.bundle, proof, randomBase64Url(32), 'Joiner', [], { secret, code: store.chamberInvitations.state(room.roomId, true).code, binding: bBinding });
  const base = { v: 3 as const, roomId: room.roomId, accessToken: token, pairingSecret, creatorFingerprint: await bundleFingerprint(creator.publicBundle),
    members: state.members, lastSeq: 0, createdAt: room.createdAt, protocol: 'mls-rfc9420' as const, personalPeers: [aBinding, bBinding] };
  const creatorVault: Vault = { ...base, identity: creator, role: 'creator', personalBinding: aBinding };
  creatorVault.mls = await createCreatorMlsState(room.roomId, creator, state.members);
  creatorVault.mls = await prepareCreatorWelcome(creatorVault);
  store.saveMlsWelcome(room.roomId, creatorVault.mls.pendingWelcome);
  const joinerVault: Vault = { ...base, identity: joiner, role: 'joiner', personalBinding: bBinding };
  joinerVault.mls = await joinMlsGroup(joinerVault, creatorVault.mls.pendingWelcome!);
  async function requestDevice(role: 'creator' | 'joiner' = 'creator') {
    const identity = await generateIdentity(), binding = await bindPersonalDevice(role === 'creator' ? a : b, identity), accessToken = randomBase64Url(32);
    const payload = { v: 1 as const, purpose: 'chamber-device-request-v1' as const, roomId: room.roomId, role,
      bundle: identity.publicBundle, binding, tokenHash: toBase64Url(sha256(new TextEncoder().encode(accessToken))), deviceName: 'Synthetic new device', capabilities: [] };
    const proof = store.personalDirectory.challenge(binding.identity.id, { action: 'bind-device', roomId: room.roomId, deviceId: identity.publicBundle.deviceId, version: 1, payloadHash: personalDevicePayloadHash(payload) });
    const request: PersonalDeviceRequest = { payload, proof, signature: await signPersonalProof(role === 'creator' ? a : b, proof) };
    return { identity, binding, accessToken, request };
  }
  return { store, roomId: room.roomId, creatorVault, joinerVault, aBinding, bBinding, requestDevice };
}

describe('root proof and peer-approved independent devices', () => {
  it('persists no private keys, has no access while pending, and permits only the opposite participant to approve', async () => {
    const f = await fixture();
    try {
      const d = await f.requestDevice();
      await f.store.personalDevices.create(f.roomId, d.request, d.accessToken);
      await f.store.personalDevices.create(f.roomId, d.request, d.accessToken);
      expect(f.store.authenticatedDevice(f.roomId, d.accessToken)).toBeNull();
      expect(f.store.personalDevices.list(f.roomId, f.creatorVault.identity.publicBundle.deviceId)).toHaveLength(0);
      expect(f.store.personalDevices.list(f.roomId, f.joinerVault.identity.publicBundle.deviceId)).toHaveLength(1);
      expect(JSON.stringify(d.request)).not.toContain('signingPrivateKey');
      const target = f.store.getMember(f.roomId, d.identity.publicBundle.deviceId);
      const bad = await prepareMlsMembership(f.creatorVault, 'add', target, undefined, { request: d.request, approverBinding: f.aBinding, approvedAt: new Date().toISOString() });
      await expect(f.store.personalDevices.verifyAuthorization(f.roomId, bad.event)).rejects.toThrow('INVALID_PERSONAL_DEVICE');
    } finally { f.store.close(); }
  });

  it('uses a signed standard MLS Add and independent Welcome, with no access to pre-join ciphertext', async () => {
    const f = await fixture();
    try {
      const old = await encryptMlsApplication(f.joinerVault, { v: 1, kind: 'text', text: 'Synthetic before-join message', sentAt: new Date().toISOString() });
      f.joinerVault.mls!.groupState = old.nextGroupState;
      const d = await f.requestDevice(); await f.store.personalDevices.create(f.roomId, d.request, d.accessToken);
      const target = f.store.getMember(f.roomId, d.identity.publicBundle.deviceId);
      const prepared = await prepareMlsMembership(f.joinerVault, 'add', target, undefined, { request: d.request, approverBinding: f.bBinding, approvedAt: new Date().toISOString() });
      expect(validateMlsMembershipShape(prepared.event, f.roomId)).toBe(true);
      expect(await verifyEnvelopeSignature(prepared.event, f.joinerVault.identity.publicBundle.signingKey)).toBe(true);
      await f.store.personalDevices.verifyAuthorization(f.roomId, prepared.event);
      const saved = f.store.saveMlsEvent(f.roomId, prepared.event), state = f.store.roomState(f.roomId);
      expect(f.store.personalDevices.status(f.roomId, d.request.proof.requestId, d.accessToken).status).toBe('approved');
      const newVault: Vault = { ...f.creatorVault, identity: d.identity, personalBinding: d.binding, members: state.members,
        mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: saved.eventSeq - 1 } };
      newVault.mls = await joinMlsMembership(newVault, saved.event, saved.eventSeq);
      await expect(decryptMlsApplication(newVault, old.envelope)).rejects.toThrow();
      f.joinerVault.members = state.members; f.joinerVault.mls!.groupState = prepared.nextGroupState; f.joinerVault.mls!.lastEventSeq = saved.eventSeq;
      f.creatorVault.members = state.members; f.creatorVault.mls!.groupState = await processMlsMembership(f.creatorVault, saved.event, saved.eventSeq);
      const next = await encryptMlsApplication(f.joinerVault, { v: 1, kind: 'text', text: 'Synthetic after-join message', sentAt: new Date().toISOString() });
      expect((await decryptMlsApplication(newVault, next.envelope)).payload.kind).toBe('text');
    } finally { f.store.close(); }
  });

  it('rejects changed scope and counts pending requests toward the three-device limit', async () => {
    const f = await fixture();
    try {
      const d = await f.requestDevice();
      await expect(f.store.personalDevices.create(f.roomId, { ...d.request, payload: { ...d.request.payload, deviceName: 'Changed' } }, d.accessToken)).rejects.toThrow();
      await f.store.personalDevices.create(f.roomId, d.request, d.accessToken);
      const second = await f.requestDevice(); await f.store.personalDevices.create(f.roomId, second.request, second.accessToken);
      const third = await f.requestDevice(); await expect(f.store.personalDevices.create(f.roomId, third.request, third.accessToken)).rejects.toThrow('DEVICE_LIMIT');
    } finally { f.store.close(); }
  });
});
