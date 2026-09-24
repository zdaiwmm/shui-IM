import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStore } from '../server/storage.mjs';
import { generateIdentity } from '../src/lib/crypto';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, prepareMlsWindowUpdate, processMlsMembership, encryptMlsApplication, decryptMlsApplication, signEcdsa } from '../src/lib/mls';
import { maySkipWindowMessage, isWindowMessage } from '../src/lib/message-window';
import { validateMlsMembershipShape, validateEnvelopeShape } from '../server/protocol.mjs';
import type { Vault, MessagePayload, MlsMembershipEnvelope } from '../src/lib/types';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });
async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'qr-window-'));
  const store = await createStore({ dataDir, ...options });
  cleanups.push(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const [ai, bi] = await Promise.all([generateIdentity(), generateIdentity()]);
  const caps = ['message-window-v1'];
  const { roomId } = store.createRoom(ai.publicBundle, 'a'.repeat(43), 'i'.repeat(43), 'a', caps);
  store.joinRoom(roomId, bi.publicBundle, 'proof', 'b'.repeat(43), 'b', caps);
  const members = store.roomState(roomId).members;
  const base = { v: 3 as const, roomId, accessToken: 'a'.repeat(43), pairingSecret: '', creatorFingerprint: 'fixture', members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const };
  const a: Vault = { ...base, role: 'creator', identity: ai, mls: await createCreatorMlsState(roomId, ai, members) };
  a.mls = await prepareCreatorWelcome(a);
  const b: Vault = { ...base, role: 'joiner', identity: bi, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
  b.mls = await joinMlsGroup(b, a.mls.pendingWelcome!); store.saveMlsWelcome(roomId, a.mls.pendingWelcome); a.mls.pendingWelcome = undefined;
  const commit = async (receiver = true) => {
    const result = await prepareMlsWindowUpdate(a);
    expect(validateMlsMembershipShape(result.event, roomId)).toBe(true);
    const accepted = store.saveMlsEvent(roomId, result.event);
    if (receiver) {
      b.mls!.groupState = await processMlsMembership(b, result.event, accepted.eventSeq);
      b.mls!.lastEventSeq = accepted.eventSeq;
      b.mls!.window = { fromSeq: result.event.retention!.afterSeq + 1, controls: [], generated: 0 };
    }
    a.mls!.groupState = result.nextGroupState; a.mls!.lastEventSeq = accepted.eventSeq;
    a.mls!.window = { fromSeq: a.lastSeq + 1, controls: [], generated: 0 };
    return result.event;
  };
  const send = async (payload: MessagePayload = { v: 1, kind: 'text', text: 'sample', sentAt: new Date().toISOString() }) => {
    const result = await encryptMlsApplication(a, payload, crypto.randomUUID());
    expect(validateEnvelopeShape(result.envelope, roomId)).toBe(true);
    a.mls!.groupState = result.nextGroupState; a.mls!.sendSequence = result.envelope.retention!.sendSequence;
    if (a.mls!.window) a.mls!.window.generated++;
    const message = store.insertMessage(roomId, result.envelope);
    a.lastSeq = message.seq;
    if (a.mls!.window && !isWindowMessage(payload)) a.mls!.window.controls.push(message.seq);
    return message;
  };
  return { a, b, store, commit, send, roomId, dataDir };
}
it('continues accepting ciphertext at the cap, preserves originals and recognizes an expired retry', async () => {
  const f = await fixture({ maxMessagesPerRoom: 3 }); await f.commit();
  const old = await f.send(); await f.send(); await f.send(); await f.commit(false);
  const blobId = crypto.randomUUID(); f.store.createBlob(f.roomId, blobId, 1, 32, f.a.identity.publicBundle.deviceId);
  await f.store.putBlobChunk(f.roomId, blobId, 0, new Uint8Array(32), f.a.identity.publicBundle.deviceId);
  await f.store.completeBlob(f.roomId, blobId, f.a.identity.publicBundle.deviceId);
  const newest = await f.send(); expect(newest.seq).toBe(4);
  expect(f.store.messagesAfter(f.roomId, 0).map(m => m.seq)).toEqual([2, 3, 4]);
  expect(() => f.store.insertMessage(f.roomId, old.envelope)).toThrow('MESSAGE_RETRY_EXPIRED');
  expect(f.store.insertMessage(f.roomId, newest.envelope).duplicate).toBe(true);
  expect(f.store.blobStatus(f.roomId, blobId).completed).toBe(true);
});
it('authenticates skipped ordinary messages across more epochs than retained application keys', async () => {
  const f = await fixture({ maxMessagesPerRoom: 3 }); await f.commit();
  const offline = structuredClone(f.b);
  for (let i = 0; i < 8; i++) { await f.send(); await f.commit(false); }
  const kept = new Map(f.store.messagesAfter(f.roomId, 0).map(m => [m.seq, m]));
  for (const event of f.store.roomState(f.roomId).mlsEvents.filter(e => e.eventSeq > offline.mls!.lastEventSeq!)) {
    const boundary = event.event.retention!;
    for (let seq = offline.lastSeq + 1; seq <= boundary.afterSeq; seq++) {
      const message = kept.get(seq);
      if (message) offline.mls!.groupState = (await decryptMlsApplication(offline, message.envelope)).nextGroupState;
      else expect(maySkipWindowMessage(boundary, seq)).toBe(true);
      offline.lastSeq = seq;
    }
    offline.mls!.groupState = await processMlsMembership(offline, event.event, event.eventSeq);
    offline.mls!.lastEventSeq = event.eventSeq;
  }
  const latest = await f.send();
  expect((await decryptMlsApplication(offline, latest.envelope)).payload).toMatchObject({ text: 'sample' });
});
it('never signs a false control boundary or skips a lost deletion; ordinary data is evicted first', async () => {
  const f = await fixture({ maxMessagesPerRoom: 2 }); await f.commit();
  const first = await f.send();
  const control = await f.send({ v: 1, kind: 'message-delete', sentAt: new Date().toISOString(), target: { clientMsgId: first.envelope.clientMsgId, serverSeq: first.seq, senderId: first.envelope.senderId } });
  const pending = await prepareMlsWindowUpdate(f.a);
  const forged = { ...pending.event, retention: { ...pending.event.retention!, controls: [] } };
  expect(() => f.store.saveMlsEvent(f.roomId, forged)).toThrow('INVALID_MLS_EVENT');
  const boundary = (await f.commit(false)).retention!;
  expect(maySkipWindowMessage(boundary, control.seq)).toBe(false);
  await f.send(); expect(f.store.messagesAfter(f.roomId, 0).map(m => m.seq)).toEqual([2, 3]);
  expect(f.store.getMessageByClientId(f.roomId, first.envelope.clientMsgId)).toBeNull();
});
it('keeps activation gated by all devices and rejects stale competing boundaries atomically', async () => {
  const f = await fixture(); f.store.updateMemberCapabilities(f.roomId, f.b.identity.publicBundle.deviceId, []);
  const pending = await prepareMlsWindowUpdate(f.a);
  expect(() => f.store.saveMlsEvent(f.roomId, pending.event)).toThrow('MESSAGE_WINDOW_UPGRADE_REQUIRED');
  f.store.updateMemberCapabilities(f.roomId, f.b.identity.publicBundle.deviceId, ['message-window-v1']);
  await f.commit();
  expect(() => f.store.saveMlsEvent(f.roomId, pending.event)).toThrow('MLS_EVENT_STALE');
  expect(() => f.store.updateMemberCapabilities(f.roomId, f.b.identity.publicBundle.deviceId, [])).toThrow('MESSAGE_WINDOW_UPGRADE_REQUIRED');
  expect(f.store.roomState(f.roomId).nextMlsEventSeq).toBe(1);
});
it('bounds epoch length and update-chain history without accepting missing or tampered commits', async () => {
  const f = await fixture({ maxWindowEvents: 3 }); await f.commit();
  const offline = structuredClone(f.b);
  for (let i = 0; i < 128; i++) await f.send();
  await expect(f.send()).rejects.toThrow('MLS_UPDATE_REQUIRED');
  for (let i = 0; i < 5; i++) { await f.commit(false); await f.send(); }
  const events = f.store.roomState(f.roomId).mlsEvents;
  expect(events.length).toBe(3);
  await expect(processMlsMembership(offline, events[0].event, events[0].eventSeq)).rejects.toThrow('顺序');
  const { signature: _sig, ...unsigned } = events[0].event;
  const changed = { ...unsigned, action: 'remove' } as Omit<MlsMembershipEnvelope, 'signature'>;
  const forged = { ...changed, signature: await signEcdsa(f.a.identity.signingPrivateKey, changed) };
  await expect(processMlsMembership(f.b, forged, 2)).rejects.toThrow();
});

it('bounds membership bytes independently and rolls back an oversized activation', async () => {
  const blocked = await fixture({ maxWindowEventBytes: 1 });
  await expect(blocked.commit()).rejects.toThrow('MESSAGE_QUOTA');
  expect(blocked.store.roomState(blocked.roomId).messageWindow?.enabled).toBe(false);
  expect(blocked.store.roomState(blocked.roomId).mlsEvents).toHaveLength(0);
  const f = await fixture({ maxWindowEventBytes: 6000 });
  await f.commit();
  for (let i = 0; i < 7; i++) { await f.send(); await f.commit(); }
  const events = f.store.roomState(f.roomId).mlsEvents;
  expect(events.length).toBeGreaterThan(0); expect(events.length).toBeLessThan(8);
  expect(events.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row.event)), 0)).toBeLessThanOrEqual(6000);
});
it('rolls back partial eviction and keeps the replay watermark durable across store reopen', async () => {
  const f = await fixture({ maxMessagesPerRoom: 2, maxRoomMessageBytes: 2000 }); await f.commit();
  const first = await f.send(); await f.send(); await f.commit();
  const before = f.store.messagesAfter(f.roomId, 0);
  const huge = await encryptMlsApplication(f.a, { v: 1, kind: 'text', text: 'x'.repeat(5000), sentAt: new Date().toISOString() }, crypto.randomUUID());
  expect(() => f.store.insertMessage(f.roomId, huge.envelope)).toThrow('MESSAGE_QUOTA');
  expect(f.store.messagesAfter(f.roomId, 0)).toEqual(before);
  await f.send();
  const reopened = await createStore({ dataDir: f.dataDir });
  try { expect(() => reopened.insertMessage(f.roomId, first.envelope)).toThrow('MESSAGE_RETRY_EXPIRED'); }
  finally { reopened.close(); }
  const db = new DatabaseSync(path.join(f.dataDir, 'quiet-room.sqlite'), { readOnly: true });
  try {
    const usage = db.prepare('SELECT message_count, message_bytes FROM rooms WHERE room_id = ?').get(f.roomId)!;
    const actual = db.prepare('SELECT COUNT(*) AS count, SUM(LENGTH(CAST(envelope AS BLOB))) AS bytes FROM messages WHERE room_id = ?').get(f.roomId)!;
    expect(usage).toMatchObject({ message_count: actual.count, message_bytes: actual.bytes });
  } finally { db.close(); }
});
