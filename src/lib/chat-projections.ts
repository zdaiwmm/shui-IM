import type { DecryptedMessage, RoomMember } from './types';
import { isReadableChatMessage, readMessageIds } from './message-read';
import { reduceMessageDeletions } from './message-deletions';
import { reduceMessageReactions } from './reactions';

type Entry = { message: DecryptedMessage; read: boolean; bucket: number | null };
type Projection = {
  read: ReturnType<typeof readMessageIds>;
  deleted: ReturnType<typeof reduceMessageDeletions>;
  reactions: ReturnType<typeof reduceMessageReactions>;
};
const empty = (): Projection => ({ read: new Set(), deleted: new Map(), reactions: new Map() });

function bucket(message: DecryptedMessage): number | null {
  switch (message.payload.kind) {
    case 'reaction': case 'message-delete': case 'message-read': case 'media-read':
      return message.payload.target.serverSeq;
    default: return isReadableChatMessage(message) ? message.seq : null;
  }
}

/** Runtime-only projection index. Payloads are immutable; delivery state is not.
 * Check the small message envelope on each pass, then fold only changed target
 * groups through the existing authorization reducers. Neither history nor any
 * authenticated state is rewritten. Clearing the runtime drops every reference.
 */
export class ChatProjections {
  private entries: Entry[] = [];
  private groups = new Map<number, Map<number, Entry>>();
  private results = new Map<number, Projection>();
  private roles = '';
  private projection = empty();
  private fallback = false;

  update(messages: readonly DecryptedMessage[], roles: ReadonlyMap<string, RoomMember['role']>, readCount = messages.length): Projection {
    const dirty = new Set<number>();
    const roleKey = JSON.stringify([...roles]);
    const roleChanged = this.roles !== roleKey;
    this.roles = roleKey;
    let changed = roleChanged;
    for (let index = 0; index < Math.max(messages.length, this.entries.length); index++) {
      const message = messages[index], previous = this.entries[index];
      const read = index < readCount;
      if (message && previous && previous.read === read && previous.message.payload === message.payload
        && previous.message.status === message.status && previous.message.seq === message.seq
        && previous.message.clientMsgId === message.clientMsgId && previous.message.senderId === message.senderId
        && previous.message.acceptedAt === message.acceptedAt) continue;
      changed = true;
      if (previous?.bucket !== null && previous?.bucket !== undefined) {
        const group = this.groups.get(previous.bucket)!;
        group.delete(index); dirty.add(previous.bucket);
        if (!group.size) this.groups.delete(previous.bucket);
      }
      if (!message) continue;
      // Copy mutable metadata so in-place ACK/retry updates cannot invalidate
      // the comparison silently. The immutable payload stays shared.
      const entry: Entry = { message: { ...message }, read, bucket: bucket(message) };
      this.entries[index] = entry;
      if (entry.bucket !== null) {
        let group = this.groups.get(entry.bucket);
        if (!group) this.groups.set(entry.bucket, group = new Map());
        group.set(index, entry); dirty.add(entry.bucket);
      }
    }
    this.entries.length = messages.length;
    if (!changed) return this.projection;

    // The original reducers deduplicate event IDs across their entire input.
    // An inconsistent ID reused for different targets must retain that exact
    // behavior, rather than become two independent optimistic operations.
    const eventTargets = new Map<string, number>();
    let collision = false;
    for (const entry of this.entries) {
      if (entry.bucket === null) continue;
      const prior = eventTargets.get(entry.message.clientMsgId);
      if (prior !== undefined && prior !== entry.bucket) collision = true;
      eventTargets.set(entry.message.clientMsgId, entry.bucket);
    }
    if (collision) {
      this.fallback = true;
      return this.projection = {
        read: readMessageIds(messages.slice(0, readCount), roles),
        deleted: reduceMessageDeletions(messages, roles),
        reactions: reduceMessageReactions(messages, roles),
      };
    }
    if (roleChanged || this.fallback) {
      for (const key of this.groups.keys()) dirty.add(key);
      for (const key of this.results.keys()) dirty.add(key);
    }
    const next = this.fallback ? empty() : {
      read: new Set(this.projection.read), deleted: new Map(this.projection.deleted), reactions: new Map(this.projection.reactions),
    };
    this.fallback = false;
    for (const key of dirty) {
      const old = this.results.get(key);
      if (old) {
        for (const id of old.read) next.read.delete(id);
        for (const id of old.deleted.keys()) next.deleted.delete(id);
        for (const id of old.reactions.keys()) next.reactions.delete(id);
      }
      const entries = [...(this.groups.get(key) ?? [])].sort(([a], [b]) => a - b).map(([, entry]) => entry);
      if (!entries.some(entry => !isReadableChatMessage(entry.message))) { this.results.delete(key); continue; }
      const values = entries.map(entry => entry.message);
      const result = {
        read: readMessageIds(entries.filter(entry => entry.read).map(entry => entry.message), roles),
        deleted: reduceMessageDeletions(values, roles), reactions: reduceMessageReactions(values, roles),
      };
      this.results.set(key, result);
      for (const id of result.read) next.read.add(id);
      for (const [id, value] of result.deleted) next.deleted.set(id, value);
      for (const [id, value] of result.reactions) next.reactions.set(id, value);
    }
    return this.projection = next;
  }
}
