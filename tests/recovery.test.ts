import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/lib/crypto';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, encryptMlsApplication, decryptMlsApplication, createRecoveryRequest, prepareMlsMembership, processMlsMembership, prepareMlsRecoveryReplacement, joinMlsMembership, verifyRecoveryMembershipChain } from '../src/lib/mls';
import type { RoomMember, Vault, RoomState } from '../src/lib/types';

describe('recovery with a fresh MLS identity', () => {
  it('recovers an old checkpoint after later source sends and a source-authored epoch change', async () => {
    const [aId, bId, extraId, freshId] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity(), generateIdentity()]);
    const roomId = crypto.randomUUID();
    const members: RoomMember[] = [
      { ...aId.publicBundle, role: 'creator', joinProof: null, status: 'active', addedBy: null },
      { ...bId.publicBundle, role: 'joiner', joinProof: 'proof', status: 'active', addedBy: null },
    ];
    const base = { v: 3 as const, roomId, accessToken: 'a'.repeat(43), pairingSecret: '', creatorFingerprint: 'fingerprint', members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const };
    const a: Vault = { ...base, role: 'creator', identity: aId, mls: await createCreatorMlsState(roomId, aId, members) };
    a.mls = await prepareCreatorWelcome(a);
    const b: Vault = { ...base, role: 'joiner', identity: bId, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
    b.mls = await joinMlsGroup(b, a.mls.pendingWelcome!);
    a.mls.pendingWelcome = undefined;
    a.mls.lastEventSeq = b.mls.lastEventSeq = 0;
    const checkpoint = structuredClone(a);
    const text = (value: string) => ({ v: 1 as const, kind: 'text' as const, text: value, sentAt: new Date().toISOString() });
    const oldMessage = await encryptMlsApplication(a, text('after old backup'), crypto.randomUUID());
    a.mls.groupState = oldMessage.nextGroupState;
    b.mls.groupState = (await decryptMlsApplication(b, oldMessage.envelope)).nextGroupState;
    const extra: RoomMember = { ...extraId.publicBundle, role: 'creator', joinProof: null, status: 'pending', addedBy: aId.publicBundle.deviceId };
    a.members = b.members = [...members, extra];
    const add = await prepareMlsMembership(a, 'add', extra);
    a.mls.groupState = add.nextGroupState;
    b.mls.groupState = await processMlsMembership(b, add.event, 1);
    a.mls.lastEventSeq = b.mls.lastEventSeq = 1;
    const request = await createRecoveryRequest(checkpoint, freshId.publicBundle, 'n'.repeat(43));
    const fresh: RoomMember = { ...freshId.publicBundle, role: 'creator', joinProof: null, status: 'pending', addedBy: aId.publicBundle.deviceId };
    b.members = [...members, { ...extra, status: 'active' }, fresh];
    const replacement = await prepareMlsRecoveryReplacement(b, request, fresh);
    b.mls.groupState = replacement.nextGroupState;
    b.mls.lastEventSeq = 2;
    const activeMembers: RoomMember[] = b.members.map((member) => member.deviceId === aId.publicBundle.deviceId
      ? { ...member, status: 'revoked' } : member.deviceId === fresh.deviceId ? { ...member, status: 'active', joinSeq: 1, joinReceiptSeq: 0 } : member);
    const recovered: Vault = { ...checkpoint, identity: freshId, accessToken: 'n'.repeat(43), members: activeMembers,
      pendingRecovery: { request, checkpointMembers: checkpoint.members, checkpointEventSeq: 0 },
      mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: 1 } };
    const state: RoomState = { roomId, protocol: 'mls-rfc9420', nextSeq: 1, sealedAt: new Date().toISOString(), members: activeMembers, nextMlsEventSeq: 2,
      mlsEvents: [{ eventSeq: 1, event: add.event, acceptedAt: new Date().toISOString() }, { eventSeq: 2, event: replacement.event, acceptedAt: new Date().toISOString() }] };
    await verifyRecoveryMembershipChain(recovered, state);
    recovered.mls = await joinMlsMembership(recovered, replacement.event, 2);
    expect(recovered.identity.publicBundle.deviceId).not.toBe(checkpoint.identity.publicBundle.deviceId);
    await expect(decryptMlsApplication(recovered, oldMessage.envelope)).rejects.toThrow();
    const next = await encryptMlsApplication(recovered, text('new identity'), crypto.randomUUID());
    expect((await decryptMlsApplication(b, next.envelope)).payload).toMatchObject({ text: 'new identity' });
    const tampered = structuredClone(replacement.event);
    tampered.recoveryRequest!.replacement = extraId.publicBundle;
    await expect(joinMlsMembership({ ...recovered, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: 1 } }, tampered, 2)).rejects.toThrow();
    const omitted = { ...state, mlsEvents: state.mlsEvents!.slice(1) };
    await expect(verifyRecoveryMembershipChain(recovered, omitted)).rejects.toThrow('不连续');
  }, 20_000);
});
