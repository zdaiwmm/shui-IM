import { createHash, timingSafeEqual } from 'node:crypto';

const tokenHash = value => createHash('sha256').update(value).digest();
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const backupId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
const sameToken = (value, expected) => validId(value) && expected?.length === 32 && timingSafeEqual(tokenHash(value), expected);
const fail = code => { throw new Error(code); };
function sealedValue(value) {
  if (!value || typeof value.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(value.iv) ||
      typeof value.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{22,1800000}$/.test(value.ciphertext) ||
      Object.keys(value).sort().join(',') !== 'ciphertext,iv') fail('INVALID_BACKUP');
  return JSON.stringify({ iv: value.iv, ciphertext: value.ciphertext });
}

/** The database holds ciphertext and scoped capability hashes, never recovery codes or archive keys. */
export function createCloudBackups(db, { authenticatedDevice }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_backups (
      backup_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      fetch_hash BLOB NOT NULL,
      sealed TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(room_id, device_id) REFERENCES members(room_id, device_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_device_backup ON recovery_backups(room_id, device_id) WHERE active = 1;
    CREATE TABLE IF NOT EXISTS history_archives (
      archive_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
      backup_id TEXT NOT NULL REFERENCES recovery_backups(backup_id) ON DELETE CASCADE,
      read_hash BLOB NOT NULL,
      writable INTEGER NOT NULL,
      byte_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS history_archive_parts (
      archive_id TEXT NOT NULL REFERENCES history_archives(archive_id) ON DELETE CASCADE,
      part_id TEXT NOT NULL,
      sealed TEXT NOT NULL,
      PRIMARY KEY(archive_id, part_id)
    );
    CREATE TABLE IF NOT EXISTS admin_events (
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      room_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_room_cleanup (room_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS admin_totp_counters (config_id TEXT PRIMARY KEY, counter INTEGER NOT NULL);
  `);
  const row = id => db.prepare('SELECT * FROM recovery_backups WHERE backup_id = ?').get(id);
  const archiveRow = id => db.prepare('SELECT * FROM history_archives WHERE archive_id = ?').get(id);

  function save(roomId, deviceToken, value) {
    const member = authenticatedDevice(roomId, deviceToken);
    if (!member) fail('UNAUTHORIZED');
    if (!value || !backupId(value.id) || !validId(value.fetchToken) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        !Array.isArray(value.archives) || value.archives.length < 1 || value.archives.length > 100 ||
        value.archives.some(a => !validId(a.id) || !validId(a.token) || typeof a.writable !== 'boolean' || Object.keys(a).sort().join(',') !== 'id,token,writable') ||
        new Set(value.archives.map(a => a.id)).size !== value.archives.length || value.archives.filter(a => a.writable).length !== 1 ||
        (value.replaces !== undefined && !backupId(value.replaces)) ||
        Object.keys(value).some(key => !['id', 'revision', 'fetchToken', 'sealed', 'archives', 'replaces'].includes(key))) fail('INVALID_BACKUP');
    const sealed = sealedValue(value.sealed);
    const requestHash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = row(value.id);
      if (current) {
        if (current.room_id !== roomId || current.device_id !== member.deviceId || !current.active) fail('BACKUP_CONFLICT');
        if (current.revision === value.revision && current.request_hash === requestHash) {
          db.exec('COMMIT'); return { revision: current.revision, updatedAt: current.updated_at };
        }
        if (value.revision !== current.revision + 1 || !sameToken(value.fetchToken, current.fetch_hash)) fail('BACKUP_CONFLICT');
      } else if (value.revision !== 1 || db.prepare('SELECT 1 FROM recovery_backups WHERE room_id = ? AND device_id = ? AND active = 1').get(roomId, member.deviceId)) {
        fail('BACKUP_CONFLICT');
      }
      const source = !current && value.replaces ? row(value.replaces) : null;
      if (!current && value.replaces && (!source?.active || source.room_id !== roomId ||
          !db.prepare("SELECT 1 FROM recovery_requests WHERE room_id = ? AND source_device_id = ? AND replacement_device_id = ? AND status = 'completed'")
            .get(roomId, source.device_id, member.deviceId))) fail('INVALID_BACKUP_REPLACEMENT');
      const existing = db.prepare('SELECT archive_id FROM history_archives WHERE backup_id = ?').all(source?.backup_id ?? value.id);
      if (existing.some(a => !value.archives.some(next => next.id === a.archive_id))) fail('BACKUP_ARCHIVE_MISSING');
      for (const archive of value.archives) {
        const previous = archiveRow(archive.id);
        if (previous && (previous.room_id !== roomId || previous.backup_id !== (source?.backup_id ?? value.id) ||
            (source && archive.writable) || (!source && (Boolean(previous.writable) !== archive.writable || !sameToken(archive.token, previous.read_hash))))) fail('BACKUP_ARCHIVE_CONFLICT');
        if (!previous && !archive.writable) fail('INVALID_BACKUP');
      }
      const now = new Date().toISOString();
      if (!current) db.prepare('INSERT INTO recovery_backups(backup_id,room_id,device_id,revision,fetch_hash,sealed,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(value.id, roomId, member.deviceId, value.revision, tokenHash(value.fetchToken), sealed, requestHash, now, now);
      else db.prepare('UPDATE recovery_backups SET revision = ?, sealed = ?, request_hash = ?, updated_at = ? WHERE backup_id = ?')
        .run(value.revision, sealed, requestHash, now, value.id);
      for (const archive of value.archives) {
        db.prepare(`INSERT INTO history_archives(archive_id,room_id,backup_id,read_hash,writable) VALUES(?,?,?,?,?)
          ON CONFLICT(archive_id) DO UPDATE SET backup_id=excluded.backup_id, read_hash=excluded.read_hash, writable=excluded.writable`)
          .run(archive.id, roomId, value.id, tokenHash(archive.token), Number(archive.writable));
      }
      // Rotation is one transaction. A lost response can retry the exact new request.
      if (source) db.prepare("UPDATE recovery_backups SET active = 0, sealed = '', fetch_hash = zeroblob(32), updated_at = ? WHERE backup_id = ?").run(now, source.backup_id);
      db.exec('COMMIT');
      return { revision: value.revision, updatedAt: now };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function fetch(id, token) {
    const backup = row(id);
    if (!backup?.active || !sameToken(token, backup.fetch_hash)) fail('BACKUP_UNAVAILABLE');
    const member = db.prepare('SELECT status FROM members WHERE room_id = ? AND device_id = ?').get(backup.room_id, backup.device_id);
    // A completed replacement may still be waiting to upload the new wrapper.
    const recoverableReplacement = db.prepare("SELECT 1 FROM recovery_requests WHERE room_id = ? AND source_device_id = ? AND status = 'completed'").get(backup.room_id, backup.device_id);
    if (member?.status !== 'active' && !recoverableReplacement) fail('BACKUP_UNAVAILABLE');
    return { revision: backup.revision, sealed: JSON.parse(backup.sealed) };
  }

  function putPart(roomId, deviceToken, archiveId, partId, sealedInput) {
    const member = authenticatedDevice(roomId, deviceToken);
    if (!member) fail('UNAUTHORIZED');
    const archive = archiveRow(archiveId);
    const backup = archive && row(archive.backup_id);
    if (!validId(partId) || !archive?.writable || archive.room_id !== roomId || !backup?.active || backup.device_id !== member.deviceId) fail('UNAUTHORIZED');
    const sealed = sealedValue(sealedInput);
    const previous = db.prepare('SELECT sealed FROM history_archive_parts WHERE archive_id = ? AND part_id = ?').get(archiveId, partId);
    if (previous) { if (previous.sealed !== sealed) fail('BACKUP_CONFLICT'); return { stored: true }; }
    const bytes = Buffer.byteLength(sealed);
    const roomBytes = db.prepare('SELECT COALESCE(SUM(byte_count),0) AS size FROM history_archives WHERE room_id = ?').get(roomId).size;
    const totalBytes = db.prepare('SELECT COALESCE(SUM(byte_count),0) AS size FROM history_archives').get().size;
    if (roomBytes + bytes > 512 * 1024 * 1024 || totalBytes + bytes > 5 * 1024 * 1024 * 1024) fail('BACKUP_QUOTA');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO history_archive_parts VALUES(?,?,?)').run(archiveId, partId, sealed);
      db.prepare('UPDATE history_archives SET byte_count = byte_count + ? WHERE archive_id = ?').run(bytes, archiveId);
      db.exec('COMMIT'); return { stored: true };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function getPart(archiveId, partId, token) {
    const archive = archiveRow(archiveId);
    const backup = archive && row(archive.backup_id);
    if (!archive || !backup?.active || !sameToken(token, archive.read_hash)) fail('BACKUP_UNAVAILABLE');
    const owner = db.prepare('SELECT status FROM members WHERE room_id=? AND device_id=?').get(backup.room_id, backup.device_id);
    if (owner?.status !== 'active' && !db.prepare("SELECT 1 FROM recovery_requests WHERE room_id=? AND source_device_id=? AND status='completed'").get(backup.room_id, backup.device_id)) fail('BACKUP_UNAVAILABLE');
    const part = db.prepare('SELECT sealed FROM history_archive_parts WHERE archive_id = ? AND part_id = ?').get(archiveId, partId);
    if (!part) fail('BACKUP_UNAVAILABLE');
    return JSON.parse(part.sealed);
  }

  function rooms(offset = 0) {
    return db.prepare(`SELECT r.room_id AS roomId,r.created_at AS createdAt,r.sealed_at AS sealedAt,r.message_count AS messageCount,
      (SELECT COUNT(*) FROM members m WHERE m.room_id=r.room_id AND m.status='active') AS devices,
      (SELECT COUNT(*) FROM recovery_backups b WHERE b.room_id=r.room_id AND b.active=1) AS backups,
      (SELECT MAX(last_seen_at) FROM members m WHERE m.room_id=r.room_id) AS lastSeenAt
      FROM rooms r ORDER BY r.created_at DESC LIMIT 50 OFFSET ?`).all(offset);
  }

  function room(roomId) {
    if (!db.prepare('SELECT 1 FROM rooms WHERE room_id=?').get(roomId)) fail('BACKUP_UNAVAILABLE');
    const devices = db.prepare(`SELECT device_id AS deviceId,role,device_name AS name,status,last_seen_at AS lastSeenAt,created_at AS createdAt
      FROM members WHERE room_id=? ORDER BY role,created_at`).all(roomId);
    const backups = db.prepare(`SELECT b.backup_id AS id,b.device_id AS deviceId,b.revision,b.active,b.updated_at AS updatedAt,
      LENGTH(b.sealed) AS recoveryBytes,(SELECT COALESCE(SUM(a.byte_count),0) FROM history_archives a WHERE a.backup_id=b.backup_id) AS historyBytes
      FROM recovery_backups b WHERE b.room_id=? ORDER BY b.created_at`).all(roomId);
    return { roomId, devices, backups };
  }

  function deleteRoom(roomId) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO pending_room_cleanup VALUES(?)').run(roomId);
      const result = db.prepare('DELETE FROM rooms WHERE room_id=?').run(roomId);
      db.prepare('INSERT INTO admin_events(action,room_id,created_at) VALUES(?,?,?)').run('delete-room', roomId, new Date().toISOString());
      db.exec('COMMIT'); return { deleted: Boolean(result.changes) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  return { save, fetch, putPart, getPart, rooms, room, deleteRoom,
    adminCounter: id => db.prepare('SELECT counter FROM admin_totp_counters WHERE config_id=?').get(id)?.counter ?? -1,
    consumeAdminCounter: (id, counter) => Boolean(db.prepare(`INSERT INTO admin_totp_counters VALUES(?,?)
      ON CONFLICT(config_id) DO UPDATE SET counter=excluded.counter WHERE excluded.counter > admin_totp_counters.counter`).run(id, counter).changes),
    pendingCleanup: () => db.prepare('SELECT room_id FROM pending_room_cleanup').all().map(r => r.room_id),
    finishCleanup: id => db.prepare('DELETE FROM pending_room_cleanup WHERE room_id=?').run(id) };
}
