import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../server/storage.mjs';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function bundle(deviceId: string, withMls = true) {
  return {
    deviceId,
    encryptionKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: [], ext: true },
    signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: ['verify'], ext: true },
    ...(withMls ? { mlsKeyPackage: 'A'.repeat(64) } : {}),
  };
}

describe('room protocol pinning', () => {
  it('prevents a non-MLS joiner from permanently downgrading an MLS room', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-protocol-'));
    directories.push(dataDir);
    const store = await createStore({ dataDir });
    const creator = bundle(crypto.randomUUID());
    const room = store.createRoom(creator, 'a'.repeat(43));
    expect(room.protocol).toBe('mls-rfc9420');
    expect(store.roomState(room.roomId).protocol).toBe('mls-rfc9420');
    expect(() => store.joinRoom(room.roomId, bundle(crypto.randomUUID(), false), 'proof')).toThrow('PROTOCOL_MISMATCH');
    expect(store.roomState(room.roomId).members).toHaveLength(1);
    const joined = store.joinRoom(room.roomId, bundle(crypto.randomUUID()), 'proof');
    expect(joined.members).toHaveLength(2);
    store.close();
  });
});
