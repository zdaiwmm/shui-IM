import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer } from '../server/index.mjs';
import { createStore } from '../server/storage.mjs';
import { generateIdentity } from '../src/lib/crypto';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const operation of cleanup.splice(0).reverse()) await operation();
});
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'quiet-room-presence-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function client(port: number, roomId: string, deviceId: string, accessToken: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: any[] = [];
  socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  cleanup.push(() => { socket.terminate(); });
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));
  const next = async (predicate: (frame: any) => boolean) => {
    await vi.waitFor(() => expect(frames.some(predicate)).toBe(true), { timeout: 3000, interval: 10 });
    return frames.splice(frames.findIndex(predicate), 1)[0];
  };
  send({ type: 'auth', roomId, deviceId, accessToken });
  await next(frame => frame.type === 'ready');
  const initial = await next(frame => frame.type === 'presence');
  return { socket, send, next, initial };
}

it('migrates without fabricating old chat times; persists monotonically with bounded writes and cascades deletion', async () => {
  const dataDir = await directory();
  let store = await createStore({ dataDir });
  cleanup.push(() => store.close());
  const identity = await generateIdentity(), token = 'a'.repeat(43);
  const { deviceId } = identity.publicBundle;
  const { roomId } = store.createRoom(identity.publicBundle, token);
  store.authenticatedDevice(roomId, token, deviceId);
  const db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
  cleanup.push(() => db.close());
  db.exec('PRAGMA foreign_keys = ON; DROP TABLE chat_presence;');
  store.close();
  store = await createStore({ dataDir });
  expect(store.chatLastSeen(roomId)).toEqual({ creator: null, joiner: null });
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  store.recordChatPresence(roomId, deviceId);
  clock.mockReturnValue(now + 10_000);
  store.recordChatPresence(roomId, deviceId, 30_000);
  expect(store.chatLastSeen(roomId).creator).toBe(now);
  clock.mockReturnValue(now + 30_000);
  store.recordChatPresence(roomId, deviceId, 30_000);
  expect(store.chatLastSeen(roomId).creator).toBe(now + 30_000);
  clock.mockReturnValue(now - 1);
  store.recordChatPresence(roomId, deviceId);
  expect(store.chatLastSeen(roomId).creator).toBe(now + 30_000);
  store.close();
  store = await createStore({ dataDir });
  expect(store.chatLastSeen(roomId)).toEqual({ creator: now + 30_000, joiner: null });
  expect(db.prepare('SELECT COUNT(*) AS count FROM chat_presence').get()?.count).toBe(1);
  clock.mockReturnValue(now + 60_000);
  for (const status of ['pending', 'revoked']) {
    db.prepare('UPDATE members SET status = ? WHERE room_id = ?').run(status, roomId);
    store.recordChatPresence(roomId, deviceId);
    expect(store.chatLastSeen(roomId).creator).toBe(now + 30_000);
  }
  db.prepare("UPDATE members SET status = 'active' WHERE room_id = ?").run(roomId);
  db.prepare(`INSERT INTO recovery_requests VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(roomId, crypto.randomUUID(), deviceId, crypto.randomUUID(), new Uint8Array(32), '{}',
      new Date(now + 3600_000).toISOString(), new Date(now).toISOString());
  store.recordChatPresence(roomId, deviceId);
  expect(store.chatLastSeen(roomId).creator).toBe(now + 30_000);
  db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
  store.recordChatPresence(roomId, deviceId);
  expect(store.chatLastSeen(roomId)).toEqual({ creator: null, joiner: null });
  expect(db.prepare('SELECT COUNT(*) AS count FROM chat_presence').get()?.count).toBe(0);
});

it('records chat entry, heartbeats and departure across sockets; away authentication never counts as chat', async () => {
  const dataDir = await directory();
  const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true, webSocketHeartbeatMs: 40 });
  cleanup.push(() => server.close());
  const identity = await generateIdentity(), token = 'b'.repeat(43), peerToken = 'c'.repeat(43);
  const peer = await generateIdentity(), deviceId = identity.publicBundle.deviceId;
  const { roomId } = server.store.createRoom(identity.publicBundle, token);
  server.store.joinRoom(roomId, peer.publicBundle, 'synthetic', peerToken);
  const a = await client(server.port, roomId, deviceId, token);
  // Seed a second independently keyed active device; presence still aggregates by role.
  const secondIdentity = await generateIdentity(), secondToken = 'f'.repeat(43);
  const secondRoom = server.store.createRoom(secondIdentity.publicBundle, secondToken);
  const db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
  db.prepare('UPDATE members SET room_id = ? WHERE room_id = ?').run(roomId, secondRoom.roomId);
  db.close();
  const b = await client(server.port, roomId, secondIdentity.publicBundle.deviceId, secondToken);
  const away = await client(server.port, roomId, peer.publicBundle.deviceId, peerToken);
  expect(a.initial.lastSeen).toEqual({ creator: null, joiner: null });
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  a.send({ type: 'presence', view: 'chat' });
  expect((await a.next(f => f.type === 'presence' && f.roles.creator)).lastSeen.creator).toBe(now);
  clock.mockReturnValue(now + 31_000);
  await vi.waitFor(() => expect(server.store.chatLastSeen(roomId).creator).toBe(now + 31_000));
  expect(server.store.chatLastSeen(roomId).joiner).toBeNull();
  away.send({ type: 'presence', view: 'chat', role: 'creator', lastSeen: now });
  await away.next(f => f.type === 'error' && f.code === 'INVALID_PRESENCE');
  expect(server.store.chatLastSeen(roomId).joiner).toBeNull();
  b.send({ type: 'presence', view: 'chat' });
  await b.next(f => f.type === 'presence' && f.lastSeen.creator === now + 31_000);
  clock.mockReturnValue(now + 32_000);
  a.send({ type: 'presence', view: 'away' });
  const stillOnline = await a.next(f => f.type === 'presence' && f.lastSeen.creator === now + 32_000);
  expect(stillOnline.roles.creator).toBe(true);
  clock.mockReturnValue(now + 33_000);
  b.socket.close();
  const left = await a.next(f => f.type === 'presence' && !f.roles.creator);
  expect(left.lastSeen.creator).toBe(now + 33_000);
  clock.mockReturnValue(now + 90_000);
  a.send({ type: 'ping' });
  await a.next(f => f.type === 'pong');
  expect(server.store.chatLastSeen(roomId)).toEqual({ creator: now + 33_000, joiner: null });
  // Another room and a fresh reconnect cannot inherit or erase this room's observation.
  const other = server.store.createRoom((await generateIdentity()).publicBundle, 'd'.repeat(43));
  expect(server.store.chatLastSeen(other.roomId)).toEqual({ creator: null, joiner: null });
  const reconnect = await client(server.port, roomId, deviceId, token);
  expect(reconnect.initial).toMatchObject({ roles: { creator: false, joiner: false }, lastSeen: left.lastSeen });
});

it('retains an online observation across an abrupt server crash without restoring online state', async () => {
  const dataDir = await directory();
  const store = await createStore({ dataDir });
  const identity = await generateIdentity(), token = 'e'.repeat(43), deviceId = identity.publicBundle.deviceId;
  const { roomId } = store.createRoom(identity.publicBundle, token);
  store.close();
  const source = `import { startServer } from './server/index.mjs';
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: process.argv[1], quiet: true });
    process.send({ port: server.port });`;
  const processes: ChildProcess[] = [];
  cleanup.push(async () => {
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    }
  });
  const launch = async () => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source, dataDir],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    processes.push(child);
    const [message] = await once(child, 'message');
    return { child, port: (message as { port: number }).port };
  };
  const first = await launch();
  const a = await client(first.port, roomId, deviceId, token);
  a.send({ type: 'presence', view: 'chat' });
  const online = await a.next(f => f.type === 'presence' && f.roles.creator);
  expect(online.lastSeen.creator).toBeGreaterThan(0);
  const exited = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await exited;
  const second = await launch();
  const b = await client(second.port, roomId, deviceId, token);
  expect(b.initial).toMatchObject({ roles: { creator: false, joiner: false }, lastSeen: online.lastSeen });
  b.send({ type: 'presence', view: 'chat' });
  expect((await b.next(f => f.type === 'presence' && f.roles.creator)).lastSeen.creator).toBeGreaterThanOrEqual(online.lastSeen.creator);
}, 15_000);
