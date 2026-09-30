import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { exportConsistentBackup, verifyBackup } from './backup.mjs';
import { checkBackupCapacity } from '../scripts/backup-capacity.mjs';

const MAX_FILE = 256 * 1024 ** 2;
const MAX_TOTAL = 12 * 1024 ** 3;
const MAX_FILES = 100_000;
const MAX_HEADER = 4096;
const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SAFE_PATH = new RegExp(`^(quiet-room\\.sqlite|manifest\\.json|blobs/${ID}/${ID}/[0-9]{8}\\.bin)$`);

export async function writeBytes(output, bytes) {
  await new Promise((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()));
}
export async function writeHeader(output, header) {
  const bytes = Buffer.from(JSON.stringify(header));
  if (bytes.length > MAX_HEADER) throw Error('BACKUP_HEADER_LIMIT');
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  await writeBytes(output, size); await writeBytes(output, bytes);
}

// A single iterator retains at most the stream high-water mark, never a full file.
export function binaryReader(input) {
  const iterator = input[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function take(max) {
    if (!pending.length) {
      const result = await iterator.next();
      if (result.done) throw Error('BACKUP_TRUNCATED');
      pending = Buffer.from(result.value);
    }
    const bytes = pending.subarray(0, max); pending = pending.subarray(bytes.length);
    return bytes;
  }
  async function exact(size) {
    const parts = []; let left = size;
    while (left) { const bytes = await take(left); parts.push(bytes); left -= bytes.length; }
    return Buffer.concat(parts, size);
  }
  return { take, async header() {
    const length = (await exact(4)).readUInt32BE();
    if (length < 2 || length > MAX_HEADER) throw Error('BACKUP_HEADER_LIMIT');
    return JSON.parse((await exact(length)).toString('utf8'));
  } };
}

export async function sendBackup({ dataDir, temporaryRoot, output, input }) {
  const session = randomUUID();
  await writeHeader(output, { type: 'start', version: 1, session });
  let manifestDigest;
  const result = await exportConsistentBackup({ dataDir, backupRoot: temporaryRoot,
    exportFile: async (name, source) => {
      const info = await lstat(source);
      if (!SAFE_PATH.test(name) || !info.isFile() || info.size > MAX_FILE || await realpath(source) !== source) throw Error('BACKUP_SOURCE_INVALID');
      await writeHeader(output, { type: 'file', name, bytes: info.size });
      const hash = createHash('sha256'); let sent = 0;
      for await (const bytes of createReadStream(source)) {
        sent += bytes.length;
        if (sent > info.size) throw Error('BACKUP_SOURCE_CHANGED');
        hash.update(bytes); await writeBytes(output, bytes);
      }
      if (sent !== info.size) throw Error('BACKUP_SOURCE_CHANGED');
      const sha256 = hash.digest('hex');
      await writeHeader(output, { type: 'hash', sha256 });
      if (name === 'manifest.json') manifestDigest = sha256;
    } });
  await writeHeader(output, { type: 'end', session, createdAt: result.createdAt, manifestDigest });
  const ack = await binaryReader(input).header();
  if (ack.type !== 'verified' || ack.session !== session || ack.manifestDigest !== manifestDigest) throw Error('BACKUP_RECEIPT_INVALID');
  return { snapshotCreatedAt: result.createdAt, lastVerifiedAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(), lastAttemptSucceeded: true, destination: 'mac-pull' };
}

export async function receiveBackup({ root, input, output, maxTotal = MAX_TOTAL, maxFiles = MAX_FILES }) {
  if (!Number.isSafeInteger(maxTotal) || maxTotal < 1 || maxTotal > MAX_TOTAL || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES) throw Error('BACKUP_LIMIT_CONFIGURATION_INVALID');
  const absolute = path.resolve(root);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  if (await realpath(absolute) !== absolute || (await lstat(absolute)).mode & 0o077) throw Error('BACKUP_DESTINATION_NOT_PRIVATE');
  await checkBackupCapacity(absolute);
  const reader = binaryReader(input);
  const start = await reader.header();
  if (start.type !== 'start' || start.version !== 1 || !/^[0-9a-f-]{36}$/.test(start.session)) throw Error('BACKUP_PROTOCOL_INVALID');
  const staging = path.join(absolute, `.mac-${randomUUID()}.partial`);
  await mkdir(staging, { mode: 0o700 });
  let published = false, manifestDigest, total = 0;
  const names = new Set();
  try {
    for (;;) {
      const header = await reader.header();
      if (header.type === 'end') {
        if (header.session !== start.session || header.manifestDigest !== manifestDigest || !names.has('quiet-room.sqlite')) throw Error('BACKUP_PROTOCOL_INVALID');
        const created = Date.parse(header.createdAt);
        if (!Number.isFinite(created) || created > Date.now() || Date.now() - created > 60 * 60 * 1000) throw Error('BACKUP_TIMESTAMP_INVALID');
        const verified = await verifyBackup(staging); // Independent disk reread, SQLite and every referenced chunk.
        if (verified.createdAt !== header.createdAt) throw Error('BACKUP_TIMESTAMP_INVALID');
        await checkBackupCapacity(absolute);
        const final = path.join(absolute, `quiet-room-${header.createdAt.replace(/[:.]/g, '-')}`);
        if (await lstat(final).catch(() => null)) throw Error('BACKUP_ALREADY_EXISTS');
        await rename(staging, final); published = true;
        const receipt = await open(path.join(final, '.mac-receipt.json'), 'wx', 0o600);
        try { await receipt.writeFile(JSON.stringify({ version: 1, createdAt: header.createdAt, verifiedAt: new Date().toISOString(), manifestDigest, bytes: total }) + '\n'); await receipt.sync(); }
        finally { await receipt.close(); }
        const directory = await open(absolute, 'r'); try { await directory.sync(); } finally { await directory.close(); }
        await writeHeader(output, { type: 'verified', session: start.session, manifestDigest });
        return { backupDir: final, verified: true, createdAt: header.createdAt, bytes: total };
      }
      if (header.type !== 'file' || !SAFE_PATH.test(header.name) || names.has(header.name) || manifestDigest || names.size >= maxFiles ||
          !Number.isSafeInteger(header.bytes) || header.bytes < 0 || header.bytes > MAX_FILE ||
          (header.name === 'manifest.json' && header.bytes > 8 * 1024 ** 2) || total + header.bytes > maxTotal) throw Error('BACKUP_FILE_LIMIT_OR_PATH');
      names.add(header.name); total += header.bytes;
      const target = path.join(staging, header.name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const file = await open(target, 'wx', 0o600);
      const hash = createHash('sha256'); let left = header.bytes;
      try {
        while (left) { const bytes = await reader.take(left); hash.update(bytes); await file.writeFile(bytes); left -= bytes.length; }
        await file.sync();
      } finally { await file.close(); }
      const expected = await reader.header();
      const actual = hash.digest('hex');
      if (expected.type !== 'hash' || expected.sha256 !== actual) throw Error('BACKUP_TRANSFER_HASH_MISMATCH');
      if (header.name === 'manifest.json') manifestDigest = actual;
    }
  } finally { if (!published) await rm(staging, { recursive: true, force: true }); }
}
