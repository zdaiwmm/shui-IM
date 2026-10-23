import type { OutboxItem } from './types';
/** Generated MLS ciphertext must reach the server in sender sequence order.
 * Unprepared intents follow generated ciphertext and retain their local order. */
export function compareOutboxItems(a: OutboxItem, b: OutboxItem): number {
  const aSeq = a.envelope?.v === 2 ? a.envelope.retention?.sendSequence : undefined;
  const bSeq = b.envelope?.v === 2 ? b.envelope.retention?.sendSequence : undefined;
  if (aSeq !== undefined && bSeq !== undefined) return aSeq - bSeq;
  if (a.envelope && !b.envelope) return -1;
  if (!a.envelope && b.envelope) return 1;
  if (a.intent && b.intent) return a.intent.sequence - b.intent.sequence;
  return a.createdAt.localeCompare(b.createdAt) || a.clientMsgId.localeCompare(b.clientMsgId);
}
