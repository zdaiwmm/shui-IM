import type {
  DecryptedMessage,
  MessageDeletePayload,
  MessageTarget,
  RoomMember,
} from './types';

export type MessageDeletionTombstone = {
  target: MessageTarget;
  role: RoomMember['role'];
  /** Device that authored the encrypted delete event. */
  senderId: string;
  /** Delete event ID, not the target message ID. */
  clientMsgId: string;
  /** Null until an optimistic event receives a server sequence. */
  serverSeq: number | null;
  pending: boolean;
};

function isConfirmed(message: DecryptedMessage): boolean {
  return message.status !== 'pending' && message.status !== 'failed' &&
    Number.isSafeInteger(message.seq) && message.seq > 0 && message.seq < Number.MAX_SAFE_INTEGER;
}

function isOptimisticProjection(message: DecryptedMessage): boolean {
  return message.seq === Number.MAX_SAFE_INTEGER &&
    (message.status === 'pending' || message.status === 'stored');
}

function isConfirmedChatContent(message: DecryptedMessage): boolean {
  if (!isConfirmed(message)) return false;
  switch (message.payload.kind) {
    case 'text':
    case 'image':
    case 'image-album':
    case 'audio':
    case 'file':
      return true;
    default:
      return false;
  }
}

function sameIdentity(left: DecryptedMessage, right: DecryptedMessage): boolean {
  return left.clientMsgId === right.clientMsgId && left.senderId === right.senderId;
}

/**
 * Projects encrypted `message-delete` events into irreversible tombstones.
 *
 * `memberRoles` must come from the authenticated membership history, not a
 * server-claimed roster. Its presence is the authorization proof available to
 * this pure projection: unknown event or target devices are rejected. A linked
 * device may delete a participant's message only when both devices have the
 * same authenticated role.
 *
 * Confirmed events use server order and always supersede an optimistic copy
 * with the same clientMsgId. Once a target has any valid delete event, later
 * replay cannot remove its tombstone.
 */
export function reduceMessageDeletions(
  messages: readonly DecryptedMessage[],
  memberRoles: ReadonlyMap<string, RoomMember['role']>,
): Map<string, MessageDeletionTombstone> {
  const targets = new Map<number, DecryptedMessage>();
  const ambiguousTargetSequences = new Set<number>();
  const events = new Map<string, {
    message: DecryptedMessage & { payload: MessageDeletePayload };
    index: number;
  }>();

  messages.forEach((message, index) => {
    if (isConfirmedChatContent(message)) {
      const previous = targets.get(message.seq);
      if (previous && !sameIdentity(previous, message)) {
        targets.delete(message.seq);
        ambiguousTargetSequences.add(message.seq);
      } else if (!ambiguousTargetSequences.has(message.seq)) {
        targets.set(message.seq, message);
      }
    }
    if (message.payload.kind !== 'message-delete') return;
    // The socket ACK changes a local pending item to `stored` before sync
    // supplies its real sequence. Keep that acknowledged optimistic event in
    // the projection so a deleted row cannot briefly reappear in this gap.
    if (message.status === 'failed' || (!isConfirmed(message) && !isOptimisticProjection(message))) return;
    const previous = events.get(message.clientMsgId);
    if (!previous || !isConfirmed(previous.message)) {
      events.set(message.clientMsgId, {
        message: message as DecryptedMessage & { payload: MessageDeletePayload },
        index,
      });
    }
  });

  const ordered = [...events.values()].sort((left, right) => {
    const leftConfirmed = isConfirmed(left.message);
    const rightConfirmed = isConfirmed(right.message);
    if (leftConfirmed !== rightConfirmed) return leftConfirmed ? -1 : 1;
    if (leftConfirmed) return left.message.seq - right.message.seq || left.index - right.index;
    return left.index - right.index;
  });

  const tombstones = new Map<string, MessageDeletionTombstone>();
  for (const { message } of ordered) {
    const target = message.payload.target;
    const deletingRole = memberRoles.get(message.senderId);
    const targetRole = memberRoles.get(target.senderId);
    const targetMessage = targets.get(target.serverSeq);
    if (!deletingRole || !targetRole || deletingRole !== targetRole || !targetMessage) continue;
    if (targetMessage.clientMsgId !== target.clientMsgId || targetMessage.senderId !== target.senderId) continue;
    if (isConfirmed(message) && message.seq <= target.serverSeq) continue;

    const pending = !isConfirmed(message);
    const previous = tombstones.get(target.clientMsgId);
    if (previous && (!previous.pending || pending)) continue;
    tombstones.set(target.clientMsgId, {
      target,
      role: deletingRole,
      senderId: message.senderId,
      clientMsgId: message.clientMsgId,
      serverSeq: pending ? null : message.seq,
      pending,
    });
  }
  return tombstones;
}
