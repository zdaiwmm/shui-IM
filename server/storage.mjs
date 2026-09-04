import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { canonicalStringify, isCanonicalUtcTimestamp } from './protocol.mjs';
import { createCloudBackups } from './cloud-backups.mjs';

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
      next_mls_event_seq INTEGER NOT NULL DEFAULT 0,
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
      access_hash BLOB NOT NULL,
      device_name TEXT NOT NULL DEFAULT '未命名设备',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'revoked')),
      added_by TEXT,
      join_seq INTEGER NOT NULL DEFAULT 0,
      join_receipt_seq INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      revoked_at TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      PRIMARY KEY(room_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      server_seq INTEGER NOT NULL,
      client_msg_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL,
      envelope TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      count_unread INTEGER NOT NULL DEFAULT 1,
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
      UNIQUE(room_id, client_msg_id, receiver_id)
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

    CREATE TABLE IF NOT EXISTS unread_observers (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      token_hash BLOB NOT NULL,
      read_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(room_id, device_id),
      FOREIGN KEY(room_id, device_id) REFERENCES members(room_id, device_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_links (
      link_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      authorizer_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('creator', 'joiner')),
      secret_hash BLOB NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_device_id TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      used_at TEXT,
      FOREIGN KEY(room_id, authorizer_id) REFERENCES members(room_id, device_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mls_events (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      event_seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL,
      target_device_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('add', 'remove', 'replace')),
      envelope TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      PRIMARY KEY(room_id, event_seq),
      UNIQUE(room_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS recovery_requests (
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      replacement_device_id TEXT NOT NULL,
      token_hash BLOB NOT NULL,
      request TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'expired')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(room_id, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_recovery ON recovery_requests(room_id, source_device_id) WHERE status = 'pending';
    CREATE UNIQUE INDEX IF NOT EXISTS one_room_recovery ON recovery_requests(room_id) WHERE status = 'pending';
  `);

  const eventsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mls_events'").get()?.sql ?? '';
  if (!eventsSchema.includes("'replace'")) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE mls_events RENAME TO mls_events_before_recovery;
      CREATE TABLE mls_events (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        event_seq INTEGER NOT NULL, event_id TEXT NOT NULL, sender_device_id TEXT NOT NULL,
        target_device_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('add', 'remove', 'replace')),
        envelope TEXT NOT NULL, accepted_at TEXT NOT NULL,
        PRIMARY KEY(room_id, event_seq), UNIQUE(room_id, event_id)
      );
      INSERT INTO mls_events SELECT * FROM mls_events_before_recovery;
      DROP TABLE mls_events_before_recovery;
      COMMIT;`);
  }

  if (!hasColumn(db, 'rooms', 'next_receipt_seq')) {
    db.exec('ALTER TABLE rooms ADD COLUMN next_receipt_seq INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'messages', 'count_unread')) {
    db.exec('ALTER TABLE messages ADD COLUMN count_unread INTEGER NOT NULL DEFAULT 1');
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
  if (!hasColumn(db, 'rooms', 'next_mls_event_seq')) {
    db.exec('ALTER TABLE rooms ADD COLUMN next_mls_event_seq INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`UPDATE rooms SET
    message_count = (SELECT COUNT(*) FROM messages WHERE messages.room_id = rooms.room_id),
    message_bytes = (SELECT COALESCE(SUM(LENGTH(CAST(envelope AS BLOB))), 0) FROM messages WHERE messages.room_id = rooms.room_id)
    WHERE message_count = 0 AND message_bytes = 0`);
  if (!hasColumn(db, 'members', 'mls_key_package')) {
    db.exec('ALTER TABLE members ADD COLUMN mls_key_package TEXT');
  }
  if (!hasColumn(db, 'members', 'status')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE members_v2 (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('creator', 'joiner')),
        encryption_jwk TEXT NOT NULL,
        signing_jwk TEXT NOT NULL,
        mls_key_package TEXT,
        join_proof TEXT,
        access_hash BLOB NOT NULL,
        device_name TEXT NOT NULL DEFAULT '已迁移设备',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'revoked')),
        added_by TEXT,
        join_seq INTEGER NOT NULL DEFAULT 0,
        join_receipt_seq INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        revoked_at TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY(room_id, device_id)
      );
      INSERT INTO members_v2(
        room_id, device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof,
        access_hash, device_name, status, join_seq, join_receipt_seq, created_at
      )
      SELECT members.room_id, device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof,
        rooms.access_hash, '已迁移设备', 'active', 0, 0, members.created_at
      FROM members JOIN rooms ON rooms.room_id = members.room_id;
      DROP TABLE members;
      ALTER TABLE members_v2 RENAME TO members;
      COMMIT;`);
    db.exec('PRAGMA foreign_keys = ON');
  }
  const receiptsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'receipts'").get()?.sql ?? '';
  if (!receiptsSchema.includes('UNIQUE(room_id, client_msg_id, receiver_id)')) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE receipts_v2 (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        receipt_seq INTEGER NOT NULL,
        client_msg_id TEXT NOT NULL,
        message_seq INTEGER NOT NULL,
        receiver_id TEXT NOT NULL,
        receipt TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        PRIMARY KEY(room_id, receipt_seq),
        UNIQUE(room_id, client_msg_id, receiver_id)
      );
      INSERT INTO receipts_v2 SELECT * FROM receipts;
      DROP TABLE receipts;
      ALTER TABLE receipts_v2 RENAME TO receipts;
      COMMIT;`);
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

  const cloudBackups = createCloudBackups(db, { authenticatedDevice });
  const statements = {
    insertRoom: db.prepare('INSERT INTO rooms(room_id, access_hash, created_at, protocol) VALUES (?, ?, ?, ?)'),
    insertMember: db.prepare(`INSERT INTO members(
      room_id, device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof, access_hash,
      device_name, status, added_by, join_seq, join_receipt_seq, capabilities, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    room: db.prepare(`SELECT room_id, access_hash, next_seq, next_receipt_seq, next_mls_event_seq,
      message_count, message_bytes, created_at, sealed_at, mls_welcome, protocol
      FROM rooms WHERE room_id = ?`),
    members: db.prepare(`SELECT device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof,
      device_name, status, added_by, join_seq, join_receipt_seq, last_seen_at, revoked_at, capabilities, created_at
      FROM members WHERE room_id = ? ORDER BY role, created_at, device_id`),
    member: db.prepare(`SELECT device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof,
      device_name, status, added_by, join_seq, join_receipt_seq, last_seen_at, revoked_at, capabilities, created_at
      FROM members WHERE room_id = ? AND device_id = ?`),
    memberCount: db.prepare("SELECT COUNT(*) AS count FROM members WHERE room_id = ? AND status = 'active'"),
    memberCountForRole: db.prepare("SELECT COUNT(*) AS count FROM members WHERE room_id = ? AND role = ? AND status = 'active'"),
    memberReservationCountForRole: db.prepare("SELECT COUNT(*) AS count FROM members WHERE room_id = ? AND role = ? AND status IN ('pending', 'active')"),
    memberByToken: db.prepare("SELECT device_id FROM members WHERE room_id = ? AND access_hash = ? AND status = 'active'"),
    memberByIdAndToken: db.prepare("SELECT device_id FROM members WHERE room_id = ? AND device_id = ? AND access_hash = ? AND status = 'active'"),
    touchMember: db.prepare("UPDATE members SET last_seen_at = ? WHERE room_id = ? AND device_id = ? AND status = 'active'"),
    updateMemberCapabilities: db.prepare("UPDATE members SET capabilities = ? WHERE room_id = ? AND device_id = ? AND status = 'active'"),
    sealRoom: db.prepare('UPDATE rooms SET sealed_at = ? WHERE room_id = ?'),
    messageByClientId: db.prepare(`SELECT server_seq, sender_device_id, accepted_at, envelope FROM messages
      WHERE room_id = ? AND client_msg_id = ?`),
    messageBySeq: db.prepare(`SELECT server_seq, client_msg_id, sender_device_id, accepted_at, envelope FROM messages
      WHERE room_id = ? AND server_seq = ?`),
    nextSeq: db.prepare('UPDATE rooms SET next_seq = next_seq + 1 WHERE room_id = ? RETURNING next_seq'),
    incrementMessageUsage: db.prepare('UPDATE rooms SET message_count = message_count + 1, message_bytes = message_bytes + ? WHERE room_id = ?'),
    insertMessage: db.prepare(`INSERT INTO messages(
      room_id, server_seq, client_msg_id, sender_device_id, envelope, accepted_at, count_unread
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    messagesAfter: db.prepare(`SELECT server_seq, envelope, accepted_at FROM messages
      WHERE room_id = ? AND server_seq > ? AND server_seq > ? ORDER BY server_seq LIMIT ?`),
    roomMessageUsage: db.prepare('SELECT message_count AS count, message_bytes AS bytes FROM rooms WHERE room_id = ?'),
    receiptByClientId: db.prepare(`SELECT receipt_seq, receipt, accepted_at FROM receipts
      WHERE room_id = ? AND client_msg_id = ? AND receiver_id = ?`),
    nextReceiptSeq: db.prepare(`UPDATE rooms SET next_receipt_seq = next_receipt_seq + 1
      WHERE room_id = ? RETURNING next_receipt_seq`),
    insertReceipt: db.prepare(`INSERT INTO receipts(
      room_id, receipt_seq, client_msg_id, message_seq, receiver_id, receipt, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    receiptsAfter: db.prepare(`SELECT receipt_seq, message_seq, receipt, accepted_at FROM receipts
      WHERE room_id = ? AND receipt_seq > ? AND receipt_seq > ? ORDER BY receipt_seq LIMIT ?`),
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
    unreadObserver: db.prepare('SELECT token_hash, read_seq FROM unread_observers WHERE room_id = ? AND device_id = ?'),
    upsertUnreadObserver: db.prepare(`INSERT INTO unread_observers(room_id, device_id, token_hash, read_seq)
      VALUES (?, ?, ?, ?) ON CONFLICT(room_id, device_id) DO UPDATE SET
      token_hash = excluded.token_hash, read_seq = MAX(unread_observers.read_seq, excluded.read_seq)`),
    unreadCount: db.prepare(`SELECT COUNT(*) AS count FROM messages
      JOIN members AS sender ON sender.room_id = messages.room_id AND sender.device_id = messages.sender_device_id
      WHERE messages.room_id = ? AND messages.server_seq > ? AND messages.count_unread = 1 AND sender.role <> ?`),
    saveMlsWelcome: db.prepare('UPDATE rooms SET mls_welcome = ? WHERE room_id = ? AND mls_welcome IS NULL'),
    insertDeviceLink: db.prepare(`INSERT INTO device_links(
      link_id, room_id, authorizer_id, role, secret_hash, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    deviceLink: db.prepare(`SELECT link_id, room_id, authorizer_id, role, secret_hash, expires_at,
      claimed_device_id, created_at, claimed_at, used_at FROM device_links WHERE link_id = ?`),
    deviceLinksForRoom: db.prepare(`SELECT link_id, room_id, authorizer_id, role, expires_at,
      claimed_device_id, created_at, claimed_at, used_at FROM device_links
      WHERE room_id = ? AND authorizer_id = ? ORDER BY created_at DESC LIMIT 12`),
    expiredDeviceLinks: db.prepare(`SELECT link_id, room_id, authorizer_id, claimed_device_id FROM device_links
      WHERE used_at IS NULL AND expires_at <= ?`),
    deletePendingLinkedMember: db.prepare(`DELETE FROM members
      WHERE room_id = ? AND device_id = ? AND added_by = ? AND status = 'pending'`),
    deleteDeviceLink: db.prepare('DELETE FROM device_links WHERE link_id = ? AND used_at IS NULL'),
    claimDeviceLink: db.prepare(`UPDATE device_links SET claimed_device_id = ?, claimed_at = ?
      WHERE link_id = ? AND claimed_device_id IS NULL AND used_at IS NULL`),
    useDeviceLink: db.prepare('UPDATE device_links SET used_at = ? WHERE link_id = ? AND used_at IS NULL'),
    nextMlsEventSeq: db.prepare(`UPDATE rooms SET next_mls_event_seq = next_mls_event_seq + 1
      WHERE room_id = ? AND next_mls_event_seq = ? RETURNING next_mls_event_seq`),
    mlsEventById: db.prepare('SELECT event_seq, envelope, accepted_at FROM mls_events WHERE room_id = ? AND event_id = ?'),
    insertMlsEvent: db.prepare(`INSERT INTO mls_events(
      room_id, event_seq, event_id, sender_device_id, target_device_id, action, envelope, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    mlsEventsAfter: db.prepare(`SELECT event_seq, envelope, accepted_at FROM mls_events
      WHERE room_id = ? AND event_seq > ? ORDER BY event_seq`),
    activateMember: db.prepare(`UPDATE members SET status = 'active', join_seq = ?, join_receipt_seq = ?
      WHERE room_id = ? AND device_id = ? AND status = 'pending'`),
    revokeMember: db.prepare(`UPDATE members SET status = 'revoked', revoked_at = ?
      WHERE room_id = ? AND device_id = ? AND status = 'active'`),
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
      deviceName: row.device_name,
      status: row.status,
      addedBy: row.added_by,
      joinSeq: row.join_seq,
      joinReceiptSeq: row.join_receipt_seq,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      capabilities: JSON.parse(row.capabilities || '[]'),
      createdAt: row.created_at,
    };
  }

  function validToken(token) {
    return typeof token === 'string' && token.length >= 32 && token.length <= 512;
  }

  function authenticateInvite(roomId, token) {
    if (!validToken(token)) return false;
    const room = statements.room.get(roomId);
    if (!room) return false;
    const expected = Buffer.from(room.access_hash);
    const actual = hashToken(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function authenticatedDevice(roomId, token, expectedDeviceId) {
    if (!validToken(token)) return null;
    const digest = hashToken(token);
    const row = expectedDeviceId
      ? statements.memberByIdAndToken.get(roomId, expectedDeviceId, digest)
      : statements.memberByToken.get(roomId, digest);
    if (!row || deviceRecoveryPending(roomId, row.device_id)) return null;
    statements.touchMember.run(nowIso(), roomId, row.device_id);
    return getMember(roomId, row.device_id);
  }

  function updateMemberCapabilities(roomId, deviceId, capabilities) {
    assertDeviceActive(roomId, deviceId);
    const normalized = [...new Set(capabilities)];
    const result = statements.updateMemberCapabilities.run(JSON.stringify(normalized), roomId, deviceId);
    if (result.changes !== 1) throw new Error('MEMBER_NOT_FOUND');
    return getMember(roomId, deviceId);
  }

  function authenticate(roomId, token) {
    return Boolean(authenticatedDevice(roomId, token) || authenticateInvite(roomId, token));
  }

  function deviceTokenHash(token, fallback) {
    if (token === undefined || token === null) return Buffer.from(fallback);
    if (!validToken(token)) throw new Error('INVALID_DEVICE_TOKEN');
    return hashToken(token);
  }

  function createRoom(creatorBundle, accessToken, inviteToken = accessToken, deviceName = '此设备', capabilities = []) {
    const roomId = randomUUID();
    const createdAt = nowIso();
    const protocol = creatorBundle.mlsKeyPackage ? 'mls-rfc9420' : 'legacy-v1';
    db.exec('BEGIN IMMEDIATE');
    try {
      statements.insertRoom.run(roomId, hashToken(inviteToken), createdAt, protocol);
      statements.insertMember.run(
        roomId,
        creatorBundle.deviceId,
        'creator',
        JSON.stringify(creatorBundle.encryptionKey),
        JSON.stringify(creatorBundle.signingKey),
        creatorBundle.mlsKeyPackage ?? null,
        null,
        hashToken(accessToken),
        deviceName,
        'active',
        null,
        0,
        0,
        JSON.stringify(capabilities),
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
      if (!room || !authenticatedDevice(roomId, accessToken)) throw new Error('UNAUTHORIZED');
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

  function joinRoom(roomId, bundle, proof, accessToken, deviceName = '此设备', capabilities = []) {
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
        deviceTokenHash(accessToken, room.access_hash),
        deviceName,
        'active',
        null,
        0,
        0,
        JSON.stringify(capabilities),
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
      nextMlsEventSeq: room.next_mls_event_seq,
      createdAt: room.created_at,
      sealedAt: room.sealed_at,
      protocol: room.protocol,
      mlsWelcome: room.mls_welcome ? JSON.parse(room.mls_welcome) : null,
      members: statements.members.all(roomId).map(memberRow),
      recoveryRequests: db.prepare("SELECT request FROM recovery_requests WHERE room_id = ? AND status = 'pending' AND expires_at > ?")
        .all(roomId, nowIso()).map((row) => JSON.parse(row.request)),
      mlsEvents: statements.mlsEventsAfter.all(roomId, 0).map((event) => ({
        eventSeq: event.event_seq,
        event: JSON.parse(event.envelope),
        acceptedAt: event.accepted_at,
      })),
    };
  }

  function saveMlsWelcome(roomId, envelope) {
    assertDeviceActive(roomId, envelope.senderId);
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

  function publicDeviceLink(row) {
    if (!row) return null;
    return {
      linkId: row.link_id,
      roomId: row.room_id,
      authorizerId: row.authorizer_id,
      role: row.role,
      expiresAt: row.expires_at,
      claimedDeviceId: row.claimed_device_id,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      usedAt: row.used_at,
    };
  }

  function verifyDeviceLinkSecret(row, secret) {
    if (!row || !validToken(secret)) return false;
    const expected = Buffer.from(row.secret_hash);
    const actual = hashToken(secret);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function createDeviceLink(roomId, authorizerId, linkId, secret, expiresAt) {
    cleanupExpiredRecoveryRequests();
    cleanupExpiredDeviceLinks(nowIso());
    const room = statements.room.get(roomId);
    const authorizer = getMember(roomId, authorizerId);
    if (!room || room.protocol !== 'mls-rfc9420') throw new Error('PROTOCOL_MISMATCH');
    assertDeviceActive(roomId, authorizerId);
    if (statements.memberReservationCountForRole.get(roomId, authorizer.role).count >= 3) throw new Error('DEVICE_LIMIT');
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 15 * 60_000) {
      throw new Error('INVALID_DEVICE_LINK');
    }
    statements.insertDeviceLink.run(linkId, roomId, authorizerId, authorizer.role, hashToken(secret), expiresAt, nowIso());
    return publicDeviceLink(statements.deviceLink.get(linkId));
  }

  function claimDeviceLink(linkId, secret, bundle, accessToken, deviceName, capabilities = []) {
    cleanupExpiredRecoveryRequests();
    cleanupExpiredDeviceLinks(nowIso());
    db.exec('BEGIN IMMEDIATE');
    try {
      const link = statements.deviceLink.get(linkId);
      if (!verifyDeviceLinkSecret(link, secret) || link.used_at || Date.parse(link.expires_at) <= Date.now()) {
        throw new Error('INVALID_DEVICE_LINK');
      }
      assertDeviceActive(link.room_id, link.authorizer_id);
      if (link.claimed_device_id) {
        if (link.claimed_device_id !== bundle.deviceId) throw new Error('DEVICE_LINK_CLAIMED');
        const existing = getMember(link.room_id, bundle.deviceId);
        if (!existing || canonicalStringify({
          deviceId: existing.deviceId,
          encryptionKey: existing.encryptionKey,
          signingKey: existing.signingKey,
          mlsKeyPackage: existing.mlsKeyPackage,
        }) !== canonicalStringify(bundle)) throw new Error('DEVICE_LINK_CLAIMED');
        db.exec('COMMIT');
        return { link: publicDeviceLink(link), state: roomState(link.room_id) };
      }
      if (statements.memberReservationCountForRole.get(link.room_id, link.role).count >= 3) throw new Error('DEVICE_LIMIT');
      if (statements.member.get(link.room_id, bundle.deviceId)) throw new Error('DEVICE_LINK_CLAIMED');
      if (!bundle.mlsKeyPackage) throw new Error('PROTOCOL_MISMATCH');
      const createdAt = nowIso();
      statements.insertMember.run(
        link.room_id,
        bundle.deviceId,
        link.role,
        JSON.stringify(bundle.encryptionKey),
        JSON.stringify(bundle.signingKey),
        bundle.mlsKeyPackage ?? null,
        null,
        hashToken(accessToken),
        deviceName,
        'pending',
        link.authorizer_id,
        0,
        0,
        JSON.stringify(capabilities),
        createdAt,
      );
      if (statements.claimDeviceLink.run(bundle.deviceId, createdAt, linkId).changes !== 1) {
        throw new Error('DEVICE_LINK_CLAIMED');
      }
      db.exec('COMMIT');
      return { link: publicDeviceLink(statements.deviceLink.get(linkId)), state: roomState(link.room_id) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function deviceLinkStatus(linkId, secret) {
    const link = statements.deviceLink.get(linkId);
    if (!verifyDeviceLinkSecret(link, secret)) throw new Error('INVALID_DEVICE_LINK');
    if (!link.used_at) assertDeviceActive(link.room_id, link.authorizer_id);
    return { link: publicDeviceLink(link), state: roomState(link.room_id) };
  }

  function deviceLinksForRoom(roomId, authorizerId) {
    cleanupExpiredDeviceLinks(nowIso());
    return statements.deviceLinksForRoom.all(roomId, authorizerId).map(publicDeviceLink);
  }

  function cleanupExpiredDeviceLinks(cutoffIso = nowIso()) {
    const expired = statements.expiredDeviceLinks.all(cutoffIso);
    if (expired.length === 0) return 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      let removed = 0;
      for (const link of expired) {
        if (link.claimed_device_id) {
          statements.deletePendingLinkedMember.run(
            link.room_id,
            link.claimed_device_id,
            link.authorizer_id,
          );
        }
        removed += statements.deleteDeviceLink.run(link.link_id).changes;
      }
      db.exec('COMMIT');
      return removed;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function saveMlsEvent(roomId, envelope) {
    db.exec('BEGIN IMMEDIATE');
    try {
      assertDeviceActive(roomId, envelope.senderId);
      const duplicate = statements.mlsEventById.get(roomId, envelope.eventId);
      if (duplicate) {
        if (duplicate.envelope !== JSON.stringify(envelope)) throw new Error('MLS_EVENT_CONFLICT');
        db.exec('COMMIT');
        return {
          eventSeq: duplicate.event_seq,
          event: JSON.parse(duplicate.envelope),
          acceptedAt: duplicate.accepted_at,
          duplicate: true,
        };
      }
      const room = statements.room.get(roomId);
      const sender = getMember(roomId, envelope.senderId);
      const target = getMember(roomId, envelope.targetId);
      if (!room || room.protocol !== 'mls-rfc9420') throw new Error('PROTOCOL_MISMATCH');
      if (!sender || sender.status !== 'active' || deviceRecoveryPending(roomId, sender.deviceId)) throw new Error('UNAUTHORIZED');
      if (envelope.previousEventSeq !== room.next_mls_event_seq) throw new Error('MLS_EVENT_STALE');
      if (envelope.action === 'add') {
        if (!target || target.status !== 'pending' || target.addedBy !== sender.deviceId || !envelope.target) {
          throw new Error('INVALID_MLS_EVENT');
        }
        const expected = canonicalStringify({
          deviceId: target.deviceId,
          encryptionKey: target.encryptionKey,
          signingKey: target.signingKey,
          mlsKeyPackage: target.mlsKeyPackage,
          role: target.role,
          joinProof: target.joinProof,
          deviceName: target.deviceName,
          status: target.status,
          addedBy: target.addedBy,
          joinSeq: target.joinSeq,
          joinReceiptSeq: target.joinReceiptSeq,
          lastSeenAt: target.lastSeenAt,
          revokedAt: target.revokedAt,
          capabilities: target.capabilities,
          createdAt: target.createdAt,
        });
        if (canonicalStringify(envelope.target) !== expected || !envelope.welcome) throw new Error('INVALID_MLS_EVENT');
        if (statements.memberCountForRole.get(roomId, target.role).count >= 3) throw new Error('DEVICE_LIMIT');
      } else if (envelope.action === 'replace') {
        const pending = db.prepare("SELECT * FROM recovery_requests WHERE room_id = ? AND request_id = ? AND status = 'pending' AND expires_at > ?")
          .get(roomId, envelope.recoveryRequest?.requestId ?? '', nowIso());
        const source = getMember(roomId, envelope.replacedDeviceId);
        if (!pending || pending.source_device_id !== source?.deviceId || source.status !== 'active' ||
          pending.replacement_device_id !== target?.deviceId || target.status !== 'pending' ||
          target.role !== source.role || target.addedBy !== source.deviceId || source.deviceId === sender.deviceId ||
          canonicalStringify(JSON.parse(pending.request)) !== canonicalStringify(envelope.recoveryRequest) ||
          canonicalStringify(target) !== canonicalStringify(envelope.target) || !envelope.welcome) {
          throw new Error('INVALID_RECOVERY_REQUEST');
        }
        if (statements.members.all(roomId).map(memberRow).some((member) =>
          member.status === 'active' && member.deviceId !== source.deviceId && !member.capabilities.includes('recovery-replace-v1'))) {
          throw new Error('RECOVERY_REQUIRES_UPGRADE');
        }
      } else {
        if (
          !target || target.status !== 'active' || target.deviceId === sender.deviceId ||
          target.role !== sender.role || envelope.target || envelope.welcome
        ) {
          throw new Error('INVALID_MLS_EVENT');
        }
        if (statements.memberCountForRole.get(roomId, target.role).count <= 1) throw new Error('LAST_ROLE_DEVICE');
      }
      const advanced = statements.nextMlsEventSeq.get(roomId, envelope.previousEventSeq);
      if (!advanced) throw new Error('MLS_EVENT_STALE');
      const acceptedAt = nowIso();
      statements.insertMlsEvent.run(
        roomId,
        advanced.next_mls_event_seq,
        envelope.eventId,
        envelope.senderId,
        envelope.targetId,
        envelope.action,
        JSON.stringify(envelope),
        acceptedAt,
      );
      if (envelope.action === 'add' || envelope.action === 'replace') {
        if (statements.activateMember.run(room.next_seq, room.next_receipt_seq, roomId, envelope.targetId).changes !== 1) {
          throw new Error('INVALID_MLS_EVENT');
        }
        if (envelope.action === 'replace') {
          if (statements.revokeMember.run(acceptedAt, roomId, envelope.replacedDeviceId).changes !== 1) throw new Error('INVALID_RECOVERY_REQUEST');
          statements.deletePushSubscription.run(roomId, envelope.replacedDeviceId);
          db.prepare("UPDATE recovery_requests SET status = 'completed' WHERE room_id = ? AND request_id = ?")
            .run(roomId, envelope.recoveryRequest.requestId);
        }
        const link = db.prepare('SELECT link_id FROM device_links WHERE room_id = ? AND claimed_device_id = ? AND used_at IS NULL')
          .get(roomId, envelope.targetId);
        if (link) statements.useDeviceLink.run(acceptedAt, link.link_id);
      } else {
        if (statements.revokeMember.run(acceptedAt, roomId, envelope.targetId).changes !== 1) {
          throw new Error('INVALID_MLS_EVENT');
        }
        statements.deletePushSubscription.run(roomId, envelope.targetId);
      }
      db.exec('COMMIT');
      return { eventSeq: advanced.next_mls_event_seq, event: envelope, acceptedAt, duplicate: false };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function mlsEventsAfter(roomId, afterEventSeq) {
    return statements.mlsEventsAfter.all(roomId, afterEventSeq).map((event) => ({
      eventSeq: event.event_seq,
      event: JSON.parse(event.envelope),
      acceptedAt: event.accepted_at,
    }));
  }

  function deviceRecoveryPending(roomId, deviceId) {
    return Boolean(db.prepare("SELECT 1 FROM recovery_requests WHERE room_id = ? AND source_device_id = ? AND status = 'pending' AND expires_at > ?")
      .get(roomId, deviceId, nowIso()));
  }

  function assertDeviceActive(roomId, deviceId) {
    if (!deviceId || getMember(roomId, deviceId)?.status !== 'active' || deviceRecoveryPending(roomId, deviceId)) {
      throw new Error('UNAUTHORIZED');
    }
  }

  function cleanupExpiredRecoveryRequests() {
    const expired = db.prepare("SELECT room_id, request_id, source_device_id, replacement_device_id FROM recovery_requests WHERE status = 'pending' AND expires_at <= ?").all(nowIso());
    if (!expired.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of expired) {
        statements.deletePendingLinkedMember.run(row.room_id, row.replacement_device_id, row.source_device_id);
        db.prepare("UPDATE recovery_requests SET status = 'expired' WHERE room_id = ? AND request_id = ?").run(row.room_id, row.request_id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  // Called only after the HTTP boundary verifies the old identity's signature.
  // The signed request binds the fresh identity, token hash, expiry, and room.
  function createRecoveryRequest(roomId, request, accessToken, deviceName, capabilities) {
    cleanupExpiredRecoveryRequests();
    if (!validToken(accessToken) || hashToken(accessToken).toString('base64url') !== request.tokenHash) throw new Error('INVALID_RECOVERY_REQUEST');
    const serialized = canonicalStringify(request);
    const previous = db.prepare('SELECT * FROM recovery_requests WHERE room_id = ? AND request_id = ?').get(roomId, request.requestId);
    if (previous) {
      if (previous.request !== serialized || previous.status === 'expired') throw new Error('INVALID_RECOVERY_REQUEST');
      if (previous.status === 'completed' && !authenticatedDevice(roomId, accessToken, previous.replacement_device_id)) throw new Error('UNAUTHORIZED');
      return roomState(roomId);
    }
    const expires = Date.parse(request.expiresAt);
    if (!isCanonicalUtcTimestamp(request.expiresAt) || expires <= Date.now() || expires > Date.now() + 15 * 60_000) throw new Error('INVALID_RECOVERY_REQUEST');
    db.exec('BEGIN IMMEDIATE');
    try {
      const room = statements.room.get(roomId);
      const source = getMember(roomId, request.sourceDeviceId);
      if (!room || room.protocol !== 'mls-rfc9420' || !room.mls_welcome || !source || source.status !== 'active') throw new Error('INVALID_RECOVERY_REQUEST');
      if (db.prepare("SELECT 1 FROM recovery_requests WHERE room_id = ? AND status = 'pending'").get(roomId)) throw new Error('RECOVERY_ALREADY_PENDING');
      const helpers = statements.members.all(roomId).map(memberRow).filter((member) => member.status === 'active' && member.deviceId !== source.deviceId);
      if (!helpers.length || helpers.some((member) => !member.capabilities.includes('recovery-replace-v1')) || !capabilities.includes('recovery-replace-v1')) {
        throw new Error('RECOVERY_REQUIRES_UPGRADE');
      }
      if (statements.member.get(roomId, request.replacement.deviceId)) throw new Error('INVALID_RECOVERY_REQUEST');
      const createdAt = nowIso();
      const bundle = request.replacement;
      statements.insertMember.run(roomId, bundle.deviceId, source.role, JSON.stringify(bundle.encryptionKey),
        JSON.stringify(bundle.signingKey), bundle.mlsKeyPackage, null, hashToken(accessToken), deviceName,
        'pending', source.deviceId, 0, 0, JSON.stringify(capabilities), createdAt);
      db.prepare(`INSERT INTO recovery_requests(room_id, request_id, source_device_id, replacement_device_id,
        token_hash, request, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(roomId, request.requestId, source.deviceId, bundle.deviceId, hashToken(accessToken), serialized, request.expiresAt, createdAt);
      db.exec('COMMIT');
      return roomState(roomId);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function recoveryStatus(roomId, requestId, token) {
    cleanupExpiredRecoveryRequests();
    const row = db.prepare('SELECT * FROM recovery_requests WHERE room_id = ? AND request_id = ?').get(roomId, requestId);
    if (!row || !validToken(token)) throw new Error('UNAUTHORIZED');
    const digest = hashToken(token);
    if (!timingSafeEqual(Buffer.from(row.token_hash), digest)) throw new Error('UNAUTHORIZED');
    if (row.status === 'expired') throw new Error('RECOVERY_EXPIRED');
    if (row.status === 'completed' && !authenticatedDevice(roomId, token, row.replacement_device_id)) throw new Error('UNAUTHORIZED');
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
    if (getMember(roomId, deviceId)?.status !== 'active') throw new Error('MEMBER_NOT_FOUND');
    assertDeviceActive(roomId, deviceId);
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
    assertDeviceActive(roomId, deviceId);
    return statements.deletePushSubscription.run(roomId, deviceId).changes > 0;
  }

  function deletePushSubscriptionByEndpoint(endpoint) {
    return statements.deletePushSubscriptionByEndpoint.run(endpoint).changes > 0;
  }

  function saveUnreadObserver(roomId, deviceId, { token, readSeq } = {}) {
    assertDeviceActive(roomId, deviceId);
    const member = getMember(roomId, deviceId);
    const room = statements.room.get(roomId);
    const previous = statements.unreadObserver.get(roomId, deviceId);
    if ((token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token))) ||
      (readSeq !== undefined && (!Number.isSafeInteger(readSeq) || readSeq < 0)) ||
      (!previous && token === undefined)) throw new Error('INVALID_UNREAD_OBSERVER');
    const digest = token === undefined ? previous.token_hash : hashToken(token);
    // A count-only credential must never be an existing room or device key.
    if (Buffer.from(room.access_hash).equals(Buffer.from(digest)) || db.prepare('SELECT 1 FROM members WHERE access_hash = ?').get(digest)) {
      throw new Error('INVALID_UNREAD_OBSERVER');
    }
    const cursor = Math.max(member.joinSeq ?? 0, Math.min(readSeq ?? previous?.read_seq ?? 0, room.next_seq));
    statements.upsertUnreadObserver.run(roomId, deviceId, digest, cursor);
    return { count: statements.unreadCount.get(roomId, Math.max(cursor, previous?.read_seq ?? 0), member.role).count };
  }

  function unreadCount(roomId, deviceId, token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('UNAUTHORIZED');
    assertDeviceActive(roomId, deviceId);
    const observer = statements.unreadObserver.get(roomId, deviceId);
    if (!observer || !timingSafeEqual(Buffer.from(observer.token_hash), hashToken(token))) throw new Error('UNAUTHORIZED');
    const member = getMember(roomId, deviceId);
    return { count: statements.unreadCount.get(roomId, Math.max(observer.read_seq, member.joinSeq ?? 0), member.role).count };
  }

  function insertMessage(roomId, envelope, countUnread = true) {
    if (typeof countUnread !== 'boolean') throw new Error('INVALID_MESSAGE');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (getMember(roomId, envelope.senderId)?.status !== 'active' || deviceRecoveryPending(roomId, envelope.senderId)) throw new Error('UNAUTHORIZED');
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
        countUnread ? 1 : 0,
      );
      statements.incrementMessageUsage.run(envelopeBytes, roomId);
      db.exec('COMMIT');
      return { seq, acceptedAt, envelope, duplicate: false };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function messagesAfter(roomId, afterSeq, limit = 500, deviceId) {
    const joinSeq = deviceId ? getMember(roomId, deviceId)?.joinSeq ?? Number.MAX_SAFE_INTEGER : 0;
    return statements.messagesAfter.all(roomId, afterSeq, joinSeq, Math.min(Math.max(limit, 1), 500)).map((row) => ({
      seq: row.server_seq,
      envelope: JSON.parse(row.envelope),
      acceptedAt: row.accepted_at,
    }));
  }

  function insertReceipt(roomId, receipt) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const message = statements.messageBySeq.get(roomId, receipt.seq);
      const sender = message ? getMember(roomId, message.sender_device_id) : null;
      const receiver = getMember(roomId, receipt.receiverId);
      if (
        !message ||
        message.client_msg_id !== receipt.clientMsgId ||
        !sender ||
        !receiver ||
        receiver.status !== 'active' ||
        deviceRecoveryPending(roomId, receiver.deviceId) ||
        sender.role === receiver.role
      ) {
        throw new Error('INVALID_RECEIPT');
      }
      const existing = statements.receiptByClientId.get(roomId, receipt.clientMsgId, receipt.receiverId);
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

  function receiptsAfter(roomId, afterReceiptSeq, limit = 500, deviceId) {
    const member = deviceId ? getMember(roomId, deviceId) : null;
    const joinReceiptSeq = deviceId ? member?.joinReceiptSeq ?? Number.MAX_SAFE_INTEGER : 0;
    const joinSeq = member?.joinSeq ?? 0;
    return statements.receiptsAfter.all(roomId, afterReceiptSeq, joinReceiptSeq, Math.min(Math.max(limit, 1), 500)).map((row) =>
      deviceId && row.message_seq <= joinSeq
        ? { receiptSeq: row.receipt_seq, skipped: true, acceptedAt: row.accepted_at }
        : { receiptSeq: row.receipt_seq, receipt: JSON.parse(row.receipt), acceptedAt: row.accepted_at });
  }

  function createBlob(roomId, blobId, chunkCount, expectedBytes, actorId) {
    assertDeviceActive(roomId, actorId);
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

  async function putBlobChunk(roomId, blobId, index, bytes, actorId) {
    return withBlobLock(roomId, blobId, async () => {
      assertDeviceActive(roomId, actorId);
      const blob = statements.blob.get(roomId, blobId);
      if (!blob || blob.completed || index < 0 || index >= blob.chunk_count || bytes.length < 17) {
        throw new Error('INVALID_BLOB');
      }
      const targetDir = path.join(blobDir, roomId, blobId);
      await mkdir(targetDir, { recursive: true });
      assertDeviceActive(roomId, actorId);
      const target = path.join(targetDir, `${String(index).padStart(8, '0')}.bin`);
      let alreadyExists = false;
      await writeFile(target, bytes, { flag: 'wx' }).catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
        alreadyExists = true;
        const existing = await readFile(target);
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw new Error('CHUNK_CONFLICT');
      });

      // A recovery request may fence this actor while filesystem I/O yields.
      // Discard only bytes created by this attempt; never remove an existing
      // immutable chunk or acknowledge a fenced actor's write.
      try { assertDeviceActive(roomId, actorId); }
      catch (error) {
        if (!alreadyExists) await rm(target, { force: true });
        throw error;
      }

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

  async function completeBlob(roomId, blobId, actorId) {
    return withBlobLock(roomId, blobId, async () => {
      assertDeviceActive(roomId, actorId);
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
      assertDeviceActive(roomId, actorId);
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

  async function cleanupDeletedRooms() {
    for (const roomId of cloudBackups.pendingCleanup()) {
      // The room row is already gone, fencing new writers. Drain writes that
      // had passed authentication before the delete, then remove originals.
      await Promise.allSettled([...blobLocks.entries()].filter(([key]) => key.startsWith(`${roomId}:`)).map(([, promise]) => promise));
      await rm(path.join(blobDir, roomId), { recursive: true, force: true });
      cloudBackups.finishCleanup(roomId);
    }
  }

  function cleanupOrphanRooms(cutoffIso) {
    const rooms = statements.orphanRooms.all(cutoffIso);
    let removed = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const room of rooms) {
        removed += db.prepare('DELETE FROM rooms WHERE room_id = ? AND sealed_at IS NULL AND NOT EXISTS (SELECT 1 FROM recovery_backups WHERE room_id = rooms.room_id)').run(room.room_id).changes;
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
    cloudBackups,
    cleanupDeletedRooms,
    authenticate,
    authenticateInvite,
    authenticatedDevice,
    deviceRecoveryPending,
    createRecoveryRequest,
    recoveryStatus,
    cleanupExpiredRecoveryRequests,
    updateMemberCapabilities,
    blobStatus,
    cleanupExpiredBlobs,
    cleanupExpiredDeviceLinks,
    cleanupOrphanRooms,
    completeBlob,
    createBlob,
    createRoom,
    createDeviceLink,
    deleteRoom,
    getBlobChunk,
    getMember,
    getMessage,
    healthCheck,
    insertMessage,
    insertReceipt,
    joinRoom,
    claimDeviceLink,
    deviceLinkStatus,
    deviceLinksForRoom,
    messagesAfter,
    mlsEventsAfter,
    putBlobChunk,
    pushSubscriptionsForRoom,
    receiptsAfter,
    roomState,
    savePushSubscription,
    saveUnreadObserver,
    unreadCount,
    saveMlsWelcome,
    saveMlsEvent,
    deletePushSubscription,
    deletePushSubscriptionByEndpoint,
    close: () => db.close(),
  };
}
