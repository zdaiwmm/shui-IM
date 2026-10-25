import type { DecryptedMessage } from './types';
import type { PrivateArchiveItem } from './room-archive';

/** A presentation projection only: never feeds shared replies, receipts or outbox. */
export function orderedChatMessages(
  confirmed: Iterable<DecryptedMessage>,
  pending: Iterable<DecryptedMessage>,
  hidden: readonly string[],
  deleted: { has(id: string): boolean },
): DecryptedMessage[] {
  const hiddenIds = new Set(hidden);
  const visible = (message: DecryptedMessage) => message.payload.kind !== 'gallery-image' && message.payload.kind !== 'gallery-file'
    && message.payload.kind !== 'reaction' && message.payload.kind !== 'message-delete' && message.payload.kind !== 'media-read' && message.payload.kind !== 'message-read'
    && !deleted.has(message.clientMsgId) && !hiddenIds.has(message.clientMsgId.toLowerCase());
  return [
    ...[...confirmed].filter(visible).sort((left, right) => left.seq - right.seq),
    ...[...pending].filter(visible).sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt)),
  ];
}

/** Deduplicate only against visible live messages from the same source room.
 * Other-room imports remain private, even when their message IDs happen to match. */
export function privateTimelineItems(
  items: readonly PrivateArchiveItem[],
  messages: readonly DecryptedMessage[],
  roomId: string,
): PrivateArchiveItem[] {
  if (!items.length || !messages.length) return [...items];
  const liveIds = new Set(messages.map(message => message.clientMsgId));
  return items.filter(item => item.originRoomId !== roomId || !liveIds.has(item.message.clientMsgId));
}
