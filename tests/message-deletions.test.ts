import { describe, expect, it } from 'vitest';
import { reduceMessageDeletions } from '../src/lib/message-deletions';
import type { DecryptedMessage, RoomMember } from '../src/lib/types';

const creatorDevice = crypto.randomUUID();
const linkedCreatorDevice = crypto.randomUUID();
const joinerDevice = crypto.randomUUID();
const memberRoles = new Map<string, RoomMember['role']>([
  [creatorDevice, 'creator'],
  [linkedCreatorDevice, 'creator'],
  [joinerDevice, 'joiner'],
]);
const sentAt = '2026-09-05T10:00:00.000Z';

function textMessage(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
  return {
    seq: 1,
    clientMsgId: crypto.randomUUID(),
    senderId: creatorDevice,
    payload: { v: 1, kind: 'text', text: 'A confirmed chat message', sentAt },
    acceptedAt: sentAt,
    status: 'delivered',
    ...overrides,
  };
}

function deletion(
  target: DecryptedMessage,
  seq: number,
  senderId: string,
  overrides: Partial<DecryptedMessage> = {},
): DecryptedMessage {
  return {
    seq,
    clientMsgId: crypto.randomUUID(),
    senderId,
    payload: {
      v: 1,
      kind: 'message-delete',
      sentAt,
      target: { clientMsgId: target.clientMsgId, serverSeq: target.seq, senderId: target.senderId },
    },
    acceptedAt: sentAt,
    status: 'stored',
    ...overrides,
  };
}

describe('message deletion replay', () => {
  it('lets an authenticated linked device tombstone a confirmed message from the same role', () => {
    const target = textMessage();
    const event = deletion(target, 2, linkedCreatorDevice);
    expect(reduceMessageDeletions([event, target], memberRoles).get(target.clientMsgId)).toEqual({
      target: { clientMsgId: target.clientMsgId, serverSeq: target.seq, senderId: target.senderId },
      role: 'creator',
      senderId: linkedCreatorDevice,
      clientMsgId: event.clientMsgId,
      serverSeq: 2,
      pending: false,
    });
  });

  it('rejects cross-role and unknown event or target devices', () => {
    const target = textMessage();
    const crossRole = deletion(target, 2, joinerDevice);
    const unknownDevice = deletion(target, 2, crypto.randomUUID());
    const unknownTarget = textMessage({ senderId: crypto.randomUUID() });
    for (const [source, event] of [
      [target, crossRole],
      [target, unknownDevice],
      [unknownTarget, deletion(unknownTarget, 2, creatorDevice)],
    ] as const) {
      expect(reduceMessageDeletions([source, event], memberRoles).size).toBe(0);
    }
  });

  it('requires the exact target identity triple and an event after the target', () => {
    const target = textMessage({ seq: 2 });
    const valid = deletion(target, 3, creatorDevice);
    if (valid.payload.kind !== 'message-delete') throw new Error('test fixture');
    const forged = [
      { ...valid, payload: { ...valid.payload, target: { ...valid.payload.target, clientMsgId: crypto.randomUUID() } } },
      { ...valid, payload: { ...valid.payload, target: { ...valid.payload.target, senderId: linkedCreatorDevice } } },
      { ...valid, payload: { ...valid.payload, target: { ...valid.payload.target, serverSeq: 1 } } },
      { ...valid, seq: 2 },
      { ...valid, seq: 1 },
    ];
    for (const event of forged) {
      expect(reduceMessageDeletions([target, event], memberRoles).size).toBe(0);
    }

    const collidingTarget = textMessage({ seq: target.seq });
    expect(reduceMessageDeletions([target, collidingTarget, valid], memberRoles).size).toBe(0);
  });

  it('rejects unconfirmed chat targets, gallery items, and encrypted event targets', () => {
    const target = textMessage();
    for (const status of ['pending', 'failed'] as const) {
      expect(reduceMessageDeletions([{ ...target, status }, deletion(target, 2, creatorDevice)], memberRoles).size).toBe(0);
    }

    const attachment = {
      v: 1 as const,
      blobId: crypto.randomUUID(),
      key: 'test-key',
      ivPrefix: 'test-iv',
      chunkSize: 2 * 1024 * 1024,
      chunkCount: 1,
      originalSize: 1,
      originalName: 'item.bin',
      mimeType: 'application/octet-stream',
      lastModified: 0,
      sha256: '0'.repeat(64),
    };
    const galleryFile: DecryptedMessage = { ...target, payload: { v: 1, kind: 'gallery-file', file: attachment, sentAt } };
    const galleryImage: DecryptedMessage = {
      ...target,
      payload: { v: 1, kind: 'gallery-image', image: { ...attachment, originalName: 'photo.png', mimeType: 'image/png' }, sentAt },
    };
    const reaction: DecryptedMessage = {
      ...target,
      payload: {
        v: 1,
        kind: 'reaction',
        sentAt,
        target: { clientMsgId: crypto.randomUUID(), serverSeq: 1, senderId: creatorDevice },
        emoji: '👍',
      },
    };
    const deleteEvent = deletion(target, 1, creatorDevice);
    for (const eventTarget of [galleryFile, galleryImage, reaction, deleteEvent]) {
      expect(reduceMessageDeletions([eventTarget, deletion(eventTarget, 2, creatorDevice)], memberRoles).size).toBe(0);
    }
  });

  it('applies an optimistic tombstone and lets its confirmed copy replace pending metadata', () => {
    const target = textMessage();
    const eventId = crypto.randomUUID();
    const pending = deletion(target, Number.MAX_SAFE_INTEGER, creatorDevice, {
      clientMsgId: eventId,
      status: 'pending',
    });
    expect(reduceMessageDeletions([target, pending], memberRoles).get(target.clientMsgId)).toMatchObject({
      clientMsgId: eventId,
      serverSeq: null,
      pending: true,
    });

    const confirmed = { ...pending, seq: 2, status: 'stored' as const };
    for (const history of [[target, pending, confirmed], [confirmed, pending, target]]) {
      expect(reduceMessageDeletions(history, memberRoles).get(target.clientMsgId)).toMatchObject({
        clientMsgId: eventId,
        serverSeq: 2,
        pending: false,
      });
    }
  });

  it('keeps the tombstone between socket acknowledgement and sequence sync', () => {
    const target = textMessage();
    const acknowledged = deletion(target, Number.MAX_SAFE_INTEGER, creatorDevice, {
      status: 'stored',
    });
    expect(reduceMessageDeletions([target, acknowledged], memberRoles).get(target.clientMsgId)).toMatchObject({
      clientMsgId: acknowledged.clientMsgId,
      serverSeq: null,
      pending: true,
    });
  });

  it('keeps deletion one-way and ignores failed or later optimistic replays', () => {
    const target = textMessage();
    const confirmed = deletion(target, 2, creatorDevice);
    const laterPending = deletion(target, Number.MAX_SAFE_INTEGER, linkedCreatorDevice, { status: 'pending' });
    const failed = deletion(target, Number.MAX_SAFE_INTEGER, creatorDevice, { status: 'failed' });
    const tombstone = reduceMessageDeletions([target, confirmed, laterPending, failed], memberRoles).get(target.clientMsgId);
    expect(tombstone).toMatchObject({
      clientMsgId: confirmed.clientMsgId,
      serverSeq: 2,
      pending: false,
    });
  });

  it('accepts each confirmed chat payload kind and never a failed delete event', () => {
    const base = textMessage();
    const attachment = {
      v: 1 as const,
      blobId: crypto.randomUUID(),
      key: 'test-key',
      ivPrefix: 'test-iv',
      chunkSize: 2 * 1024 * 1024,
      chunkCount: 1,
      originalSize: 1,
      originalName: 'photo.png',
      mimeType: 'image/png',
      lastModified: 0,
      sha256: '0'.repeat(64),
    };
    const targets: DecryptedMessage[] = [
      base,
      { ...base, payload: { v: 1, kind: 'image', image: attachment, sentAt } },
      { ...base, payload: { v: 1, kind: 'image-album', images: [attachment, { ...attachment, blobId: crypto.randomUUID() }], sentAt } },
      { ...base, payload: { v: 1, kind: 'audio', audio: attachment, durationMs: 500, waveform: [50], sentAt } },
      { ...base, payload: { v: 1, kind: 'file', file: attachment, sentAt } },
    ];
    for (const target of targets) {
      expect(reduceMessageDeletions([target, deletion(target, 2, linkedCreatorDevice)], memberRoles).has(target.clientMsgId)).toBe(true);
      expect(reduceMessageDeletions([
        target,
        deletion(target, Number.MAX_SAFE_INTEGER, linkedCreatorDevice, { status: 'failed' }),
      ], memberRoles).size).toBe(0);
    }
  });
});
