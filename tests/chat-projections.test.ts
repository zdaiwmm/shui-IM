import { describe, expect, it } from 'vitest';
import { ChatProjections } from '../src/lib/chat-projections';
import { readMessageIds } from '../src/lib/message-read';
import { reduceMessageDeletions } from '../src/lib/message-deletions';
import { reduceMessageReactions } from '../src/lib/reactions';
import type { DecryptedMessage, RoomMember } from '../src/lib/types';

const roles = new Map<string, RoomMember['role']>([['own', 'creator'], ['linked', 'creator'], ['peer', 'joiner']]);
const sentAt = '2026-11-07T00:00:00Z';
const content = (seq: number): DecryptedMessage => ({ seq, clientMsgId: `text-${seq}`, senderId: 'own', status: 'stored', acceptedAt: sentAt,
  payload: { v: 1, kind: 'text', text: `text ${seq}`, sentAt } });
const event = (source: DecryptedMessage, seq: number, kind: 'reaction' | 'message-delete' | 'message-read'): DecryptedMessage => ({
  seq, clientMsgId: `event-${seq}`, senderId: kind === 'message-delete' ? 'linked' : 'peer', status: 'stored', acceptedAt: sentAt,
  payload: { v: 1, kind, sentAt, target: { clientMsgId: source.clientMsgId, senderId: source.senderId, serverSeq: source.seq }, ...(kind === 'reaction' ? { emoji: '❤️' as const } : {}) },
});

describe('incremental chat projections', () => {
  it('matches the original reducers throughout arrivals, edits, eviction, retries and roster changes', () => {
    const cache = new ChatProjections();
    const messages: DecryptedMessage[] = Array.from({ length: 80 }, (_, i) => content(i + 1));
    const memberRoles = new Map(roles);
    let seed = 73017;
    const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    for (let step = 0; step < 300; step++) {
      const target = messages[random(80)]!;
      if (step % 7 === 0 && messages.length > 80) messages.splice(80 + random(messages.length - 80), 1);
      else if (step % 9 === 0 && messages.length > 80) messages[80 + random(messages.length - 80)]!.status = step % 2 ? 'pending' : 'failed';
      else messages.push(event(target, step + 100, (['reaction', 'message-delete', 'message-read'] as const)[random(3)]!));
      if (step === 70) memberRoles.delete('linked');
      if (step === 120) memberRoles.set('linked', 'creator');
      const projected = cache.update(messages, memberRoles);
      expect(projected.read).toEqual(readMessageIds(messages, memberRoles));
      expect(projected.deleted).toEqual(reduceMessageDeletions(messages, memberRoles));
      expect(projected.reactions).toEqual(reduceMessageReactions(messages, memberRoles));
      expect(cache.update(messages, memberRoles)).toBe(projected);
    }
    expect(cache.update([], roles)).toEqual({ read: new Set(), deleted: new Map(), reactions: new Map() });
  });

  it('retains fail-closed ambiguous targets and cross-target duplicate event semantics', () => {
    const cache = new ChatProjections();
    const a = content(1), b = content(2);
    const first = event(a, 10, 'message-delete');
    const duplicate = { ...event(b, 11, 'message-delete'), clientMsgId: first.clientMsgId };
    for (const messages of [[a, b, first], [a, b, first, duplicate], [a, b, duplicate],
      [a, { ...b, seq: 1 }, first], [a, b, first]]) {
      expect(cache.update(messages, roles).deleted).toEqual(reduceMessageDeletions(messages, roles));
    }
  });

  it('keeps optimistic ACKs, then removes failed projections without mutating earlier snapshots', () => {
    const cache = new ChatProjections();
    const target = content(1), pending = { ...event(target, Number.MAX_SAFE_INTEGER, 'reaction'), status: 'pending' as DecryptedMessage['status'] };
    const original = cache.update([target, pending], roles, 1);
    expect(original.reactions.get(target.clientMsgId)?.[0]?.pending).toBe(true);
    pending.status = 'stored';
    expect(cache.update([target, pending], roles, 1).reactions).toEqual(original.reactions);
    pending.status = 'failed';
    expect(cache.update([target, pending], roles, 1).reactions.size).toBe(0);
    expect(original.reactions.size).toBe(1);
  });
});
