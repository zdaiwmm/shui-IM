import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../server/index.mjs';
import { createStore } from '../server/storage.mjs';
import { randomBase64Url } from '../src/lib/base64';
import { encryptMessage, generateIdentity } from '../src/lib/crypto';
import type { Vault } from '../src/lib/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-unread-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  const db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
  cleanups.push(async () => { db.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const [identity, peerIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
  delete identity.publicBundle.mlsKeyPackage;
  delete peerIdentity.publicBundle.mlsKeyPackage;
  const accessToken = randomBase64Url(32), peerToken = randomBase64Url(32), observerToken = randomBase64Url(32);
  const room = server.store.createRoom(identity.publicBundle, accessToken, randomBase64Url(32));
  const state = server.store.joinRoom(room.roomId, peerIdentity.publicBundle, 'proof', peerToken);
  const vault: Vault = {
    v: 1, roomId: room.roomId, accessToken, role: 'creator', pairingSecret: '', creatorFingerprint: '',
    identity, members: state.members, lastSeq: 0, createdAt: room.createdAt, protocol: 'legacy-v1',
  };
  const peer: Vault = { ...vault, identity: peerIdentity, accessToken: peerToken, role: 'joiner' };
  const base = `http://127.0.0.1:${server.port}/api/rooms/${room.roomId}`;
  const route = `${base}/unread/${identity.publicBundle.deviceId}`;
  const get = (token = observerToken, url = route) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const post = (body: unknown, token = accessToken) => fetch(route, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const envelope = (sender = peer) => encryptMessage(sender, { v: 1, kind: 'text', text: 'private', sentAt: new Date().toISOString() });
  return { server, db, dataDir, vault, peer, base, route, observerToken, get, post, envelope };
}

function nextFrame(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error(`Missing ${type}`)); }, 3000);
    const receive = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== type) return;
      clearTimeout(timer);
      socket.off('message', receive);
      resolve(frame);
    };
    socket.on('message', receive);
  });
}

describe('restricted unread observer', () => {
  it('counts authenticated chat sends once and excludes non-counting transport hints and the same role', async () => {
    const { server, vault, peer, observerToken, post, get, envelope } = await setup();
    expect((await post({ token: observerToken })).status).toBe(200);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.unshift(async () => { socket.terminate(); });
    await new Promise<void>((resolve) => socket.once('open', resolve));
    const ready = nextFrame(socket, 'ready');
    socket.send(JSON.stringify({ type: 'auth', roomId: peer.roomId, deviceId: peer.identity.publicBundle.deviceId, accessToken: peer.accessToken }));
    await ready;
    const chat = await envelope();
    for (const frame of [
      { envelope: chat },
      { envelope: chat, countUnread: false }, // Duplicate retries cannot reclassify an existing message.
      { envelope: await envelope(), countUnread: false }, // Gallery and reaction payloads both use false.
      { envelope: await envelope(), countUnread: false },
    ]) {
      const ack = nextFrame(socket, 'ack');
      socket.send(JSON.stringify({ type: 'send', ...frame }));
      await ack;
    }
    server.store.insertMessage(vault.roomId, await envelope(vault));
    expect(await (await get()).json()).toEqual({ count: 1 });
    const invalid = nextFrame(socket, 'error');
    socket.send(JSON.stringify({ type: 'send', envelope: await envelope(), countUnread: 'false' }));
    expect((await invalid).code).toBe('INVALID_MESSAGE');
    expect(await (await get()).json()).toEqual({ count: 1 });
    expect(await (await post({ readSeq: 999999 })).json()).toEqual({ count: 0 });
    server.store.insertMessage(vault.roomId, await envelope());
    expect(await (await post({ readSeq: 0 })).json()).toEqual({ count: 1 });
  });

  it('stores only a hash, rotates credentials, and confines the count token to read-only count access', async () => {
    const { db, server, vault, peer, base, observerToken, post, get } = await setup();
    expect((await post({ readSeq: 0 })).status).toBe(400);
    expect((await post({ token: 'short' })).status).toBe(400);
    expect((await post({ token: vault.accessToken })).status).toBe(400);
    expect((await post({ token: observerToken, readSeq: -1 })).status).toBe(400);
    expect((await post({ token: observerToken, unknown: true })).status).toBe(400);
    expect((await post({ token: observerToken })).status).toBe(200);
    const row = db.prepare('SELECT token_hash, read_seq FROM unread_observers').get()!;
    expect(Buffer.from(row.token_hash as Uint8Array)).toEqual(createHash('sha256').update(observerToken).digest());
    expect((await get()).headers.get('cache-control')).toBe('no-store');
    expect((await get(vault.accessToken)).status).toBe(401);
    expect((await get(randomBase64Url(32))).status).toBe(401);
    expect((await get(observerToken, base)).status).toBe(401);
    expect((await get(observerToken, `${base}/blobs/${crypto.randomUUID()}`)).status).toBe(401);
    expect((await get(observerToken, `${base}/unread/${peer.identity.publicBundle.deviceId}`)).status).toBe(401);
    expect((await post({ readSeq: 10 }, observerToken)).status).toBe(401);
    expect((await post({ token: observerToken }, peer.accessToken)).status).toBe(401);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.unshift(async () => { socket.terminate(); });
    await new Promise<void>((resolve) => socket.once('open', resolve));
    const rejected = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'auth', roomId: vault.roomId, deviceId: vault.identity.publicBundle.deviceId, accessToken: observerToken }));
    expect(await rejected).toBe(4401);
    const rotated = randomBase64Url(32);
    expect((await post({ token: rotated })).status).toBe(200);
    expect((await get()).status).toBe(401);
    expect(await (await get(rotated)).json()).toEqual({ count: 0 });
  });

  it('honors device join boundaries, same-role companion messages and revocation or recovery fences', async () => {
    const { db, server, vault, peer, observerToken, post, get, envelope } = await setup();
    const first = server.store.insertMessage(vault.roomId, await envelope());
    db.prepare('UPDATE members SET join_seq = ? WHERE device_id = ?').run(first.seq, vault.identity.publicBundle.deviceId);
    expect(await (await post({ token: observerToken, readSeq: 0 })).json()).toEqual({ count: 0 });
    server.store.insertMessage(vault.roomId, await envelope());
    expect(await (await get()).json()).toEqual({ count: 1 });
    // Model a same-participant companion device without involving the unrelated MLS onboarding flow.
    db.prepare("UPDATE members SET role = 'creator' WHERE device_id = ?").run(peer.identity.publicBundle.deviceId);
    expect(await (await get()).json()).toEqual({ count: 0 });
    db.prepare("UPDATE members SET role = 'joiner' WHERE device_id = ?").run(peer.identity.publicBundle.deviceId);
    const requestId = crypto.randomUUID();
    db.prepare(`INSERT INTO recovery_requests(room_id, request_id, source_device_id, replacement_device_id,
      token_hash, request, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?, 'pending', ?)`)
      .run(vault.roomId, requestId, vault.identity.publicBundle.deviceId, crypto.randomUUID(), Buffer.alloc(32),
        new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    expect((await get()).status).toBe(401);
    expect((await post({ readSeq: 2 })).status).toBe(401);
    db.prepare("UPDATE recovery_requests SET status = 'expired' WHERE request_id = ?").run(requestId);
    db.prepare("UPDATE members SET status = 'revoked' WHERE device_id = ?").run(vault.identity.publicBundle.deviceId);
    expect((await get()).status).toBe(401);
    expect((await post({ token: randomBase64Url(32) })).status).toBe(401);
  });

  it('adds countability to existing ciphertext rows without rewriting or losing them', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-unread-migration-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    let store = await createStore({ dataDir });
    const identity = await generateIdentity();
    const room = store.createRoom(identity.publicBundle, randomBase64Url(32));
    const opaqueEnvelope = { clientMsgId: crypto.randomUUID(), senderId: identity.publicBundle.deviceId, ciphertext: 'opaque' };
    store.insertMessage(room.roomId, opaqueEnvelope);
    store.close();
    const db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
    db.exec('ALTER TABLE messages DROP COLUMN count_unread');
    db.close();
    store = await createStore({ dataDir });
    expect(store.messagesAfter(room.roomId, 0)).toMatchObject([{ seq: 1, envelope: opaqueEnvelope }]);
    store.close();
    const migrated = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
    expect(migrated.prepare('SELECT count_unread FROM messages').get()).toMatchObject({ count_unread: 1 });
    migrated.close();
  });
});
