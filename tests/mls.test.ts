import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/lib/crypto';
import {
  createCreatorMlsState,
  decryptMlsApplication,
  encryptMlsApplication,
  joinMlsGroup,
  joinMlsMembership,
  prepareCreatorWelcome,
  prepareMlsMembership,
  processMlsMembership,
} from '../src/lib/mls';
import { mlsPrivateMessageEpoch, mlsPublicMessageEpoch } from '../server/protocol.mjs';
import { randomBase64Url } from '../src/lib/base64';
import type { RoomMember, Vault } from '../src/lib/types';

describe('RFC 9420 MLS message state', () => {
  it('binds key packages to enrolled device identities and advances per-message ratchets', async () => {
    const roomId = crypto.randomUUID();
    const [creatorIdentity, joinerIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
    const members: RoomMember[] = [
      { ...creatorIdentity.publicBundle, role: 'creator', joinProof: null },
      { ...joinerIdentity.publicBundle, role: 'joiner', joinProof: 'bound-by-invite' },
    ];
    const common = {
      v: 2 as const,
      roomId,
      accessToken: 'a'.repeat(43),
      pairingSecret: 'b'.repeat(43),
      creatorFingerprint: 'creator-fingerprint',
      members,
      lastSeq: 0,
      createdAt: new Date().toISOString(),
      protocol: 'mls-rfc9420' as const,
    };
    const creator: Vault = {
      ...common,
      role: 'creator',
      identity: creatorIdentity,
      mls: await createCreatorMlsState(roomId, creatorIdentity, members),
    };
    creator.mls = await prepareCreatorWelcome(creator);
    expect(creator.mls.pendingWelcome).toBeDefined();

    const joiner: Vault = {
      ...common,
      role: 'joiner',
      identity: joinerIdentity,
      mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' },
    };
    joiner.mls = await joinMlsGroup(joiner, creator.mls.pendingWelcome!);
    creator.mls = { ...creator.mls, pendingWelcome: undefined };

    const payload = { v: 1 as const, kind: 'text' as const, text: 'forward-secret', sentAt: new Date().toISOString() };
    const firstId = crypto.randomUUID();
    const first = await encryptMlsApplication(creator, payload, firstId);
    creator.mls.groupState = first.nextGroupState;
    const opened = await decryptMlsApplication(joiner, first.envelope);
    joiner.mls.groupState = opened.nextGroupState;
    expect(opened.payload).toEqual(payload);

    await expect(decryptMlsApplication(joiner, first.envelope)).rejects.toThrow();

    const replyId = crypto.randomUUID();
    const reply = await encryptMlsApplication(joiner, { ...payload, text: 'reply' }, replyId);
    joiner.mls.groupState = reply.nextGroupState;
    const openedReply = await decryptMlsApplication(creator, reply.envelope);
    creator.mls.groupState = openedReply.nextGroupState;
    expect(openedReply.payload).toMatchObject({ kind: 'text', text: 'reply' });

    const galleryPayload = {
      v: 1 as const,
      kind: 'gallery-image' as const,
      sentAt: new Date().toISOString(),
      image: {
        v: 1 as const,
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
    const gallery = await encryptMlsApplication(creator, galleryPayload, crypto.randomUUID());
    creator.mls.groupState = gallery.nextGroupState;
    const openedGallery = await decryptMlsApplication(joiner, gallery.envelope);
    expect(openedGallery.payload).toEqual(galleryPayload);
  }, 20_000);

  it('rejects a welcome signed by an unenrolled identity', async () => {
    const roomId = crypto.randomUUID();
    const [creatorIdentity, joinerIdentity, attackerIdentity] = await Promise.all([
      generateIdentity(),
      generateIdentity(),
      generateIdentity(),
    ]);
    const members: RoomMember[] = [
      { ...creatorIdentity.publicBundle, role: 'creator', joinProof: null },
      { ...joinerIdentity.publicBundle, role: 'joiner', joinProof: 'proof' },
    ];
    const creator: Vault = {
      v: 2,
      roomId,
      accessToken: 'a'.repeat(43),
      role: 'creator',
      pairingSecret: 'b'.repeat(43),
      creatorFingerprint: 'fingerprint',
      identity: creatorIdentity,
      members,
      lastSeq: 0,
      createdAt: new Date().toISOString(),
      protocol: 'mls-rfc9420',
      mls: await createCreatorMlsState(roomId, creatorIdentity, members),
    };
    creator.mls = await prepareCreatorWelcome(creator);
    const joiner: Vault = { ...creator, role: 'joiner', identity: joinerIdentity, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
    const tampered = { ...creator.mls.pendingWelcome!, senderId: attackerIdentity.publicBundle.deviceId };
    await expect(joinMlsGroup(joiner, tampered)).rejects.toThrow('成员不匹配');
  }, 20_000);

  it('adds an independently keyed device without sharing prior epochs', async () => {
    const roomId = crypto.randomUUID();
    const [creatorIdentity, joinerIdentity, newDeviceIdentity] = await Promise.all([
      generateIdentity(),
      generateIdentity(),
      generateIdentity(),
    ]);
    const initialMembers: RoomMember[] = [
      { ...creatorIdentity.publicBundle, role: 'creator', joinProof: null, status: 'active' },
      { ...joinerIdentity.publicBundle, role: 'joiner', joinProof: 'proof', status: 'active' },
    ];
    const base = {
      v: 3 as const,
      roomId,
      accessToken: randomBase64Url(32),
      pairingSecret: randomBase64Url(32),
      creatorFingerprint: 'fingerprint',
      lastSeq: 0,
      createdAt: new Date().toISOString(),
      protocol: 'mls-rfc9420' as const,
    };
    const creator: Vault = {
      ...base,
      role: 'creator',
      identity: creatorIdentity,
      members: initialMembers,
      mls: await createCreatorMlsState(roomId, creatorIdentity, initialMembers),
    };
    creator.mls = await prepareCreatorWelcome(creator);
    const joiner: Vault = {
      ...base,
      role: 'joiner',
      identity: joinerIdentity,
      members: initialMembers,
      mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' },
    };
    joiner.mls = await joinMlsGroup(joiner, creator.mls.pendingWelcome!);
    creator.mls = { ...creator.mls, pendingWelcome: undefined, lastEventSeq: 0 };
    joiner.mls.lastEventSeq = 0;

    const before = await encryptMlsApplication(creator, {
      v: 1,
      kind: 'text',
      text: 'before device joined',
      sentAt: new Date().toISOString(),
    }, crypto.randomUUID());
    expect(mlsPrivateMessageEpoch(before.envelope.ciphertext)).toBe(1);
    creator.mls.groupState = before.nextGroupState;
    const beforeOpened = await decryptMlsApplication(joiner, before.envelope);
    joiner.mls.groupState = beforeOpened.nextGroupState;

    const addedMember: RoomMember = {
      ...newDeviceIdentity.publicBundle,
      role: 'creator',
      joinProof: null,
      status: 'pending',
      addedBy: creatorIdentity.publicBundle.deviceId,
      joinSeq: 1,
      joinReceiptSeq: 0,
      capabilities: ['mls-multidevice-v1'],
      createdAt: new Date().toISOString(),
    };
    creator.members = [...initialMembers, addedMember];
    joiner.members = creator.members;
    const prepared = await prepareMlsMembership(creator, 'add', addedMember);
    expect(mlsPublicMessageEpoch(prepared.event.commit)).toBe(1);
    creator.mls.groupState = prepared.nextGroupState;
    creator.mls.lastEventSeq = 1;
    joiner.mls.groupState = await processMlsMembership(joiner, prepared.event, 1);
    joiner.mls.lastEventSeq = 1;

    const newDevice: Vault = {
      ...base,
      role: 'creator',
      identity: newDeviceIdentity,
      members: creator.members.map((member) => member.deviceId === addedMember.deviceId ? { ...member, status: 'active' } : member),
      mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: 0 },
    };
    await expect(joinMlsMembership(newDevice, prepared.event, 2)).rejects.toThrow('顺序不连续');
    newDevice.mls = await joinMlsMembership(newDevice, prepared.event, 1);

    const after = await encryptMlsApplication(joiner, {
      v: 1,
      kind: 'text',
      text: 'after device joined',
      sentAt: new Date().toISOString(),
    }, crypto.randomUUID());
    expect(mlsPrivateMessageEpoch(after.envelope.ciphertext)).toBe(2);
    joiner.mls.groupState = after.nextGroupState;
    const openedAfter = await decryptMlsApplication(newDevice, after.envelope);
    expect(openedAfter.payload).toMatchObject({ text: 'after device joined' });
    await expect(decryptMlsApplication(newDevice, before.envelope)).rejects.toThrow();
  }, 30_000);
});
