import { canonicalStringify } from './protocol.mjs';
import { verifyChamberHistoryRecord, verifyPersonalDeviceBinding, personalHash } from './personal-protocol.mjs';
import { webcrypto } from 'node:crypto';

/** Immutable ciphertext units; retained independently of whether the room is open. */
export function createChamberHistory(db, { getMember, chamberInvitations }) {
  db.exec(`CREATE TABLE IF NOT EXISTS chamber_history (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL, owner_id TEXT NOT NULL, device_id TEXT NOT NULL,
    revision INTEGER NOT NULL, record TEXT NOT NULL, byte_count INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(room_id,unit_id)
  ); CREATE INDEX IF NOT EXISTS chamber_history_owner ON chamber_history(room_id,owner_id,device_id,revision);`);
  db.exec(`CREATE TABLE IF NOT EXISTS chamber_history_heads (room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,device_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(room_id,device_id));`);
  const identities = (roomId, member) => {
    const state = chamberInvitations.state(roomId);
    if (!state?.joinerBinding) throw new Error('ROOM_SEALED');
    return member.role === 'creator' ? [state.creatorBinding.identity, state.joinerBinding.identity] : [state.joinerBinding.identity, state.creatorBinding.identity];
  };
  return {
    async saveHead(roomId, deviceId, value) {
      const member = getMember(roomId, deviceId);
      if (!member || member.status !== 'active') throw new Error('UNAUTHORIZED');
      const [owner] = identities(roomId, member), h = value?.head;
      if (!value || Object.keys(value).sort().join(',') !== 'author,head,ownerId,purpose,roomId,signature,v' || value.v !== 1 ||
        value.purpose !== 'chamber-history-head-v1' || value.roomId !== roomId || value.ownerId !== owner.id ||
        !h || Object.keys(h).sort().join(',') !== 'afterSeq,deviceId,digest,id,revision,upperSeq' || h.deviceId !== deviceId ||
        !/^[A-Za-z0-9_-]{43}$/.test(h.id) || !/^[A-Za-z0-9_-]{43}$/.test(h.digest) || !Number.isSafeInteger(h.revision) || h.revision < 1 ||
        !Number.isSafeInteger(h.afterSeq) || h.afterSeq < 0 || !Number.isSafeInteger(h.upperSeq) || h.upperSeq < h.afterSeq ||
        Object.keys(value.author).sort().join(',') !== 'binding,bundle' || value.author.bundle.deviceId !== deviceId ||
        canonicalStringify(value.author.binding.identity) !== canonicalStringify(owner) ||
        canonicalStringify(value.author.bundle.signingKey) !== canonicalStringify(member.signingKey) ||
        !await verifyPersonalDeviceBinding(value.author.binding, value.author.bundle) || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) throw new Error('INVALID_BACKUP');
      const { signature, ...unsigned } = value;
      const key = await webcrypto.subtle.importKey('jwk', member.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature, 'base64url'), Buffer.from(canonicalStringify(unsigned)))) throw new Error('INVALID_BACKUP');
      const serialized = canonicalStringify(value);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (getMember(roomId, deviceId)?.status !== 'active') throw new Error('UNAUTHORIZED');
        const unit = db.prepare('SELECT * FROM chamber_history WHERE room_id=? AND unit_id=?').get(roomId, h.id);
        if (!unit || unit.owner_id !== owner.id || unit.device_id !== deviceId || unit.revision !== h.revision || personalHash(JSON.parse(unit.record)) !== h.digest) throw new Error('INVALID_BACKUP');
        const before = db.prepare('SELECT revision,record FROM chamber_history_heads WHERE room_id=? AND device_id=?').get(roomId, deviceId);
        if (before?.record === serialized) { db.exec('COMMIT'); return { saved: true }; }
        if (before && before.revision >= h.revision) throw new Error('BACKUP_CONFLICT');
        if (!before && db.prepare('SELECT COUNT(*) AS n FROM chamber_history_heads WHERE room_id=? AND owner_id=?').get(roomId, owner.id).n >= 1000) throw new Error('BACKUP_QUOTA');
        db.prepare('INSERT INTO chamber_history_heads VALUES(?,?,?,?,?) ON CONFLICT(room_id,device_id) DO UPDATE SET revision=excluded.revision,record=excluded.record')
          .run(roomId, owner.id, deviceId, h.revision, serialized);
        db.exec('COMMIT'); return { saved: true };
      } catch (cause) { db.exec('ROLLBACK'); throw cause; }
    },
    heads(roomId, ownerId, after = 0) {
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('INVALID_BACKUP');
      return db.prepare('SELECT rowid AS cursor,record FROM chamber_history_heads WHERE room_id=? AND owner_id=? AND rowid>? ORDER BY rowid LIMIT 100')
        .all(roomId, ownerId, after).map(row => ({ cursor: row.cursor, record: JSON.parse(row.record) }));
    },
    async save(roomId, deviceId, record) {
      const member = getMember(roomId, deviceId);
      if (!member || member.status !== 'active' || record?.roomId !== roomId) throw new Error('UNAUTHORIZED');
      const [owner, peer] = identities(roomId, member);
      if (!await verifyChamberHistoryRecord(record, owner, peer, member)) throw new Error('INVALID_BACKUP');
      const serialized = canonicalStringify(record), size = Buffer.byteLength(serialized);
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = getMember(roomId, deviceId);
        if (!current || current.status !== 'active' || canonicalStringify(current.signingKey) !== canonicalStringify(member.signingKey) ||
          canonicalStringify(identities(roomId, current)) !== canonicalStringify([owner, peer])) throw new Error('UNAUTHORIZED');
        const previous = db.prepare('SELECT record FROM chamber_history WHERE room_id=? AND unit_id=?').get(roomId, record.id);
        if (previous) {
          if (previous.record !== serialized) throw new Error('BACKUP_CONFLICT');
          db.exec('COMMIT'); return { saved: true };
        }
        const roomBytes = db.prepare('SELECT COALESCE(SUM(byte_count),0) AS bytes FROM chamber_history WHERE room_id=?').get(roomId).bytes;
        const totalBytes = db.prepare('SELECT COALESCE(SUM(byte_count),0) AS bytes FROM chamber_history').get().bytes;
        const legacyRoomBytes = db.prepare('SELECT COALESCE(SUM(byte_count),0) AS bytes FROM history_archives WHERE room_id=?').get(roomId).bytes;
        const legacyTotalBytes = db.prepare('SELECT COALESCE(SUM(byte_count),0) AS bytes FROM history_archives').get().bytes;
        if (size > 4_300_000 || roomBytes + legacyRoomBytes + size > 512 * 1024 ** 2 || totalBytes + legacyTotalBytes + size > 5 * 1024 ** 3) throw new Error('BACKUP_QUOTA');
        db.prepare('INSERT INTO chamber_history VALUES(?,?,?,?,?,?,?,?)').run(roomId, record.id, owner.id, deviceId, record.revision, serialized, size, new Date().toISOString());
        db.exec('COMMIT'); return { saved: true };
      } catch (cause) { db.exec('ROLLBACK'); throw cause; }
    },
    read(roomId, unitId) {
      const row = db.prepare('SELECT record FROM chamber_history WHERE room_id=? AND unit_id=?').get(roomId, unitId);
      if (!row) throw new Error('BACKUP_NOT_FOUND'); return JSON.parse(row.record);
    },
    list(roomId, ownerId, after = 0) {
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('INVALID_BACKUP');
      return db.prepare("SELECT rowid AS cursor,unit_id AS id,device_id AS deviceId,revision,json_extract(record,'$.keyEnvelope') AS envelope FROM chamber_history WHERE room_id=? AND owner_id=? AND rowid>? ORDER BY rowid LIMIT 100")
        .all(roomId, ownerId, after).map(row => ({ ...row, envelope: JSON.parse(row.envelope) }));
    },
  };
}
