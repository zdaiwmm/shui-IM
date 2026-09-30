import { mkdtemp, rm, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { sendBackup, receiveBackup, writeHeader } from '../server/backup-transfer.mjs';
import { createStore } from '../server/storage.mjs';
import { spawnSync } from 'node:child_process';
import { restoreBackup, exportConsistentBackup } from '../server/backup.mjs';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
 const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mac-backup-test-'))); roots.push(root);
 const dataDir = path.join(root, 'data'); const temporaryRoot = path.join(root, 'tmp'); const destination = path.join(root, 'mac');
 await mkdir(destination, { mode: 0o700 });
 const store = await createStore({ dataDir });
 const deviceId = crypto.randomUUID();
 const { roomId } = store.createRoom({ deviceId, encryptionKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: [], ext: true }, signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: ['verify'], ext: true } }, 'a'.repeat(43));
 const blobId = crypto.randomUUID(); const bytes = crypto.getRandomValues(new Uint8Array(813));
 store.createBlob(roomId, blobId, 1, bytes.length, deviceId); await store.putBlobChunk(roomId, blobId, 0, bytes, deviceId); await store.completeBlob(roomId, blobId, deviceId);
 return { root, dataDir, temporaryRoot, destination, store, roomId, blobId, bytes };
}
describe('Mac pull backup', () => {
 it('streams a consistent live snapshot, independently verifies and restores complete ciphertext before acknowledging', async () => {
  const f = await fixture(); const data = new PassThrough(); const ack = new PassThrough();
  try {
   const [state, received] = await Promise.all([
    sendBackup({ dataDir: f.dataDir, temporaryRoot: f.temporaryRoot, output: data, input: ack }),
    receiveBackup({ root: f.destination, input: data, output: ack }),
   ]);
   expect(state.lastAttemptSucceeded).toBe(true); expect(received.verified).toBe(true);
   const receipt = JSON.parse(await readFile(path.join(received.backupDir, '.mac-receipt.json'), 'utf8'));
   expect(receipt.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
   const target = path.join(f.root, 'restored');
   await restoreBackup({ backupDir: received.backupDir, targetDataDir: target });
   const restored = await createStore({ dataDir: target });
   try { expect(new Uint8Array(await restored.getBlobChunk(f.roomId, f.blobId, 0))).toEqual(f.bytes); }
   finally { restored.close(); }
  } finally { f.store.close(); data.destroy(); ack.destroy(); }
 });
 it.each(['../escape', '/tmp/escape', 'blobs/../../../escape'])('rejects unsafe path %s without publication', async name => {
  const f = await fixture(); const data = new PassThrough(); const ack = new PassThrough();
  try {
   await writeHeader(data, { type: 'start', version: 1, session: crypto.randomUUID() });
   await writeHeader(data, { type: 'file', name, bytes: 0 }); data.end();
   await expect(receiveBackup({ root: f.destination, input: data, output: ack })).rejects.toThrow('BACKUP_FILE_LIMIT_OR_PATH');
  } finally { f.store.close(); }
 });
 it('rejects transfer corruption and truncated streams without sending success', async () => {
  const f = await fixture();
  try {
   for (const truncated of [false, true]) {
    const data = new PassThrough(); const ack = new PassThrough();
    await writeHeader(data, { type: 'start', version: 1, session: crypto.randomUUID() });
    await writeHeader(data, { type: 'file', name: 'quiet-room.sqlite', bytes: 3 }); data.write('abc');
    if (!truncated) await writeHeader(data, { type: 'hash', sha256: '0'.repeat(64) }); data.end();
    await expect(receiveBackup({ root: f.destination, input: data, output: ack })).rejects.toThrow(truncated ? 'BACKUP_TRUNCATED' : 'BACKUP_TRANSFER_HASH_MISMATCH');
    expect(ack.readableLength).toBe(0);
   }
  } finally { f.store.close(); }
 });
 it.each([268435457, -1, 1.1])('rejects invalid file length %s', async bytes => {
  const f = await fixture(); const data = new PassThrough(); const ack = new PassThrough();
  try {
   await writeHeader(data, { type: 'start', version: 1, session: crypto.randomUUID() });
   await writeHeader(data, { type: 'file', name: 'quiet-room.sqlite', bytes }); data.end();
   await expect(receiveBackup({ root: f.destination, input: data, output: ack })).rejects.toThrow('BACKUP_FILE_LIMIT_OR_PATH');
  } finally { f.store.close(); }
 });
 it('rejects a duplicate file and never acknowledges a stale end timestamp', async () => {
  const f = await fixture();
  try {
   for (const duplicate of [true, false]) {
    const data = new PassThrough(); const ack = new PassThrough(); const session = crypto.randomUUID();
    await writeHeader(data, { type: 'start', version: 1, session });
    await writeHeader(data, { type: 'file', name: 'quiet-room.sqlite', bytes: 0 });
    await writeHeader(data, { type: 'hash', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    await writeHeader(data, duplicate ? { type: 'file', name: 'quiet-room.sqlite', bytes: 0 } : { type: 'end', session, createdAt: '2020-01-01T00:00:00Z' }); data.end();
    await expect(receiveBackup({ root: f.destination, input: data, output: ack })).rejects.toThrow(duplicate ? 'BACKUP_FILE_LIMIT_OR_PATH' : 'BACKUP_TIMESTAMP_INVALID');
    expect(ack.readableLength).toBe(0);
   }
  } finally { f.store.close(); }
 });
 it('enforces total declared bytes and file count before accepting the next file', async () => {
  const f = await fixture();
  try {
   for (const countLimit of [false, true]) {
    const data = new PassThrough(); const ack = new PassThrough();
    await writeHeader(data, { type: 'start', version: 1, session: crypto.randomUUID() });
    await writeHeader(data, { type: 'file', name: 'quiet-room.sqlite', bytes: 0 });
    await writeHeader(data, { type: 'hash', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    await writeHeader(data, { type: 'file', name: 'manifest.json', bytes: 3 }); data.end();
    await expect(receiveBackup({ root: f.destination, input: data, output: ack, maxFiles: countLimit ? 1 : 2, maxTotal: countLimit ? 10 : 2 })).rejects.toThrow('BACKUP_FILE_LIMIT_OR_PATH');
    expect(ack.readableLength).toBe(0);
   }
  } finally { f.store.close(); }
 });
 it('fails closed before exporting a database above its configured cap', async () => {
  const f = await fixture(); let exported = false;
  try {
   await expect(exportConsistentBackup({ dataDir: f.dataDir, backupRoot: f.temporaryRoot, maxDatabaseBytes: 1, exportFile: async () => { exported = true; } })).rejects.toThrow('BACKUP_DATABASE_LIMIT');
   expect(exported).toBe(false);
  } finally { f.store.close(); }
 });
 it('requires a Mac receipt for Mac mode and reports expired snapshots unhealthy', async () => {
  const f = await fixture();
  const state = { lastVerifiedAt: new Date().toISOString(), snapshotCreatedAt: new Date().toISOString(), lastAttemptSucceeded: true };
  const check = () => spawnSync(process.execPath, ['scripts/backup-health.mjs'], { env: { ...process.env, BACKUP_DIR: f.destination, BACKUP_MODE: 'mac-pull' } }).status;
  try {
   await writeFile(path.join(f.destination, '.backup-state.json'), JSON.stringify(state)); expect(check()).toBe(1);
   await writeFile(path.join(f.destination, '.backup-state.json'), JSON.stringify({ ...state, destination: 'mac-pull' })); expect(check()).toBe(0);
   await writeFile(path.join(f.destination, '.backup-state.json'), JSON.stringify({ ...state, destination: 'mac-pull', snapshotCreatedAt: '2020-01-01T00:00:00Z' })); expect(check()).toBe(1);
  } finally { f.store.close(); }
 });
 it('does not trust a wrong session acknowledgement', async () => {
  const f = await fixture(); const data = new PassThrough(); data.resume(); const ack = new PassThrough();
  try {
   await writeHeader(ack, { type: 'verified', session: crypto.randomUUID(), manifestDigest: '0'.repeat(64) });
   await expect(sendBackup({ dataDir: f.dataDir, temporaryRoot: f.temporaryRoot, output: data, input: ack })).rejects.toThrow('BACKUP_RECEIPT_INVALID');
  } finally { f.store.close(); data.destroy(); ack.destroy(); }
 });
});
