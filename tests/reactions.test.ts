import { describe, expect, it } from 'vitest';
import { reduceMessageReactions } from '../src/lib/reactions';
import type { DecryptedMessage, ReactionPayload, RoomMember } from '../src/lib/types';

const creatorDevice = crypto.randomUUID();
const linkedCreatorDevice = crypto.randomUUID();
const joinerDevice = crypto.randomUUID();
const memberRoles = new Map<string, RoomMember['role']>([
  [creatorDevice, 'creator'],
  [linkedCreatorDevice, 'creator'],
  [joinerDevice, 'joiner'],
]);
const sentAt = '2026-09-04T10:00:00.000Z';

function textMessage(): DecryptedMessage {
  return {
    seq: 1,
    clientMsgId: crypto.randomUUID(),
    senderId: creatorDevice,
    payload: { v: 1, kind: 'text', text: 'A message to react to', sentAt },
    acceptedAt: sentAt,
    status: 'delivered',
  };
}

function reaction(
  target: DecryptedMessage,
  seq: number,
  senderId: string,
  emoji: ReactionPayload['emoji'],
  overrides: Partial<DecryptedMessage> = {},
): DecryptedMessage {
  return {
    seq,
    clientMsgId: crypto.randomUUID(),
    senderId,
    payload: {
      v: 1,
      kind: 'reaction',
      sentAt,
      target: { clientMsgId: target.clientMsgId, serverSeq: target.seq, senderId: target.senderId },
      emoji,
    },
    acceptedAt: sentAt,
    status: 'stored',
    ...overrides,
  };
}

describe('message reaction replay', () => {
  it('keeps the latest server event for each participant across devices and unordered history pages', () => {
    const target = textMessage();
    const original = reaction(target, 2, creatorDevice, '❤️');
    const peer = reaction(target, 3, joinerDevice, '😂');
    const linkedDeviceUpdate = reaction(target, 4, linkedCreatorDevice, '👍', {
      // Sender clocks do not affect confirmed reaction ordering.
      acceptedAt: '2020-01-01T00:00:00.000Z',
    });
    const badges = reduceMessageReactions([linkedDeviceUpdate, peer, target, original], memberRoles).get(target.clientMsgId);
    expect(badges).toEqual([
      { role: 'creator', senderId: linkedCreatorDevice, emoji: '👍', clientMsgId: linkedDeviceUpdate.clientMsgId, pending: false },
      { role: 'joiner', senderId: joinerDevice, emoji: '😂', clientMsgId: peer.clientMsgId, pending: false },
    ]);
  });

  it('applies an optimistic update or removal after history, including multiple local taps in the same millisecond', () => {
    const target = textMessage();
    const original = reaction(target, 2, creatorDevice, '❤️');
    const pendingUpdate = reaction(target, Number.MAX_SAFE_INTEGER, creatorDevice, '👍', { status: 'pending' });
    const pendingRemoval = reaction(target, Number.MAX_SAFE_INTEGER, creatorDevice, null, { status: 'pending' });
    expect(reduceMessageReactions([pendingUpdate, target, original], memberRoles).get(target.clientMsgId)?.[0])
      .toMatchObject({ emoji: '👍', pending: true });
    expect(reduceMessageReactions([target, original, pendingUpdate, pendingRemoval], memberRoles).has(target.clientMsgId)).toBe(false);
  });

  it('does not let an acknowledged optimistic duplicate override a later server reaction', () => {
    const target = textMessage();
    const original = reaction(target, 2, creatorDevice, '❤️');
    const stalePending = { ...original, seq: Number.MAX_SAFE_INTEGER, status: 'pending' as const };
    const subsequent = reaction(target, 3, linkedCreatorDevice, '👍');
    for (const history of [[target, stalePending, original, subsequent], [subsequent, original, target, stalePending]]) {
      expect(reduceMessageReactions(history, memberRoles).get(target.clientMsgId)?.[0])
        .toMatchObject({ emoji: '👍', pending: false, clientMsgId: subsequent.clientMsgId });
    }
  });

  it('removes only the reacting participant and leaves a failed update unapplied', () => {
    const target = textMessage();
    const own = reaction(target, 2, creatorDevice, '❤️');
    const peer = reaction(target, 3, joinerDevice, '😂');
    const removal = reaction(target, 4, linkedCreatorDevice, null);
    const failedRemoval = reaction(target, Number.MAX_SAFE_INTEGER, joinerDevice, null, { status: 'failed' });
    expect(reduceMessageReactions([target, own, peer, removal, failedRemoval], memberRoles).get(target.clientMsgId))
      .toEqual([{ role: 'joiner', senderId: joinerDevice, emoji: '😂', clientMsgId: peer.clientMsgId, pending: false }]);
  });

  it('rejects missing targets, mismatched identity triples, unknown senders, and non-chat targets', () => {
    const target = textMessage();
    const valid = reaction(target, 3, creatorDevice, '❤️');
    if (valid.payload.kind !== 'reaction') throw new Error('test fixture');
    const mismatchedId = { ...valid, payload: { ...valid.payload, target: { ...valid.payload.target, clientMsgId: crypto.randomUUID() } } };
    const mismatchedSender = { ...valid, payload: { ...valid.payload, target: { ...valid.payload.target, senderId: joinerDevice } } };
    const mismatchedSeq = { ...valid, payload: { ...valid.payload, target: { ...valid.payload.target, serverSeq: 2 } } };
    const unknownSender = { ...valid, senderId: crypto.randomUUID() };
    for (const event of [mismatchedId, mismatchedSender, mismatchedSeq, unknownSender]) {
      expect(reduceMessageReactions([target, event], memberRoles).size).toBe(0);
    }
    expect(reduceMessageReactions([valid], memberRoles).size).toBe(0);
    expect(reduceMessageReactions([valid, reaction(valid, 4, joinerDevice, '👍')], memberRoles).size).toBe(0);
  });

  it('rejects a confirmed event preceding its target and optimistic or failed targets', () => {
    const target = textMessage();
    const tooEarly = reaction(target, 1, creatorDevice, '❤️');
    expect(reduceMessageReactions([target, tooEarly], memberRoles).size).toBe(0);
    const valid = reaction(target, 2, creatorDevice, '❤️');
    for (const status of ['pending', 'failed'] as const) {
      expect(reduceMessageReactions([{ ...target, status }, valid], memberRoles).size).toBe(0);
    }
  });
});
