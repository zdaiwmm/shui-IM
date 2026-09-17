import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/storage.mjs';
import { generateIdentity } from '../src/lib/crypto';
import { randomBase64Url, toBase64Url } from '../src/lib/base64';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, encryptMlsApplication, decryptMlsApplication, signEcdsa } from '../src/lib/mls';
import { jointMembers, verifyJointSnapshot, type JointOffer, type JointProposal, type PendingJointRecovery } from '../src/lib/joint-recovery';
import type { Vault } from '../src/lib/types';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'joint-recovery-')); const store = await createStore({ dataDir: dir });
  cleanups.push(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const [a, b, freshA, freshB] = await Promise.all(Array.from({ length: 4 }, () => generateIdentity()));
  const tokenA = randomBase64Url(32), tokenB = randomBase64Url(32), accessA = randomBase64Url(32), accessB = randomBase64Url(32);
  const room = store.createRoom(a.publicBundle, tokenA, randomBase64Url(32), 'A', ['joint-recovery-v1']);
  const state = store.joinRoom(room.roomId, b.publicBundle, 'proof', tokenB, 'B', ['joint-recovery-v1']);
  const common = { v: 3 as const, roomId: room.roomId, pairingSecret: '', creatorFingerprint: '', members: state.members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const };
  const oldA: Vault = { ...common, role: 'creator', identity: a, accessToken: tokenA, mls: await createCreatorMlsState(room.roomId, a, state.members) };
  oldA.mls = await prepareCreatorWelcome(oldA); store.saveMlsWelcome(room.roomId, oldA.mls.pendingWelcome);
  const requestId = crypto.randomUUID(), capability = randomBase64Url(32), expiresAt = new Date(Date.now() + 600000).toISOString();
  const offers = {} as Record<'creator' | 'joiner', JointOffer>;
  for (const [role, source, target, accessToken] of [['creator', a, freshA, accessA], ['joiner', b, freshB, accessB]] as const) {
    const value = { v: 1 as const, roomId: room.roomId, requestId, expiresAt, capabilityHash: toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(capability))), baseEventSeq: 0, sourceDeviceId: source.publicBundle.deviceId,
      role, target: target.publicBundle, tokenHash: toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))),
      recover: role === 'creator', scope: { creator: true, joiner: false }, deviceName: role, capabilities: ['joint-recovery-v1'] };
    offers[role] = { ...value, signature: await signEcdsa(source.signingPrivateKey, value) };
  }
  const fresh: Vault = { ...oldA, identity: freshA, members: jointMembers(offers), accessToken: accessA };
  fresh.mls = await createCreatorMlsState(room.roomId, freshA, fresh.members); fresh.mls = await prepareCreatorWelcome(fresh);
  const freshPeer: Vault = { ...fresh, role: 'joiner', identity: freshB, accessToken: accessB };
  freshPeer.mls = await joinMlsGroup(freshPeer, fresh.mls.pendingWelcome!);
  const proposal: JointProposal = { v: 1, roomId: room.roomId, requestId, expiresAt, baseEventSeq: 0, offers, retireOtherDevices: true, welcome: fresh.mls.pendingWelcome! };
  const link = { roomId: room.roomId, requestId, capability };
  const pending: PendingJointRecovery = { link, initiator: 'creator', ownOffer: offers.creator, source: oldA, trustedMembers: state.members,
    identity: freshA, accessToken: accessA, preserveHistory: false, recoverySource: { backupId: '', archives: [] }, proposal, mls: fresh.mls };
  return { store, a, b, oldA, fresh, freshPeer, offers, proposal, link, pending, tokenA, tokenB, accessA, accessB };
}
describe('joint recovery requires independently authenticated participants', () => {
  it('requires both proposal signatures, retires old identities atomically, and starts a fresh interoperable MLS group', async () => {
    const f = await fixture(), j = f.store.jointRecovery, { roomId, requestId, capability } = f.link;
    await j.create(f.offers.creator, capability);
    expect(() => j.status(roomId, requestId, randomBase64Url(32))).toThrow('UNAUTHORIZED');
    await expect(j.participate(roomId, requestId, capability, { ...f.offers.joiner, recover: true })).rejects.toThrow();
    await j.participate(roomId, requestId, capability, f.offers.joiner);
    await j.propose(roomId, requestId, capability, f.proposal);
    const first = await j.approve(roomId, requestId, capability, { role: 'creator', signature: await signEcdsa(f.a.signingPrivateKey, f.proposal) });
    expect(first.result).toBeNull(); expect(f.store.authenticatedDevice(roomId, f.tokenA)).toBeTruthy();
    await expect(j.approve(roomId, requestId, capability, { role: 'joiner', signature: await signEcdsa(f.a.signingPrivateKey, f.proposal) })).rejects.toThrow();
    const result = await j.approve(roomId, requestId, capability, { role: 'joiner', signature: await signEcdsa(f.b.signingPrivateKey, f.proposal) });
    await verifyJointSnapshot(f.pending, result);
    expect(result.result.eventSeq).toBe(1); expect(result.state.mlsEpochOffset).toBe(1);
    expect(f.store.authenticatedDevice(roomId, f.tokenA)).toBeNull(); expect(f.store.authenticatedDevice(roomId, f.tokenB)).toBeNull();
    expect(f.store.authenticatedDevice(roomId, f.accessA)).toBeTruthy(); expect(f.store.authenticatedDevice(roomId, f.accessB)).toBeTruthy();
    expect(result.state.members.filter((m: {status:string}) => m.status === 'active')).toHaveLength(2);
    expect((await j.create(f.offers.creator, capability)).result).toEqual(result.result);
    expect((await j.approve(roomId, requestId, capability, { role: 'creator', signature: 'retry' })).result).toEqual(result.result);
    const message = await encryptMlsApplication(f.fresh, { v: 1, kind: 'text', text: 'after recovery', sentAt: new Date().toISOString() }, crypto.randomUUID());
    expect((await decryptMlsApplication(f.freshPeer, message.envelope)).payload).toMatchObject({ text: 'after recovery' });
    await expect(decryptMlsApplication(f.oldA, message.envelope)).rejects.toThrow();
    await expect(verifyJointSnapshot(f.pending, { ...result, approvals: { creator: result.approvals.creator } })).rejects.toThrow();
    await expect(verifyJointSnapshot(f.pending, { ...result, result: { ...result.result, eventSeq: 2 } })).rejects.toThrow();
    expect(() => j.catchUp(roomId, requestId, f.fresh.identity.publicBundle.deviceId, 0)).toThrow('UNAUTHORIZED');
    expect(j.catchUp(roomId, requestId, f.freshPeer.identity.publicBundle.deviceId, 0)).toEqual([]);
  }, 20000);
  it('rejects mutation of the final scope, old-key replay, and malformed expiration without changing membership', async () => {
    const f = await fixture(), j = f.store.jointRecovery, { roomId, requestId, capability } = f.link;
    await expect(j.create({ ...f.offers.creator, expiresAt: 'bad' }, capability)).rejects.toThrow('INVALID_RECOVERY_REQUEST');
    await j.create(f.offers.creator, capability); await j.participate(roomId, requestId, capability, f.offers.joiner);
    await expect(j.propose(roomId, requestId, capability, { ...f.proposal, retireOtherDevices: false })).rejects.toThrow();
    await j.propose(roomId, requestId, capability, f.proposal);
    const changed = { ...f.proposal, offers: { ...f.proposal.offers, joiner: { ...f.offers.joiner, recover: true } } };
    await expect(j.propose(roomId, requestId, capability, changed)).rejects.toThrow();
    await expect(j.approve(roomId, requestId, capability, { role: 'creator', signature: f.offers.creator.signature })).rejects.toThrow();
    expect(f.store.authenticatedDevice(roomId, f.tokenA)).toBeTruthy();
    f.store.saveInvitationProgress(roomId, 'opened');
    expect(f.store.roomState(roomId).invitationProgress.stage).toBe('opened');
    f.store.saveInvitationProgress(roomId, 'setting');
    f.store.saveInvitationProgress(roomId, 'opened');
    expect(f.store.roomState(roomId).invitationProgress.stage).toBe('setting');
  }, 20000);
});
