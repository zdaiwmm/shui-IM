import type { DecryptedMessage, RoomMember } from './types';
import { isVideoFile } from './video-media';

export const MEDIA_READ_HIDE_DELAY_MS = 10_000;

export function isChatMedia(message: DecryptedMessage): boolean {
  const payload = message.payload;
  return payload.kind === 'image' || payload.kind === 'image-album'
    || payload.kind === 'file' && isVideoFile(payload.file);
}

/** Only authenticated opposite-role events targeting exact locally known media count. */
export function mediaReadTimes(
  messages: readonly DecryptedMessage[],
  roles: ReadonlyMap<string, RoomMember['role']>,
): Map<string, number> {
  const targets = new Map(messages.filter(message => isChatMedia(message)
    && message.seq > 0 && message.seq < Number.MAX_SAFE_INTEGER
    && message.status !== 'pending' && message.status !== 'failed').map(message => [message.seq, message]));
  const result = new Map<string, number>();
  for (const event of messages) {
    if (event.payload.kind !== 'media-read' || event.status === 'pending' || event.status === 'failed'
      || !Number.isSafeInteger(event.seq) || event.seq >= Number.MAX_SAFE_INTEGER) continue;
    const { target } = event.payload;
    const original = targets.get(target.serverSeq);
    const readerRole = roles.get(event.senderId);
    const senderRole = original && roles.get(original.senderId);
    const time = Date.parse(event.acceptedAt);
    if (!original || original.clientMsgId !== target.clientMsgId || original.senderId !== target.senderId
      || event.seq <= original.seq || !readerRole || !senderRole || readerRole === senderRole || !Number.isFinite(time)) continue;
    result.set(original.clientMsgId, Math.min(result.get(original.clientMsgId) ?? Infinity, time));
  }
  return result;
}
