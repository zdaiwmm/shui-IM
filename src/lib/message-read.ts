import type { DecryptedMessage, RoomMember } from './types';
import { isChatMedia } from './media-read';

export function isReadableChatMessage(message: DecryptedMessage): boolean {
  return ['text', 'image', 'image-album', 'audio', 'file'].includes(message.payload.kind);
}

function confirmed(message: DecryptedMessage): boolean {
  return message.status !== 'pending' && message.status !== 'failed'
    && Number.isSafeInteger(message.seq) && message.seq > 0 && message.seq < Number.MAX_SAFE_INTEGER;
}

/** Read means an opposite-role client displayed this exact locally known message. */
export function readMessageIds(
  messages: readonly DecryptedMessage[],
  roles: ReadonlyMap<string, RoomMember['role']>,
): Set<string> {
  const targets = new Map<number, DecryptedMessage>();
  const ambiguous = new Set<number>();
  for (const message of messages) {
    if (!confirmed(message) || !isReadableChatMessage(message)) continue;
    const previous = targets.get(message.seq);
    if (previous && (previous.clientMsgId !== message.clientMsgId || previous.senderId !== message.senderId)) ambiguous.add(message.seq);
    targets.set(message.seq, message);
  }
  const read = new Set<string>();
  for (const event of messages) {
    if (!confirmed(event) || (event.payload.kind !== 'message-read' && event.payload.kind !== 'media-read')) continue;
    const { target } = event.payload;
    const original = targets.get(target.serverSeq);
    const readerRole = roles.get(event.senderId);
    const authorRole = roles.get(target.senderId);
    if (!original || ambiguous.has(target.serverSeq) || !readerRole || !authorRole || readerRole === authorRole
      || original.clientMsgId !== target.clientMsgId || original.senderId !== target.senderId || event.seq <= original.seq) continue;
    // Media needs the existing reveal-and-load receipt, never just a visible bubble.
    if ((event.payload.kind === 'media-read') !== isChatMedia(original)) continue;
    read.add(original.clientMsgId);
  }
  return read;
}
