import { describe, expect, it } from 'vitest';
import { readMessageIds } from '../src/lib/message-read';
import { isMessagePayload } from '../src/lib/message-payload';
import type { DecryptedMessage, ImageManifest, MessageReadPayload, RoomMember } from '../src/lib/types';
const author = crypto.randomUUID(), peer = crypto.randomUUID(), linked = crypto.randomUUID();
const roles = new Map<string, RoomMember['role']>([[author, 'creator'], [linked, 'creator'], [peer, 'joiner']]);
const time = '2026-09-10T08:00:00.000Z';
const original: DecryptedMessage = { seq: 1, clientMsgId: crypto.randomUUID(), senderId: author,
  payload: { v: 1, kind: 'text', text: 'Synthetic read target', sentAt: time }, acceptedAt: time, status: 'delivered' };
const payload: MessageReadPayload = { v: 1, kind: 'message-read', sentAt: time,
  target: { clientMsgId: original.clientMsgId, serverSeq: 1, senderId: author } };
const receipt: DecryptedMessage = { seq: 2, clientMsgId: crypto.randomUUID(), senderId: peer,
  payload, acceptedAt: time, status: 'stored' };
describe('encrypted read receipts', () => {
  it('accepts only an exact target without extra plaintext metadata', () => {
    expect(isMessagePayload(payload)).toBe(true);
    expect(isMessagePayload({ ...payload, preview: 'leak' })).toBe(false);
    expect(isMessagePayload({ ...payload, target: { ...payload.target, serverSeq: 0 } })).toBe(false);
    expect(isMessagePayload({ ...payload, target: { ...payload.target, text: 'leak' } })).toBe(false);
  });
  it('requires a confirmed opposite-role read, never delivery or a companion device', () => {
    expect(readMessageIds([original], roles).size).toBe(0);
    expect(readMessageIds([original, receipt, receipt], roles).has(original.clientMsgId)).toBe(true);
    for (const invalid of [
      { ...receipt, senderId: linked }, { ...receipt, senderId: crypto.randomUUID() },
      { ...receipt, seq: 1 }, { ...receipt, status: 'pending' as const }, { ...receipt, status: 'failed' as const },
      { ...receipt, payload: { ...payload, target: { ...payload.target, clientMsgId: crypto.randomUUID() } } },
      { ...receipt, payload: { ...payload, target: { ...payload.target, senderId: linked } } },
    ]) expect(readMessageIds([original, invalid], roles).size).toBe(0);
    expect(readMessageIds([receipt], roles).size).toBe(0);
    expect(readMessageIds([original, { ...original, clientMsgId: crypto.randomUUID() }, receipt], roles).size).toBe(0);
  });
  it('requires revealed-media receipts for images and excludes hidden events', () => {
    const image: DecryptedMessage = { ...original, payload: { v: 1, kind: 'image', image: {} as ImageManifest, sentAt: time } };
    expect(readMessageIds([image, receipt], roles).size).toBe(0);
    expect(readMessageIds([image, { ...receipt, payload: { ...payload, kind: 'media-read' } }], roles).has(image.clientMsgId)).toBe(true);
    expect(readMessageIds([{ ...original, payload }, receipt], roles).size).toBe(0);
  });
});
