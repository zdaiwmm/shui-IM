import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalStringify } from './protocol.mjs';
import { validPersonalIdentity, verifyPersonalDirectoryRecord, verifyPersonalProof } from './personal-protocol.mjs';

/** Public roots and encrypted directory entries only. Fresh challenges are atomically consumed. */
export function createPersonalDirectory(db, { getMember, chamberInvitations }) {
  db.exec(`CREATE TABLE IF NOT EXISTS chamber_identities (identity_id TEXT PRIMARY KEY, identity TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chamber_directory (identity_id TEXT NOT NULL REFERENCES chamber_identities(identity_id),
      room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, revision INTEGER NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY(identity_id,room_id));
    CREATE TABLE IF NOT EXISTS chamber_challenges (request_id TEXT PRIMARY KEY,identity_id TEXT NOT NULL,
      proof TEXT NOT NULL,expires_at TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);`);
  const identity = id => {
    const row = db.prepare('SELECT identity FROM chamber_identities WHERE identity_id=?').get(id);
    return row ? JSON.parse(row.identity) : null;
  };
  const owner = (roomId, member) => {
    const state = chamberInvitations.state(roomId);
    return member.role === 'creator' ? state?.creatorBinding.identity : state?.joinerBinding?.identity;
  };
  function register(publicIdentity) {
    if (!validPersonalIdentity(publicIdentity)) throw new Error('INVALID_BACKUP');
    db.prepare('INSERT OR IGNORE INTO chamber_identities VALUES(?,?)').run(publicIdentity.id, canonicalStringify(publicIdentity));
  }
  function challenge(identityId, input) {
    if (!identity(identityId)) throw new Error('PERSONAL_IDENTITY_NOT_FOUND');
    if (!input || Object.keys(input).sort().join(',') !== 'action,deviceId,payloadHash,roomId,version' ||
      !['bind-device', 'bind-legacy-room', 'read-directory', 'close-room', 'restore-room', 'restore-history'].includes(input.action) ||
      ![input.roomId, input.deviceId].every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s)) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || !/^[A-Za-z0-9_-]{43}$/.test(input.payloadHash)) throw new Error('INVALID_JSON');
    const now = new Date().toISOString();
    db.prepare('DELETE FROM chamber_challenges WHERE expires_at<=?').run(now);
    if (db.prepare('SELECT COUNT(*) AS n FROM chamber_challenges').get().n >= 10_000 ||
      db.prepare('SELECT COUNT(*) AS n FROM chamber_challenges WHERE identity_id=? AND consumed=0').get(identityId).n >= 20) throw new Error('RATE_LIMITED');
    const proof = { v: 1, purpose: 'chamber-personal-proof-v1', ...input, identityId, requestId: randomUUID(),
      challenge: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    db.prepare('INSERT INTO chamber_challenges(request_id,identity_id,proof,expires_at) VALUES(?,?,?,?)').run(proof.requestId, identityId, canonicalStringify(proof), proof.expiresAt);
    return proof;
  }
  /** operation must be synchronous SQL inside this transaction, with an explicit expected action. */
  function authorize(proof, signature, action, operation) {
    const root = identity(proof?.identityId);
    if (proof?.action !== action || !verifyPersonalProof(root, proof, signature)) throw new Error('UNAUTHORIZED');
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM chamber_challenges WHERE request_id=?').get(proof.requestId);
      if (!row || row.consumed || row.identity_id !== root.id || row.proof !== canonicalStringify(proof) || Date.parse(row.expires_at) <= Date.now()) throw new Error('PERSONAL_PROOF_EXPIRED');
      const result = operation(root);
      if (result && typeof result.then === 'function') throw new Error('INVALID_JSON');
      db.prepare('UPDATE chamber_challenges SET consumed=1 WHERE request_id=? AND consumed=0').run(proof.requestId);
      db.exec('COMMIT'); return result;
    } catch (cause) { db.exec('ROLLBACK'); throw cause; }
  }
  return {
    register, identity, challenge, authorize,
    revision(roomId, deviceId) {
      const member = getMember(roomId, deviceId), root = member && owner(roomId, member);
      if (!member || member.status !== 'active' || !root) throw new Error('UNAUTHORIZED');
      return db.prepare('SELECT revision FROM chamber_directory WHERE room_id=? AND identity_id=?').get(roomId, root.id)?.revision ?? 0;
    },
    async save(roomId, deviceId, record) {
      const member = getMember(roomId, deviceId), root = member && owner(roomId, member);
      if (!member || member.status !== 'active' || !root || record?.roomId !== roomId || !await verifyPersonalDirectoryRecord(record, root, member)) throw new Error('INVALID_BACKUP');
      const serialized = canonicalStringify(record);
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = getMember(roomId, deviceId);
        if (!current || current.status !== 'active' || canonicalStringify(current.signingKey) !== canonicalStringify(member.signingKey) ||
          canonicalStringify(owner(roomId, current)) !== canonicalStringify(root)) throw new Error('UNAUTHORIZED');
        register(root);
        const before = db.prepare('SELECT revision,record FROM chamber_directory WHERE identity_id=? AND room_id=?').get(root.id, roomId);
        if (before?.record === serialized) { db.exec('COMMIT'); return { revision: before.revision }; }
        if (record.revision !== (before?.revision ?? 0) + 1) throw new Error('BACKUP_CONFLICT');
        const bytes = db.prepare('SELECT COALESCE(SUM(length(record)),0) AS bytes FROM chamber_directory WHERE identity_id=? AND room_id<>?').get(root.id, roomId).bytes;
        if (bytes + Buffer.byteLength(serialized) > 8 * 1024 ** 2) throw new Error('BACKUP_QUOTA');
        if (!before && db.prepare('SELECT COUNT(*) AS n FROM chamber_directory WHERE identity_id=?').get(root.id).n >= 256) throw new Error('BACKUP_QUOTA');
        db.prepare('INSERT INTO chamber_directory VALUES(?,?,?,?) ON CONFLICT(identity_id,room_id) DO UPDATE SET revision=excluded.revision,record=excluded.record').run(root.id, roomId, record.revision, serialized);
        db.exec('COMMIT'); return { revision: record.revision };
      } catch (cause) { db.exec('ROLLBACK'); throw cause; }
    },
    read(proof, signature) {
      if (proof?.roomId !== 'directory') throw new Error('INVALID_JSON');
      return authorize(proof, signature, 'read-directory', root => db.prepare('SELECT record FROM chamber_directory WHERE identity_id=? ORDER BY room_id LIMIT 256').all(root.id).map(row => JSON.parse(row.record)));
    },
  };
}
