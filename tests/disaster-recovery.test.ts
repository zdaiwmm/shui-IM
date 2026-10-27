import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAvailableBackupSpace } from './fixtures/backup-capacity';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createStore } from '../server/storage.mjs';
import { restoreBackup, verifyBackup } from '../server/backup.mjs';
import { runManualBackup } from '../scripts/backup.mjs';
import { startServer } from '../server/index.mjs';
import { generateIdentity, createJoinProof } from '../src/lib/crypto';
import { randomBase64Url } from '../src/lib/base64';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, encryptMlsApplication, decryptMlsApplication } from '../src/lib/mls';
import { encryptFileAttachment, decryptFileAttachment } from '../src/lib/file-crypto';
import type { RoomMember, Vault } from '../src/lib/types';

// Entirely synthetic. Client MLS/file keys stay in this test process, outside
// the server snapshot. This is an isolated restore drill, not production RTO.
beforeEach(() => { useAvailableBackupSpace(); });
afterEach(() => { vi.restoreAllMocks(); });
it('restores a server snapshot, boots health, and decrypts two-party MLS and original attachment bytes', async () => {
  const started = performance.now();
  const root = await mkdtemp(path.join(tmpdir(), 'quiet-room-restore-drill-'));
  const dataDir = path.join(root, 'source');
  const source = await createStore({ dataDir });
  let restored: Awaited<ReturnType<typeof startServer>> | undefined;
  let sourceClosed = false;
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await operation(); } finally { timings[name] = Math.round(performance.now() - start); }
  };
  try {
    const [creatorIdentity, joinerIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
    const token = randomBase64Url(32), secret = randomBase64Url(32);
    const { roomId } = source.createRoom(creatorIdentity.publicBundle, token);
    source.joinRoom(roomId, joinerIdentity.publicBundle, await createJoinProof(secret, joinerIdentity.publicBundle));
    const members: RoomMember[] = [
      { ...creatorIdentity.publicBundle, role: 'creator', joinProof: null },
      { ...joinerIdentity.publicBundle, role: 'joiner', joinProof: 'synthetic-approved' },
    ];
    const common = { v: 2 as const, roomId, accessToken: token, pairingSecret: secret,
      creatorFingerprint: 'synthetic', members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const };
    const creator: Vault = { ...common, role: 'creator', identity: creatorIdentity,
      mls: await createCreatorMlsState(roomId, creatorIdentity, members) };
    creator.mls = await prepareCreatorWelcome(creator);
    const joiner: Vault = { ...common, role: 'joiner', identity: joinerIdentity,
      mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
    joiner.mls = await joinMlsGroup(joiner, creator.mls.pendingWelcome!);
    creator.mls = { ...creator.mls, pendingWelcome: undefined };

    const original = Uint8Array.from({ length: 2 * 1024 ** 2 + 37 }, (_, i) => i % 251);
    const file = await encryptFileAttachment(new File([original], 'synthetic-original.bin', { type: 'application/octet-stream' }), {
      reserve: async (id, count, size) => { source.createBlob(roomId, id, count, size, creatorIdentity.publicBundle.deviceId); },
      status: async () => ({ uploadedIndexes: [], completed: false }),
      upload: async (id, index, bytes) => { await source.putBlobChunk(roomId, id, index, new Uint8Array(bytes), creatorIdentity.publicBundle.deviceId); },
      complete: async id => { await source.completeBlob(roomId, id, creatorIdentity.publicBundle.deviceId); },
      savePlan: async () => {},
    });
    const payload = { v: 1 as const, kind: 'file' as const, file, sentAt: new Date().toISOString() };
    const first = await encryptMlsApplication(creator, payload, crypto.randomUUID());
    creator.mls.groupState = first.nextGroupState;
    source.insertMessage(roomId, first.envelope);
    const replyPayload = { v: 1 as const, kind: 'text' as const, text: 'synthetic restore reply', sentAt: new Date().toISOString() };
    const reply = await encryptMlsApplication(joiner, replyPayload, crypto.randomUUID());
    joiner.mls.groupState = reply.nextGroupState;
    source.insertMessage(roomId, reply.envelope);

    const snapshot = await timed('snapshotMs', () => runManualBackup({ env: { DATA_DIR: dataDir, BACKUP_DIR: path.join(root, 'snapshots') } }));
    expect(snapshot.retention).toEqual({ mode: 'keep-all', days: null });
    await timed('verifyMs', () => verifyBackup(snapshot.backupDir));
    source.close(); sourceClosed = true;
    const target = path.join(root, 'restored');
    await timed('restoreMs', () => restoreBackup({ backupDir: snapshot.backupDir, targetDataDir: target }));
    restored = await timed('bootMs', () => startServer({ dataDir: target, host: '127.0.0.1', port: 0, quiet: true }));
    const server = restored;
    const health = await timed('healthMs', async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(response.status).toBe(200);
      return response.json();
    });
    expect(health).toMatchObject({ ok: true, database: true, storage: true });
    const rows = server.store.messagesAfter(roomId, 0);
    expect(rows).toHaveLength(2);
    await timed('decryptMs', async () => {
      const opened = await decryptMlsApplication(joiner, rows[0].envelope);
      expect(opened.payload).toEqual(payload);
      const openedReply = await decryptMlsApplication(creator, rows[1].envelope);
      expect(openedReply.payload).toEqual(replyPayload);
      const blob = await decryptFileAttachment(file, async (id, index) => {
        const bytes = await server.store.getBlobChunk(roomId, id, index);
        return Uint8Array.from(bytes).buffer;
      });
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original);
    });
    console.info(JSON.stringify({ kind: 'synthetic-restore-drill', timings, totalMs: Math.round(performance.now() - started),
      capacityEvidence: 'controlled-admission-fixture', messages: rows.length, originalBytes: original.length }));
  } finally {
    if (!sourceClosed) source.close();
    await restored?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
