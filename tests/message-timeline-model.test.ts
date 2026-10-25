import { describe, expect, it } from 'vitest';
import { orderedChatMessages, privateTimelineItems } from '../src/lib/message-timeline';
import type { DecryptedMessage } from '../src/lib/types';
import type { PrivateArchiveItem } from '../src/lib/room-archive';

const message = (id: string, seq = 1, acceptedAt = '2026-10-25T00:00:00.000Z'): DecryptedMessage => ({
  seq, clientMsgId: id, senderId: 'synthetic-device', acceptedAt, status: 'delivered',
  payload: { v: 1, kind: 'text', text: 'synthetic', sentAt: acceptedAt },
});
const archived = (originRoomId: string, id: string): PrivateArchiveItem => ({
  originRoomId, message: message(id), self: false, sourceScope: 'synthetic-private',
});

describe('chat-only timeline projection', () => {
  it('keeps server sequence order followed by pending timestamp order without mutating sources', () => {
    const confirmed = [message('second', 2), message('first', 1)];
    const pending = [message('late', 0, '2026-10-25T00:01:00.000Z'), message('early', 0)];
    expect(orderedChatMessages(confirmed, pending, [], new Set()).map(x => x.clientMsgId)).toEqual(['first', 'second', 'early', 'late']);
    expect(confirmed.map(x => x.clientMsgId)).toEqual(['second', 'first']);
    expect(pending.map(x => x.clientMsgId)).toEqual(['late', 'early']);
  });
  it('applies current deletion and local hiding to confirmed and pending records on every projection', () => {
    const confirmed = [message('UPPER'), message('deleted'), message('visible')], pending = [message('pending')];
    const deleted = new Map([['deleted', {}], ['pending', {}]]);
    expect(orderedChatMessages(confirmed, pending, ['upper'], deleted).map(x => x.clientMsgId)).toEqual(['visible']);
    deleted.clear();
    expect(orderedChatMessages(confirmed, pending, [], deleted)).toHaveLength(4);
  });
  it.each(['gallery-image', 'gallery-file', 'reaction', 'message-delete', 'media-read', 'message-read'])('excludes %s control/gallery records', kind => {
    const control = { ...message('control'), payload: { v: 1, kind } } as DecryptedMessage;
    expect(orderedChatMessages([control], [control], [], new Set())).toEqual([]);
  });
  it('deduplicates same-room imports only, preserving other-room identities, order and object references', () => {
    const items = [archived('current', 'same'), archived('other', 'same'), archived('current', 'missing')];
    const result = privateTimelineItems(items, [message('same')], 'current');
    expect(result).toEqual([items[1], items[2]]);
    expect(result[0]).toBe(items[1]);
    expect(items).toHaveLength(3);
    expect(privateTimelineItems(items, [], 'current')).toEqual(items);
    expect(privateTimelineItems([], [message('same')], 'current')).toEqual([]);
  });
  it('does not suppress an import when the shared record is hidden or deleted', () => {
    const items = [archived('current', 'hidden')];
    const visible = orderedChatMessages([message('hidden')], [], ['hidden'], new Set());
    expect(privateTimelineItems(items, visible, 'current')).toEqual(items);
  });
});
