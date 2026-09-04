import { beforeAll, describe, expect, it, vi } from 'vitest';
import { authenticatedMlsCallMembers, assertAuthenticatedRoomRoster, createAuthenticatedCallVault, isAuthenticatedCallRoster, signCallIdentityAttestation, verifyCallIdentityAttestations } from '../src/lib/call-membership';
import { openCallSignal, sealCallSignal } from '../src/lib/call-crypto';
import { generateIdentity } from '../src/lib/crypto';
import { createCreatorMlsState, encryptMlsApplication, joinMlsGroup, prepareCreatorWelcome, prepareMlsMembership } from '../src/lib/mls';
import { CALL_CAPABILITY } from '../src/lib/call-types';
import type { PrivateIdentity, RoomMember, Vault } from '../src/lib/types';

let creator: Vault;
let joiner: Vault;
let attacker: PrivateIdentity;

beforeAll(async () => {
  const roomId = crypto.randomUUID();
  const [creatorIdentity, joinerIdentity, thirdIdentity] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
  attacker = thirdIdentity;
  const members: RoomMember[] = [
    { ...creatorIdentity.publicBundle, role: 'creator', status: 'active', joinProof: null, capabilities: [CALL_CAPABILITY] },
    { ...joinerIdentity.publicBundle, role: 'joiner', status: 'active', joinProof: 'verified-during-pairing', capabilities: [CALL_CAPABILITY] },
  ];
  const common = { v: 3 as const, roomId, accessToken: 'unused', pairingSecret: '', creatorFingerprint: '', members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const };
  creator = { ...common, role: 'creator', identity: creatorIdentity, mls: await createCreatorMlsState(roomId, creatorIdentity, members) };
  creator.mls = await prepareCreatorWelcome(creator);
  joiner = { ...common, role: 'joiner', identity: joinerIdentity, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
  joiner.mls = await joinMlsGroup(joiner, creator.mls.pendingWelcome!);
  creator.mls.pendingWelcome = undefined;
}, 20_000);

describe('authenticated call roster boundary', () => {
  it('authenticates both sides only after their real MLS leaves are established', async () => {
    for (const base of [creator, joiner]) {
      const vault = structuredClone(base);
      expect(isAuthenticatedCallRoster(vault)).toBe(false);
      await expect(authenticatedMlsCallMembers(vault)).resolves.toHaveLength(2);
      expect(isAuthenticatedCallRoster(vault)).toBe(true);
    }
    const unjoined = structuredClone(joiner);
    unjoined.mls = { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' };
    await expect(authenticatedMlsCallMembers(unjoined)).rejects.toThrow();
  });

  it('rejects a server-injected active identity even if it already entered the stored roster', async () => {
    const vault = structuredClone(creator);
    vault.members.push({ ...attacker.publicBundle, role: 'joiner', status: 'active', joinProof: null, capabilities: [CALL_CAPABILITY] });
    await expect(authenticatedMlsCallMembers(vault)).rejects.toThrow();
    expect(isAuthenticatedCallRoster(vault)).toBe(false);
  });

  it('checks the ECDSA identity binding carried by the actual MLS leaf', async () => {
    const vault = structuredClone(creator);
    vault.members[1]!.signingKey = attacker.publicBundle.signingKey;
    await expect(authenticatedMlsCallMembers(vault)).rejects.toThrow();
  });

  it('rejects missing leaves, duplicate member IDs and an unrelated room or own leaf', async () => {
    const missing = structuredClone(creator);
    missing.members[1]!.status = 'revoked';
    await expect(authenticatedMlsCallMembers(missing)).rejects.toThrow();
    const duplicate = structuredClone(creator);
    duplicate.members.push(duplicate.members[1]!);
    await expect(authenticatedMlsCallMembers(duplicate)).rejects.toThrow();
    const wrongRoom = structuredClone(creator);
    wrongRoom.roomId = crypto.randomUUID();
    await expect(authenticatedMlsCallMembers(wrongRoom)).rejects.toThrow();
    const wrongSelf = structuredClone(creator);
    wrongSelf.identity = structuredClone(joiner.identity);
    wrongSelf.role = 'joiner';
    await expect(authenticatedMlsCallMembers(wrongSelf)).rejects.toThrow();
  });

  it('invalidates completed proof when server identity metadata changes', async () => {
    const vault = structuredClone(creator);
    await authenticatedMlsCallMembers(vault);
    vault.members[1]!.role = 'creator';
    expect(isAuthenticatedCallRoster(vault)).toBe(false);
    vault.members[1]!.role = 'joiner';
    vault.members[1]!.encryptionKey = attacker.publicBundle.encryptionKey;
    expect(isAuthenticatedCallRoster(vault)).toBe(false);
  });

  it('does not authorize a roster changed during asynchronous credential verification', async () => {
    const vault = structuredClone(creator);
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementationOnce((...args) => {
      vault.members.push({ ...attacker.publicBundle, role: 'joiner', status: 'active', joinProof: null });
      return verify(...args);
    });
    try {
      await expect(authenticatedMlsCallMembers(vault)).rejects.toThrow();
      expect(isAuthenticatedCallRoster(vault)).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('keeps proof across ordinary application ratchets without weakening leaf membership', async () => {
    const vault = structuredClone(creator);
    await authenticatedMlsCallMembers(vault);
    const result = await encryptMlsApplication(vault, { v: 1, kind: 'text', text: 'hello', sentAt: new Date().toISOString() }, crypto.randomUUID());
    vault.mls!.groupState = result.nextGroupState;
    expect(isAuthenticatedCallRoster(vault)).toBe(true);
  });

  it('keeps calls authenticated after chat advances without retaining private MLS generations', async () => {
    let vault = structuredClone(creator);
    const originalGroupState = vault.mls!.groupState!;
    const [caller, callee] = await Promise.all([
      createAuthenticatedCallVault(vault), createAuthenticatedCallVault(joiner),
    ]);
    for (const snapshot of [caller, callee]) {
      expect(snapshot.mls).toEqual({ protocol: 'mls-rfc9420', phase: 'active' });
      expect(snapshot.identity.mlsPrivatePackage).toBeUndefined();
      expect(snapshot.accessToken).toBe('');
      expect(snapshot.pairingSecret).toBe('');
      expect(isAuthenticatedCallRoster(snapshot)).toBe(true);
      expect(isAuthenticatedCallRoster(structuredClone(snapshot))).toBe(false);
      await expect(createAuthenticatedCallVault(snapshot)).rejects.toThrow();
    }
    const encrypted = await encryptMlsApplication(vault, { v: 1, kind: 'text', text: 'advance chat', sentAt: new Date().toISOString() }, crypto.randomUUID());
    // A durable chat commit replaces the entire vault object.
    vault = { ...structuredClone(vault), mls: { ...vault.mls!, groupState: encrypted.nextGroupState } };
    expect(vault.mls!.groupState).not.toBe(originalGroupState);
    expect(JSON.stringify(caller)).not.toContain(originalGroupState);
    const peerProof = await signCallIdentityAttestation(joiner);
    await expect(verifyCallIdentityAttestations(caller, [peerProof])).resolves.toEqual([joiner.identity.publicBundle.deviceId]);
    const payload = { kind: 'audio' as const, micMuted: true };
    const signal = await sealCallSignal(caller, joiner.identity.publicBundle.deviceId, crypto.randomUUID(), 'signal', payload);
    await expect(openCallSignal(callee, signal)).resolves.toEqual(payload);

    caller.members[1]!.status = 'revoked';
    expect(isAuthenticatedCallRoster(caller)).toBe(false);
    await expect(verifyCallIdentityAttestations(caller, [peerProof])).rejects.toThrow();
    await expect(sealCallSignal(caller, joiner.identity.publicBundle.deviceId, crypto.randomUUID(), 'signal', payload)).rejects.toThrow();
  });

  it('requires real leaf verification for call snapshots and rejects private-state or identity mutation', async () => {
    const injected = structuredClone(creator);
    injected.members[1]!.signingKey = attacker.publicBundle.signingKey;
    await expect(createAuthenticatedCallVault(injected)).rejects.toThrow();
    const snapshot = await createAuthenticatedCallVault(creator);
    snapshot.mls!.groupState = creator.mls!.groupState;
    expect(isAuthenticatedCallRoster(snapshot)).toBe(false);
    delete snapshot.mls!.groupState;
    snapshot.members[1]!.encryptionKey = attacker.publicBundle.encryptionKey;
    expect(isAuthenticatedCallRoster(snapshot)).toBe(false);
  });

  it('accepts a properly committed new leaf and rejects its later resurrection after removal', async () => {
    const vault = structuredClone(creator);
    const target: RoomMember = { ...attacker.publicBundle, role: 'creator', status: 'active', joinProof: null, addedBy: creator.identity.publicBundle.deviceId, capabilities: [CALL_CAPABILITY] };
    const added = await prepareMlsMembership(vault, 'add', target);
    vault.members.push(target);
    vault.mls!.groupState = added.nextGroupState;
    vault.mls!.lastEventSeq = 1;
    await expect(authenticatedMlsCallMembers(vault)).resolves.toHaveLength(3);
    const removed = await prepareMlsMembership(vault, 'remove', target);
    vault.mls!.groupState = removed.nextGroupState;
    vault.mls!.lastEventSeq = 2;
    expect(isAuthenticatedCallRoster(vault)).toBe(false);
    await expect(authenticatedMlsCallMembers(vault)).rejects.toThrow();
    target.status = 'revoked';
    await expect(authenticatedMlsCallMembers(vault)).resolves.toHaveLength(2);
  });

  it('pins role, ECDH key, signature key, MLS package and authorizer against signed history', () => {
    const expected = structuredClone(creator.members);
    const alterations: Array<(member: RoomMember) => void> = [
      member => { member.role = 'creator'; },
      member => { member.encryptionKey = attacker.publicBundle.encryptionKey; },
      member => { member.signingKey = attacker.publicBundle.signingKey; },
      member => { member.mlsKeyPackage = attacker.publicBundle.mlsKeyPackage; },
      member => { member.addedBy = crypto.randomUUID(); },
    ];
    for (const alter of alterations) {
      const server = structuredClone(expected);
      alter(server[1]!);
      expect(() => assertAuthenticatedRoomRoster(expected, server)).toThrow();
    }
    const server = structuredClone(expected);
    server[1]!.deviceName = '新的设备名称';
    server[1]!.lastSeenAt = new Date().toISOString();
    server[1]!.capabilities = [];
    expect(() => assertAuthenticatedRoomRoster(expected, server)).not.toThrow();
    expect(() => assertAuthenticatedRoomRoster(expected, server.slice(0, 1))).toThrow();
    expect(() => assertAuthenticatedRoomRoster(expected, [...server, { ...attacker.publicBundle, role: 'joiner', status: 'active', joinProof: null }])).toThrow();
  });
});

describe('online call identity attestations', () => {
  it('signs only local identity data and verifies peer roles and complete keys against MLS-bound signers', async () => {
    const vault = structuredClone(creator);
    await authenticatedMlsCallMembers(vault);
    const [self, peer] = await Promise.all([signCallIdentityAttestation(creator), signCallIdentityAttestation(joiner)]);
    await expect(verifyCallIdentityAttestations(vault, [self, peer])).resolves.toEqual([joiner.identity.publicBundle.deviceId]);
    expect(JSON.stringify(self)).not.toContain(creator.identity.signingPrivateKey.d!);
    expect(JSON.stringify(self)).not.toContain(creator.identity.encryptionPrivateKey.d!);
    const pending = { roomId: joiner.roomId, role: joiner.role, identity: joiner.identity };
    await expect(signCallIdentityAttestation(pending)).resolves.toMatchObject({ roomId: joiner.roomId, role: 'joiner', publicBundle: joiner.identity.publicBundle });
  });

  it('closes bootstrap ECDH substitution even when the altered roster still contains genuine MLS leaves', async () => {
    const vault = structuredClone(creator);
    vault.members[1]!.encryptionKey = attacker.publicBundle.encryptionKey;
    await authenticatedMlsCallMembers(vault);
    const peer = await signCallIdentityAttestation(joiner);
    await expect(verifyCallIdentityAttestations(vault, [peer])).rejects.toThrow();
    const rewritten = { ...peer, publicBundle: { ...peer.publicBundle, encryptionKey: attacker.publicBundle.encryptionKey } };
    await expect(verifyCallIdentityAttestations(vault, [rewritten])).rejects.toThrow();
  });

  it('closes bootstrap role substitution without accepting a rewritten signature', async () => {
    const vault = structuredClone(creator);
    vault.members[1]!.role = 'creator';
    await authenticatedMlsCallMembers(vault);
    const peer = await signCallIdentityAttestation(joiner);
    await expect(verifyCallIdentityAttestations(vault, [peer])).rejects.toThrow();
    await expect(verifyCallIdentityAttestations(vault, [{ ...peer, role: 'creator' }])).rejects.toThrow();
  });

  it('returns no callable peers when nobody has supplied an attestation and rejects malformed, repeated or unbound identities', async () => {
    const vault = structuredClone(creator);
    await authenticatedMlsCallMembers(vault);
    await expect(verifyCallIdentityAttestations(vault, [])).resolves.toEqual([]);
    await expect(verifyCallIdentityAttestations(vault, undefined)).rejects.toThrow();
    const peer = await signCallIdentityAttestation(joiner);
    for (const proof of [
      { ...peer, protocol: 'different-purpose' },
      { ...peer, roomId: crypto.randomUUID() },
      { ...peer, deviceId: crypto.randomUUID() },
      { ...peer, signature: `${peer.signature[0] === 'A' ? 'B' : 'A'}${peer.signature.slice(1)}` },
      { ...peer, unexpected: true },
      await signCallIdentityAttestation({ roomId: creator.roomId, role: 'joiner', identity: attacker }),
    ]) await expect(verifyCallIdentityAttestations(vault, [proof])).rejects.toThrow();
    await expect(verifyCallIdentityAttestations(vault, [peer, peer])).rejects.toThrow();
    await expect(verifyCallIdentityAttestations(vault, Array(7).fill(peer))).rejects.toThrow();
    await expect(verifyCallIdentityAttestations(structuredClone(vault), [peer])).rejects.toThrow();
  });

  it('does not accept an old attestation after the local authenticated membership was revoked', async () => {
    const vault = structuredClone(creator);
    await authenticatedMlsCallMembers(vault);
    const peer = await signCallIdentityAttestation(joiner);
    await expect(verifyCallIdentityAttestations(vault, [peer])).resolves.toHaveLength(1);
    vault.members[1]!.status = 'revoked';
    await expect(verifyCallIdentityAttestations(vault, [peer])).rejects.toThrow();
  });

  it('rejects a roster changed while an attestation signature was being checked', async () => {
    const vault = structuredClone(creator);
    await authenticatedMlsCallMembers(vault);
    const peer = await signCallIdentityAttestation(joiner);
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementationOnce((...args) => {
      vault.members[1]!.encryptionKey = attacker.publicBundle.encryptionKey;
      return verify(...args);
    });
    try { await expect(verifyCallIdentityAttestations(vault, [peer])).rejects.toThrow(); }
    finally { spy.mockRestore(); }
  });
});
