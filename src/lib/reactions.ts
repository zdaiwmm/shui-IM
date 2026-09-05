import type { DecryptedMessage, ReactionEmoji, ReactionPayload, RoomMember } from './types';

export const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '‼️', '❓'] as const satisfies readonly ReactionEmoji[];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && (REACTION_EMOJIS as readonly string[]).includes(value);
}

export type MessageReaction = {
  role: RoomMember['role'];
  senderId: string;
  emoji: ReactionEmoji;
  /** The reaction event ID, not the target message ID. */
  clientMsgId: string;
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

/**
 * Projects encrypted reaction events into badges keyed by target clientMsgId.
 * Confirmed events use server order; optimistic local events follow them. A
 * confirmed copy supersedes its optimistic duplicate before events are folded.
 * The target must be a loaded, confirmed chat message with all three IDs equal.
 */
export function reduceMessageReactions(
  messages: readonly DecryptedMessage[],
  memberRoles: ReadonlyMap<string, RoomMember['role']>,
): Map<string, MessageReaction[]> {
  const targets = new Map<number, DecryptedMessage>();
  const events = new Map<string, { message: DecryptedMessage & { payload: ReactionPayload }; index: number }>();
  messages.forEach((message, index) => {
    if (message.payload.kind !== 'reaction') {
      if (isConfirmedChatContent(message)) targets.set(message.seq, message);
      return;
    }
    // ACK precedes sync: `stored` with the sentinel sequence is still the
    // current optimistic event, not a reason to roll the badge back.
    if (message.status === 'failed' || (!isConfirmed(message) && !isOptimisticProjection(message))) return;
    const previous = events.get(message.clientMsgId);
    if (!previous || !isConfirmed(previous.message)) {
      events.set(message.clientMsgId, { message: message as DecryptedMessage & { payload: ReactionPayload }, index });
    }
  });

  const ordered = [...events.values()].sort((left, right) => {
    const leftConfirmed = isConfirmed(left.message);
    const rightConfirmed = isConfirmed(right.message);
    if (leftConfirmed !== rightConfirmed) return leftConfirmed ? -1 : 1;
    if (leftConfirmed) return left.message.seq - right.message.seq || left.index - right.index;
    return Date.parse(left.message.acceptedAt) - Date.parse(right.message.acceptedAt) || left.index - right.index;
  });
  const byTarget = new Map<string, Map<RoomMember['role'], MessageReaction>>();
  for (const { message } of ordered) {
    const { target, emoji } = message.payload;
    const role = memberRoles.get(message.senderId);
    const targetMessage = targets.get(target.serverSeq);
    if (!role || !targetMessage || targetMessage.clientMsgId !== target.clientMsgId || targetMessage.senderId !== target.senderId) continue;
    // An event cannot react to itself or to a message that did not yet exist.
    if (isConfirmed(message) && message.seq <= target.serverSeq) continue;
    if (emoji !== null && !isReactionEmoji(emoji)) continue;
    let participantReactions = byTarget.get(target.clientMsgId);
    if (!participantReactions) {
      participantReactions = new Map();
      byTarget.set(target.clientMsgId, participantReactions);
    }
    if (emoji === null) participantReactions.delete(role);
    else participantReactions.set(role, {
      role,
      senderId: message.senderId,
      emoji,
      clientMsgId: message.clientMsgId,
      pending: !isConfirmed(message),
    });
  }
  const result = new Map<string, MessageReaction[]>();
  for (const [targetId, participantReactions] of byTarget) {
    // Role order is independent of arrival order and device count.
    const reactions = (['creator', 'joiner'] as const)
      .flatMap((role) => participantReactions.has(role) ? [participantReactions.get(role)!] : []);
    if (reactions.length) result.set(targetId, reactions);
  }
  return result;
}
