import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANIFEST_NAME = 'manifest.json';
const DATABASE_NAME = 'quiet-room.sqlite';

function safeId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`INVALID_BACKUP_${label}`);
  return value;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function readCounts(db) {
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  return {
    rooms: count('rooms'),
    members: count('members'),
    messages: count('messages'),
    receipts: count('receipts'),
    blobs: count('blobs'),
    pushSubscriptions: count('push_subscriptions'),
  };
}

function completedBlobs(db) {
  return db.prepare(`SELECT room_id, blob_id, chunk_count, expected_bytes, received_bytes
    FROM blobs WHERE completed = 1 ORDER BY room_id, blob_id`).all();
}

function blobChunks(db, roomId, blobId) {
  return db.prepare(`SELECT chunk_index, byte_length FROM blob_chunks
    WHERE room_id = ? AND blob_id = ? ORDER BY chunk_index`).all(roomId, blobId);
}

function validateBackupLocation(dataDir, backupRoot) {
  const data = path.resolve(dataDir);
  const destination = path.resolve(backupRoot);
  if (destination === data || destination.startsWith(`${data}${path.sep}`)) {
    throw new Error('备份目录不能放在 DATA_DIR 内部');
  }
  return { data, destination };
}

export async function createConsistentBackup({ dataDir, backupRoot, now = new Date() }) {
  const { data, destination } = validateBackupLocation(dataDir, backupRoot);
  const sourceDatabase = path.join(data, DATABASE_NAME);
  if (!(await pathExists(sourceDatabase))) throw new Error('找不到生产数据库');
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const finalDir = path.join(destination, `quiet-room-${stamp}`);
  const stagingDir = path.join(destination, `.quiet-room-${stamp}.partial-${randomUUID()}`);
  if (await pathExists(finalDir)) throw new Error('同名备份已经存在');
  await mkdir(path.join(stagingDir, 'blobs'), { recursive: true, mode: 0o700 });

  const backupDatabase = path.join(stagingDir, DATABASE_NAME);
  const source = new DatabaseSync(sourceDatabase, { readOnly: true, timeout: 10_000 });
  try {
    await sqliteBackup(source, backupDatabase, { rate: 256 });
  } finally {
    source.close();
  }

  const snapshot = new DatabaseSync(backupDatabase, { timeout: 10_000 });
  const blobManifest = [];
  try {
    snapshot.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE; DELETE FROM blobs WHERE completed = 0; COMMIT;');
    snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
    const quickCheck = snapshot.prepare('PRAGMA quick_check').all();
    if (quickCheck.length !== 1 || quickCheck[0].quick_check !== 'ok') throw new Error('备份数据库完整性检查失败');

    for (const blob of completedBlobs(snapshot)) {
      const roomId = safeId(blob.room_id, 'ROOM_ID');
      const blobId = safeId(blob.blob_id, 'BLOB_ID');
      const chunks = blobChunks(snapshot, roomId, blobId);
      if (
        chunks.length !== blob.chunk_count ||
        chunks.reduce((sum, chunk) => sum + Number(chunk.byte_length), 0) !== blob.expected_bytes ||
        blob.expected_bytes !== blob.received_bytes
      ) throw new Error(`附件索引不完整：${blobId}`);

      const sourceBlobDir = path.join(data, 'blobs', roomId, blobId);
      const destinationBlobDir = path.join(stagingDir, 'blobs', roomId, blobId);
      await mkdir(destinationBlobDir, { recursive: true, mode: 0o700 });
      const copiedChunks = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (chunk.chunk_index !== index) throw new Error(`附件分块序号不连续：${blobId}`);
        const fileName = `${String(index).padStart(8, '0')}.bin`;
        const sourceChunk = path.join(sourceBlobDir, fileName);
        const destinationChunk = path.join(destinationBlobDir, fileName);
        const info = await stat(sourceChunk);
        if (!info.isFile() || info.size !== chunk.byte_length) throw new Error(`附件分块大小不一致：${blobId}/${index}`);
        await cp(sourceChunk, destinationChunk, { errorOnExist: true, force: false });
        copiedChunks.push({
          index,
          bytes: info.size,
          sha256: await sha256File(destinationChunk),
        });
      }
      blobManifest.push({
        roomId,
        blobId,
        expectedBytes: Number(blob.expected_bytes),
        chunks: copiedChunks,
      });
    }

    const manifest = {
      format: 'quiet-room-server-backup',
      version: 1,
      createdAt: now.toISOString(),
      database: {
        file: DATABASE_NAME,
        bytes: (await stat(backupDatabase)).size,
        sha256: await sha256File(backupDatabase),
        quickCheck: 'ok',
        counts: readCounts(snapshot),
      },
      blobs: blobManifest,
    };
    await writeFile(path.join(stagingDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    snapshot.close();
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  snapshot.close();

  await rename(stagingDir, finalDir);
  return verifyBackup(finalDir);
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || value.format !== 'quiet-room-server-backup' || value.version !== 1) {
    throw new Error('备份清单格式不正确');
  }
  if (!value.database || value.database.file !== DATABASE_NAME || !Array.isArray(value.blobs)) {
    throw new Error('备份清单缺少数据库或附件信息');
  }
  return value;
}

export async function verifyBackup(backupDir) {
  const root = path.resolve(backupDir);
  const manifest = validateManifest(JSON.parse(await readFile(path.join(root, MANIFEST_NAME), 'utf8')));
  const databasePath = path.join(root, DATABASE_NAME);
  const databaseInfo = await stat(databasePath);
  if (!databaseInfo.isFile() || databaseInfo.size !== manifest.database.bytes) throw new Error('备份数据库大小校验失败');
  if (await sha256File(databasePath) !== manifest.database.sha256) throw new Error('备份数据库摘要校验失败');

  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 10_000 });
  try {
    const quickCheck = db.prepare('PRAGMA quick_check').all();
    if (quickCheck.length !== 1 || quickCheck[0].quick_check !== 'ok') throw new Error('备份数据库完整性检查失败');
    if (JSON.stringify(readCounts(db)) !== JSON.stringify(manifest.database.counts)) {
      throw new Error('备份数据库计数与清单不一致');
    }

    const rows = completedBlobs(db);
    if (rows.length !== manifest.blobs.length) throw new Error('备份附件数量与数据库不一致');
    for (let blobIndex = 0; blobIndex < rows.length; blobIndex += 1) {
      const row = rows[blobIndex];
      const item = manifest.blobs[blobIndex];
      const roomId = safeId(row.room_id, 'ROOM_ID');
      const blobId = safeId(row.blob_id, 'BLOB_ID');
      if (item.roomId !== roomId || item.blobId !== blobId || item.expectedBytes !== row.expected_bytes) {
        throw new Error('备份附件清单顺序或标识不一致');
      }
      const chunks = blobChunks(db, roomId, blobId);
      if (chunks.length !== item.chunks.length) throw new Error(`备份附件分块数不一致：${blobId}`);
      for (let index = 0; index < chunks.length; index += 1) {
        const expected = item.chunks[index];
        const chunkPath = path.join(root, 'blobs', roomId, blobId, `${String(index).padStart(8, '0')}.bin`);
        const info = await stat(chunkPath);
        if (
          expected.index !== index ||
          expected.bytes !== chunks[index].byte_length ||
          info.size !== expected.bytes ||
          await sha256File(chunkPath) !== expected.sha256
        ) throw new Error(`备份附件摘要校验失败：${blobId}/${index}`);
      }
    }
  } finally {
    db.close();
  }

  return {
    backupDir: root,
    createdAt: manifest.createdAt,
    counts: manifest.database.counts,
    blobBytes: manifest.blobs.reduce((sum, blob) => sum + blob.expectedBytes, 0),
    verified: true,
  };
}

export async function restoreBackup({ backupDir, targetDataDir }) {
  const verification = await verifyBackup(backupDir);
  const source = path.resolve(backupDir);
  const target = path.resolve(targetDataDir);
  if (target === source || target.startsWith(`${source}${path.sep}`)) throw new Error('恢复目录不能位于备份目录内部');
  if (await pathExists(target)) {
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error('恢复目标目录必须不存在或为空');
  }

  const parent = path.dirname(target);
  const staging = path.join(parent, `.${path.basename(target)}.restore-${randomUUID()}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  try {
    await cp(path.join(source, DATABASE_NAME), path.join(staging, DATABASE_NAME), { errorOnExist: true, force: false });
    const sourceBlobs = path.join(source, 'blobs');
    if (await pathExists(sourceBlobs)) await cp(sourceBlobs, path.join(staging, 'blobs'), { recursive: true });
    else await mkdir(path.join(staging, 'blobs'), { mode: 0o700 });
    if (await pathExists(target)) await rm(target, { recursive: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { ...verification, targetDataDir: target };
}
