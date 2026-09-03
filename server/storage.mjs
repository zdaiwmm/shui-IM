import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { canonicalStringify } from './protocol.mjs';

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

export async function createStore({
  dataDir,
  maxBlobBytes = 256 * 1024 * 1024 + 2048,
  maxRoomStorageBytes = 1024 * 1024 * 1024,
  maxTotalStorageBytes = 10 * 1024 * 1024 * 1024,
  maxIncompleteBlobsPerRoom = 4,
  maxMessagesPerRoom = 100_000,
  maxRoomMessageBytes = 512 * 1024 * 1024,
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const blobDir = path.join(dataDir, 'blobs');
  await mkdir(blobDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      access_hash BLOB NOT NULL,
      next_seq INTEGER NOT NULL DEFAULT 0,
      next_receipt_seq INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      message_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      sealed_at TEXT,
      mls_welcome TEXT,
      protocol TEXT NOT NULL DEFAULT 'legacy-v1' CHECK(protocol IN ('legacy-v1', 'mls-rfc9420'))
    );

    CREATE TABLE IF NOT EXISTS members (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('creator', 'joiner')),
      encryption_jwk TEXT NOT NULL,
      signing_jwk TEXT NOT NULL,
      mls_key_package TEXT,
      join_proof TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(room_id, device_id),
      UNIQUE(room_id, role)
    );

    CREATE TABLE IF NOT EXISTS messages (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      server_seq INTEGER NOT NULL,
      client_msg_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL,
      envelope TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      PRIMARY KEY(room_id, server_seq),
      UNIQUE(room_id, client_msg_id)
    );

    CREATE TABLE IF NOT EXISTS receipts (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      receipt_seq INTEGER NOT NULL,
      client_msg_id TEXT NOT NULL,
      message_seq INTEGER NOT NULL,
      receiver_id TEXT NOT NULL,
      receipt TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      PRIMARY KEY(room_id, receipt_seq),
      UNIQUE(room_id, client_msg_id)
    );

    CREATE TABLE IF NOT EXISTS blobs (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      blob_id TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      expected_bytes INTEGER NOT NULL DEFAULT 0,
      received_bytes INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(room_id, blob_id)
    );

    CREATE TABLE IF NOT EXISTS blob_chunks (
      room_id TEXT NOT NULL,
      blob_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(room_id, blob_id, chunk_index),
      FOREIGN KEY(room_id, blob_id) REFERENCES blobs(room_id, blob_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(room_id, device_id),
      UNIQUE(endpoint),
      FOREIGN KEY(room_id, device_id) REFERENCES members(room_id, device_id) ON DELETE CASCADE
    );
  `);

  if (!hasColumn(db, 'rooms', 'next_receipt_seq')) {
    db.exec('ALTER TABLE rooms ADD COLUMN next_receipt_seq INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'rooms', 'mls_welcome')) {
    db.exec('ALTER TABLE rooms ADD COLUMN mls_welcome TEXT');
  }
  if (!hasColumn(db, 'rooms', 'protocol')) {
    db.exec("ALTER TABLE rooms ADD COLUMN protocol TEXT NOT NULL DEFAULT 'legacy-v1'");
  }
  if (!hasColumn(db, 'rooms', 'message_count')) {
    db.exec('ALTER TABLE rooms ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'rooms', 'message_bytes')) {
    db.exec('ALTER TABLE rooms ADD COLUMN message_bytes INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`UPDATE rooms SET
    message_count = (SELECT COUNT(*) FROM messages WHERE messages.room_id = rooms.room_id),
    message_bytes = (SELECT COALESCE(SUM(LENGTH(CAST(envelope AS BLOB))), 0) FROM messages WHERE messages.room_id = rooms.room_id)
    WHERE message_count = 0 AND message_bytes = 0`);
  if (!hasColumn(db, 'members', 'mls_key_package')) {
    db.exec('ALTER TABLE members ADD COLUMN mls_key_package TEXT');
  }
  if (!hasColumn(db, 'blobs', 'expected_bytes')) {
    db.exec('ALTER TABLE blobs ADD COLUMN expected_bytes INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'blobs', 'received_bytes')) {
    db.exec('ALTER TABLE blobs ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'blobs', 'updated_at')) {
    db.exec("ALTER TABLE blobs ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
  }
  db.exec("UPDATE blobs SET updated_at = created_at WHERE updated_at = ''");

  const statements = {
    insertRoom: db.prepare('INSERT INTO rooms(room_id, access_hash, created_at, protocol) VALUES (?, ?, ?, ?)'),
    insertMember: db.prepare(`INSERT INTO members(
      room_id, device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    room: db.prepare(`SELECT room_id, access_hash, next_seq, next_receipt_seq, message_count, message_bytes, created_at, sealed_at, mls_welcome, protocol
      FROM rooms WHERE room_id = ?`),
    members: db.prepare(`SELECT device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof, created_at
      FROM members WHERE room_id = ? ORDER BY role`),
    member: db.prepare(`SELECT device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof, created_at
      FROM members WHERE room_id = ? AND device_id = ?`),
    memberCount: db.prepare('SELECT COUNT(*) AS count FROM members WHERE room_id = ?'),
    sealRoom: db.prepare('UPDATE rooms SET sealed_at = ? WHERE room_id = ?'),
    messageByClientId: db.prepare(`SELECT server_seq, sender_device_id, accepted_at, envelope FROM messages
      WHERE room_id = ? AND client_msg_id = ?`),
    messageBySeq: db.prepare(`SELECT server_seq, client_msg_id, sender_device_id, accepted_at, envelope FROM messages
      WHERE room_id = ? AND server_seq = ?`),
    nextSeq: db.prepare('UPDATE rooms SET next_seq = next_seq + 1 WHERE room_id = ? RETURNING next_seq'),
    incrementMessageUsage: db.prepare('UPDATE rooms SET message_count = message_count + 1, message_bytes = message_bytes + ? WHERE room_id = ?'),
    insertMessage: db.prepare(`INSERT INTO messages(
      room_id, server_seq, client_msg_id, sender_device_id, envelope, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?)`),
    messagesAfter: db.prepare(`SELECT server_seq, envelope, accepted_at FROM messages
      WHERE room_id = ? AND server_seq > ? ORDER BY server_seq LIMIT ?`),
    roomMessageUsage: db.prepare('SELECT message_count AS count, message_bytes AS bytes FROM rooms WHERE room_id = ?'),
    receiptByClientId: db.prepare(`SELECT receipt_seq, receipt, accepted_at FROM receipts
      WHERE room_id = ? AND client_msg_id = ?`),
    nextReceiptSeq: db.prepare(`UPDATE rooms SET next_receipt_seq = next_receipt_seq + 1
      WHERE room_id = ? RETURNING next_receipt_seq`),
    insertReceipt: db.prepare(`INSERT INTO receipts(
      room_id, receipt_seq, client_msg_id, message_seq, receiver_id, receipt, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    receiptsAfter: db.prepare(`SELECT receipt_seq, receipt, accepted_at FROM receipts
      WHERE room_id = ? AND receipt_seq > ? ORDER BY receipt_seq LIMIT ?`),
    insertBlob: db.prepare(`INSERT INTO blobs(
      room_id, blob_id, chunk_count, expected_bytes, received_bytes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)`),
    blob: db.prepare(`SELECT room_id, blob_id, chunk_count, expected_bytes, received_bytes, completed, created_at, updated_at
      FROM blobs WHERE room_id = ? AND blob_id = ?`),
    roomBlobBytes: db.prepare('SELECT COALESCE(SUM(expected_bytes), 0) AS bytes FROM blobs WHERE room_id = ?'),
    totalBlobBytes: db.prepare('SELECT COALESCE(SUM(expected_bytes), 0) AS bytes FROM blobs'),
    incompleteBlobCount: db.prepare('SELECT COUNT(*) AS count FROM blobs WHERE room_id = ? AND completed = 0'),
    blobChunk: db.prepare(`SELECT byte_length FROM blob_chunks
      WHERE room_id = ? AND blob_id = ? AND chunk_index = ?`),
    blobChunks: db.prepare(`SELECT chunk_index, byte_length FROM blob_chunks
      WHERE room_id = ? AND blob_id = ? ORDER BY chunk_index`),
    insertBlobChunk: db.prepare(`INSERT INTO blob_chunks(
      room_id, blob_id, chunk_index, byte_length, created_at
    ) VALUES (?, ?, ?, ?, ?)`),
    refreshBlobBytes: db.prepare(`UPDATE blobs SET
      received_bytes = (SELECT COALESCE(SUM(byte_length), 0) FROM blob_chunks
        WHERE room_id = ? AND blob_id = ?),
      updated_at = ? WHERE room_id = ? AND blob_id = ?`),
    completeBlob: db.prepare('UPDATE blobs SET completed = 1, updated_at = ? WHERE room_id = ? AND blob_id = ?'),
    expiredBlobs: db.prepare('SELECT room_id, blob_id FROM blobs WHERE completed = 0 AND updated_at < ?'),
    orphanRooms: db.prepare(`SELECT rooms.room_id FROM rooms
      WHERE rooms.sealed_at IS NULL AND rooms.created_at < ?
      AND (SELECT COUNT(*) FROM members WHERE members.room_id = rooms.room_id) = 1`),
    deleteBlob: db.prepare('DELETE FROM blobs WHERE room_id = ? AND blob_id = ?'),
    upsertPushSubscription: db.prepare(`INSERT INTO push_subscriptions(
      room_id, device_id, endpoint, p256dh, auth, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, device_id) DO UPDATE SET
      endpoint = excluded.endpoint,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      updated_at = excluded.updated_at`),
    pushSubscriptionsForRoom: db.prepare(`SELECT device_id, endpoint, p256dh, auth, updated_at
      FROM push_subscriptions WHERE room_id = ? AND device_id <> ? ORDER BY device_id`),
    deletePushSubscription: db.prepare('DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ?'),
    deletePushSubscriptionByEndpoint: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    saveMlsWelcome: db.prepare('UPDATE rooms SET mls_welcome = ? WHERE room_id = ? AND mls_welcome IS NULL'),
  };

  const blobLocks = new Map();

  function withBlobLock(roomId, blobId, action) {
    const key = `${roomId}:${blobId}`;
    const previous = blobLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    blobLocks.set(key, next);
    return next.finally(() => {
      if (blobLocks.get(key) === next) blobLocks.delete(key);
    });
  }

  function memberRow(row) {
    if (!row) return null;
    return {
      deviceId: row.device_id,
      role: row.role,
      encryptionKey: JSON.parse(row.encryption_jwk),
      signingKey: JSON.parse(row.signing_jwk),
      ...(row.mls_key_package ? { mlsKeyPackage: row.mls_key_package } : {}),
      joinProof: row.join_proof,
      createdAt: row.created_at,
    };
  }

  function authenticate(roomId, token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) return false;
    const room = statements.room.get(roomId);
    if (!room) return false;
    const expected = Buffer.from(room.access_hash);
    const actual = hashToken(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function createRoom(creatorBundle, accessToken) {
    const roomId = randomUUID();
    const createdAt = nowIso();
    const protocol = creatorBundle.mlsKeyPackage ? 'mls-rfc9420' : 'legacy-v1';
    db.exec('BEGIN IMMEDIATE');
    try {
      statements.insertRoom.run(roomId, hashToken(accessToken), createdAt, protocol);
      statements.insertMember.run(
        roomId,
        creatorBundle.deviceId,
        'creator',
        JSON.stringify(creatorBundle.encryptionKey),
        JSON.stringify(creatorBundle.signingKey),
        creatorBundle.mlsKeyPackage ?? null,
        null,
        createdAt,
      );
      db.exec('COMMIT');
      return { roomId, createdAt, protocol };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function deleteRoom(roomId, accessToken) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const room = statements.room.get(roomId);
      if (!room || !authenticate(roomId, accessToken)) throw new Error('UNAUTHORIZED');
      const { count } = statements.memberCount.get(roomId);
      if (count > 1 || room.sealed_at) throw new Error('ROOM_SEALED');
      const deleted = db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId).changes > 0;
      db.exec('COMMIT');
      return { deleted };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function joinRoom(roomId, bundle, proof) {
    const createdAt = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const room = statements.room.get(roomId);
      if (!room) throw new Error('ROOM_NOT_FOUND');
      if (room.protocol === 'mls-rfc9420' && !bundle.mlsKeyPackage) throw new Error('PROTOCOL_MISMATCH');
      const existing = statements.member.get(roomId, bundle.deviceId);
      if (existing) {
        const sameJoin = existing.role === 'joiner' &&
          existing.encryption_jwk === JSON.stringify(bundle.encryptionKey) &&
          existing.signing_jwk === JSON.stringify(bundle.signingKey) &&
          existing.mls_key_package === (bundle.mlsKeyPackage ?? null) &&
          existing.join_proof === proof;
        if (!sameJoin) throw new Error('ROOM_SEALED');
        db.exec('COMMIT');
        return roomState(roomId);
      }
      const { count } = statements.memberCount.get(roomId);
      if (count >= 2 || room.sealed_at) throw new Error('ROOM_SEALED');
      statements.insertMember.run(
        roomId,
        bundle.deviceId,
        'joiner',
        JSON.stringify(bundle.encryptionKey),
        JSON.stringify(bundle.signingKey),
        bundle.mlsKeyPackage ?? null,
        proof,
        createdAt,
      );
      statements.sealRoom.run(createdAt, roomId);
      db.exec('COMMIT');
      return roomState(roomId);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function roomState(roomId) {
    const room = statements.room.get(roomId);
    if (!room) return null;
    return {
      roomId,
      nextSeq: room.next_seq,
      nextReceiptSeq: room.next_receipt_seq,
      createdAt: room.created_at,
      sealedAt: room.sealed_at,
      protocol: room.protocol,
      mlsWelcome: room.mls_welcome ? JSON.parse(room.mls_welcome) : null,
      members: statements.members.all(roomId).map(memberRow),
    };
  }

  function saveMlsWelcome(roomId, envelope) {
    const room = statements.room.get(roomId);
    if (!room) throw new Error('ROOM_NOT_FOUND');
    const serialized = JSON.stringify(envelope);
    if (room.mls_welcome) {
      if (room.mls_welcome !== serialized) throw new Error('MLS_WELCOME_CONFLICT');
      return roomState(roomId);
    }
    statements.saveMlsWelcome.run(serialized, roomId);
    return roomState(roomId);
  }

  function getMember(roomId, deviceId) {
    return memberRow(statements.member.get(roomId, deviceId));
  }

  function getMessage(roomId, seq) {
    const row = statements.messageBySeq.get(roomId, seq);
    if (!row) return null;
    return {
      seq: row.server_seq,
      clientMsgId: row.client_msg_id,
      senderId: row.sender_device_id,
      acceptedAt: row.accepted_at,
      envelope: JSON.parse(row.envelope),
    };
  }

  function savePushSubscription(roomId, deviceId, subscription) {
    if (!statements.member.get(roomId, deviceId)) throw new Error('MEMBER_NOT_FOUND');
    const now = nowIso();
    statements.upsertPushSubscription.run(
      roomId,
      deviceId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      now,
      now,
    );
    return { stored: true, updatedAt: now };
  }

  function pushSubscriptionsForRoom(roomId, excludeDeviceId) {
    return statements.pushSubscriptionsForRoom.all(roomId, excludeDeviceId).map((row) => ({
      deviceId: row.device_id,
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
      updatedAt: row.updated_at,
    }));
  }

  function deletePushSubscription(roomId, deviceId) {
    return statements.deletePushSubscription.run(roomId, deviceId).changes > 0;
  }

  function deletePushSubscriptionByEndpoint(endpoint) {
    return statements.deletePushSubscriptionByEndpoint.run(endpoint).changes > 0;
  }

  function insertMessage(roomId, envelope) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = statements.messageByClientId.get(roomId, envelope.clientMsgId);
      if (existing) {
        if (existing.sender_device_id !== envelope.senderId) throw new Error('MESSAGE_CONFLICT');
        if (canonicalStringify(JSON.parse(existing.envelope)) !== canonicalStringify(envelope)) {
          throw new Error('MESSAGE_CONFLICT');
        }
        db.exec('COMMIT');
        return {
          seq: existing.server_seq,
          acceptedAt: existing.accepted_at,
          envelope: JSON.parse(existing.envelope),
          duplicate: true,
        };
      }
      const serializedEnvelope = JSON.stringify(envelope);
      const envelopeBytes = Buffer.byteLength(serializedEnvelope, 'utf8');
      const usage = statements.roomMessageUsage.get(roomId);
      if (usage.count >= maxMessagesPerRoom || usage.bytes + envelopeBytes > maxRoomMessageBytes) {
        throw new Error('MESSAGE_QUOTA');
      }
      const { next_seq: seq } = statements.nextSeq.get(roomId);
      const acceptedAt = nowIso();
      statements.insertMessage.run(
        roomId,
        seq,
        envelope.clientMsgId,
        envelope.senderId,
        serializedEnvelope,
        acceptedAt,
      );
      statements.incrementMessageUsage.run(envelopeBytes, roomId);
      db.exec('COMMIT');
      return { seq, acceptedAt, envelope, duplicate: false };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function messagesAfter(roomId, afterSeq, limit = 500) {
    return statements.messagesAfter.all(roomId, afterSeq, Math.min(Math.max(limit, 1), 500)).map((row) => ({
      seq: row.server_seq,
      envelope: JSON.parse(row.envelope),
      acceptedAt: row.accepted_at,
    }));
  }

  function insertReceipt(roomId, receipt) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const message = statements.messageBySeq.get(roomId, receipt.seq);
      if (!message || message.client_msg_id !== receipt.clientMsgId || message.sender_device_id === receipt.receiverId) {
        throw new Error('INVALID_RECEIPT');
      }
      const existing = statements.receiptByClientId.get(roomId, receipt.clientMsgId);
      if (existing) {
        if (existing.receipt !== JSON.stringify(receipt)) throw new Error('RECEIPT_CONFLICT');
        db.exec('COMMIT');
        return {
          receiptSeq: existing.receipt_seq,
          receipt: JSON.parse(existing.receipt),
          acceptedAt: existing.accepted_at,
          duplicate: true,
        };
      }
      const { next_receipt_seq: receiptSeq } = statements.nextReceiptSeq.get(roomId);
      const acceptedAt = nowIso();
      statements.insertReceipt.run(
        roomId,
        receiptSeq,
        receipt.clientMsgId,
        receipt.seq,
        receipt.receiverId,
        JSON.stringify(receipt),
        acceptedAt,
      );
      db.exec('COMMIT');
      return { receiptSeq, receipt, acceptedAt, duplicate: false };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function receiptsAfter(roomId, afterReceiptSeq, limit = 500) {
    return statements.receiptsAfter.all(roomId, afterReceiptSeq, Math.min(Math.max(limit, 1), 500)).map((row) => ({
      receiptSeq: row.receipt_seq,
      receipt: JSON.parse(row.receipt),
      acceptedAt: row.accepted_at,
    }));
  }

  function createBlob(roomId, blobId, chunkCount, expectedBytes) {
    const existing = statements.blob.get(roomId, blobId);
    if (existing) {
      if (existing.chunk_count !== chunkCount || existing.expected_bytes !== expectedBytes) throw new Error('BLOB_CONFLICT');
      return blobStatus(roomId, blobId);
    }
    if (expectedBytes < chunkCount * 17 || expectedBytes > maxBlobBytes) throw new Error('BLOB_QUOTA');
    if (statements.incompleteBlobCount.get(roomId).count >= maxIncompleteBlobsPerRoom) {
      throw new Error('TOO_MANY_UPLOADS');
    }
    if (statements.roomBlobBytes.get(roomId).bytes + expectedBytes > maxRoomStorageBytes) {
      throw new Error('STORAGE_QUOTA');
    }
    if (statements.totalBlobBytes.get().bytes + expectedBytes > maxTotalStorageBytes) {
      throw new Error('STORAGE_QUOTA');
    }
    const createdAt = nowIso();
    statements.insertBlob.run(roomId, blobId, chunkCount, expectedBytes, createdAt, createdAt);
    return blobStatus(roomId, blobId);
  }

  function blobStatus(roomId, blobId) {
    const blob = statements.blob.get(roomId, blobId);
    if (!blob) throw new Error('INVALID_BLOB');
    return {
      blobId,
      chunkCount: blob.chunk_count,
      expectedBytes: blob.expected_bytes,
      receivedBytes: blob.received_bytes,
      uploadedIndexes: statements.blobChunks.all(roomId, blobId).map((chunk) => chunk.chunk_index),
      completed: Boolean(blob.completed),
    };
  }

  async function putBlobChunk(roomId, blobId, index, bytes) {
    return withBlobLock(roomId, blobId, async () => {
      const blob = statements.blob.get(roomId, blobId);
      if (!blob || blob.completed || index < 0 || index >= blob.chunk_count || bytes.length < 17) {
        throw new Error('INVALID_BLOB');
      }
      const targetDir = path.join(blobDir, roomId, blobId);
      await mkdir(targetDir, { recursive: true });
      const target = path.join(targetDir, `${String(index).padStart(8, '0')}.bin`);
      let alreadyExists = false;
      await writeFile(target, bytes, { flag: 'wx' }).catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
        alreadyExists = true;
        const existing = await readFile(target);
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw new Error('CHUNK_CONFLICT');
      });

      const storedChunk = statements.blobChunk.get(roomId, blobId, index);
      if (storedChunk && storedChunk.byte_length !== bytes.length) throw new Error('CHUNK_CONFLICT');
      if (!storedChunk) {
        if (blob.received_bytes + bytes.length > blob.expected_bytes) {
          if (!alreadyExists) await rm(target, { force: true });
          throw new Error('BLOB_SIZE_MISMATCH');
        }
        statements.insertBlobChunk.run(roomId, blobId, index, bytes.length, nowIso());
        statements.refreshBlobBytes.run(roomId, blobId, nowIso(), roomId, blobId);
      }
      return blobStatus(roomId, blobId);
    });
  }

  async function completeBlob(roomId, blobId) {
    return withBlobLock(roomId, blobId, async () => {
      const blob = statements.blob.get(roomId, blobId);
      if (!blob) throw new Error('INVALID_BLOB');
      if (blob.completed) return blobStatus(roomId, blobId);
      const chunks = statements.blobChunks.all(roomId, blobId);
      if (chunks.length !== blob.chunk_count || blob.received_bytes !== blob.expected_bytes) {
        throw new Error('BLOB_INCOMPLETE');
      }
      const targetDir = path.join(blobDir, roomId, blobId);
      for (let index = 0; index < blob.chunk_count; index += 1) {
        const fileInfo = await stat(path.join(targetDir, `${String(index).padStart(8, '0')}.bin`));
        if (fileInfo.size !== chunks[index].byte_length || chunks[index].chunk_index !== index) {
          throw new Error('BLOB_INCOMPLETE');
        }
      }
      statements.completeBlob.run(nowIso(), roomId, blobId);
      return blobStatus(roomId, blobId);
    });
  }

  async function getBlobChunk(roomId, blobId, index) {
    const blob = statements.blob.get(roomId, blobId);
    if (!blob || !blob.completed || index < 0 || index >= blob.chunk_count) throw new Error('INVALID_BLOB');
    return readFile(path.join(blobDir, roomId, blobId, `${String(index).padStart(8, '0')}.bin`));
  }

  async function cleanupExpiredBlobs(cutoffIso) {
    const expired = statements.expiredBlobs.all(cutoffIso);
    let removed = 0;
    for (const blob of expired) {
      await withBlobLock(blob.room_id, blob.blob_id, async () => {
        const current = statements.blob.get(blob.room_id, blob.blob_id);
        if (!current || current.completed || current.updated_at >= cutoffIso) return;
        await rm(path.join(blobDir, blob.room_id, blob.blob_id), { recursive: true, force: true });
        statements.deleteBlob.run(blob.room_id, blob.blob_id);
        removed += 1;
      });
    }
    return removed;
  }

  function cleanupOrphanRooms(cutoffIso) {
    const rooms = statements.orphanRooms.all(cutoffIso);
    let removed = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const room of rooms) {
        removed += db.prepare('DELETE FROM rooms WHERE room_id = ? AND sealed_at IS NULL').run(room.room_id).changes;
      }
      db.exec('COMMIT');
      return removed;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function healthCheck() {
    const result = { database: false, storage: false };
    try {
      db.exec('BEGIN IMMEDIATE; ROLLBACK;');
      result.database = true;
    } catch {
      result.database = false;
    }
    try {
      await access(dataDir, fsConstants.R_OK | fsConstants.W_OK);
      await access(blobDir, fsConstants.R_OK | fsConstants.W_OK);
      result.storage = true;
    } catch {
      result.storage = false;
    }
    return { ok: result.database && result.storage, ...result };
  }

  return {
    authenticate,
    blobStatus,
    cleanupExpiredBlobs,
    cleanupOrphanRooms,
    completeBlob,
    createBlob,
    createRoom,
    deleteRoom,
    getBlobChunk,
    getMember,
    getMessage,
    healthCheck,
    insertMessage,
    insertReceipt,
    joinRoom,
    messagesAfter,
    putBlobChunk,
    pushSubscriptionsForRoom,
    receiptsAfter,
    roomState,
    savePushSubscription,
    saveMlsWelcome,
    deletePushSubscription,
    deletePushSubscriptionByEndpoint,
    close: () => db.close(),
  };
}
