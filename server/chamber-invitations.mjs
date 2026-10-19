import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalStringify } from './protocol.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const secretValid = s => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b);
export function createChamberInvitations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chamber_rooms (
    room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
    creator_binding TEXT NOT NULL, joiner_binding TEXT,
    version INTEGER NOT NULL DEFAULT 1, claim_hash TEXT, request_id TEXT,
    expires_at TEXT, ready TEXT, code TEXT, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0
  );`);
  const columns = db.prepare('PRAGMA table_info(chamber_rooms)').all();
  if (!columns.some(c => c.name === 'code_revision')) db.exec('ALTER TABLE chamber_rooms ADD COLUMN code_revision INTEGER NOT NULL DEFAULT 1');
  if (!columns.some(c => c.name === 'refresh_id')) db.exec('ALTER TABLE chamber_rooms ADD COLUMN refresh_id TEXT');
  const row = roomId => db.prepare('SELECT * FROM chamber_rooms WHERE room_id=?').get(roomId);
  const freshCode = previous => {
    // An old four-digit value must not become valid again on this refresh.
    let code; do { code = String(randomInt(10_000)).padStart(4, '0'); } while (code === previous);
    return code;
  };
  const live = record => {
    if (!record || record.consumed || record.attempts >= 5) throw new Error('INVITATION_ENDED');
  };
  const ownClaim = (record, secret) => {
    live(record);
    if (!secretValid(secret) || !record.claim_hash || !timingSafeEqual(Buffer.from(record.claim_hash, 'hex'), Buffer.from(digest(secret), 'hex'))) throw new Error('INVITATION_CLAIMED');
  };
  function state(roomId, creator = false) {
    const r = row(roomId);
    if (!r) return null;
    return { v: 1, creatorBinding: JSON.parse(r.creator_binding), joinerBinding: r.joiner_binding ? JSON.parse(r.joiner_binding) : null,
      version: r.version, requestId: r.request_id, expiresAt: r.expires_at, codeRevision: r.code_revision,
      stage: r.consumed ? 'joined' : r.attempts >= 5 ? 'blocked' : r.expires_at && Date.parse(r.expires_at) <= Date.now() ? 'code-expired' : r.ready ? 'code' : r.claim_hash ? 'preparing' : 'available',
      ...(creator && !r.consumed && Date.parse(r.expires_at) > Date.now() && r.attempts < 5
        ? { ...(r.code ? { code: r.code } : {}), ...(r.ready ? { candidate: JSON.parse(r.ready) } : {}) } : {}) };
  }
  return {
    exists: roomId => !!row(roomId), state,
    register(roomId, binding) { db.prepare('INSERT INTO chamber_rooms(room_id,creator_binding) VALUES(?,?)').run(roomId, JSON.stringify(binding)); },
    claim(roomId, secret) {
      if (!secretValid(secret)) throw new Error('INVALID_JSON');
      // This synchronous UPDATE is the single winner across processes and tabs.
      db.prepare(`UPDATE chamber_rooms SET claim_hash=?,request_id=COALESCE(request_id,?),expires_at=COALESCE(expires_at,?),code=COALESCE(code,?) WHERE room_id=? AND claim_hash IS NULL AND consumed=0 AND attempts<5`)
        .run(digest(secret), randomUUID(), new Date(Date.now() + 30 * 60_000).toISOString(), freshCode(), roomId);
      const r = row(roomId); ownClaim(r, secret); return state(roomId);
    },
    ready(roomId, secret, candidate) {
      const r = row(roomId); ownClaim(r, secret);
      if (candidate.binding?.identity?.id === JSON.parse(r.creator_binding).identity.id) throw new Error('INVITATION_CLAIMED');
      if (r.ready && !same(JSON.parse(r.ready), candidate)) throw new Error('INVITATION_CLAIMED');
      if (!r.ready) db.prepare('UPDATE chamber_rooms SET ready=?,code=COALESCE(code,?) WHERE room_id=? AND version=? AND claim_hash=? AND ready IS NULL')
        .run(JSON.stringify(candidate), String(randomInt(10_000)).padStart(4, '0'), roomId, r.version, r.claim_hash);
      return state(roomId);
    },
    refreshCode(roomId, secret, request) {
      const r = row(roomId); ownClaim(r, secret);
      if (!request || request.version !== r.version || request.requestId !== r.request_id ||
        !Number.isSafeInteger(request.codeRevision) || request.codeRevision < 1 ||
        typeof request.refreshId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(request.refreshId)) throw new Error('INVITATION_CLAIMED');
      // Replayed/lost replies and competing refreshes return the winning state.
      // The durable revision also fences retries delayed beyond another expiry.
      if (r.refresh_id === request.refreshId || r.code_revision !== request.codeRevision || Date.parse(r.expires_at) > Date.now()) return state(roomId);
      db.prepare(`UPDATE chamber_rooms SET code=?,expires_at=?,code_revision=code_revision+1,refresh_id=?
        WHERE room_id=? AND version=? AND claim_hash=? AND code_revision=? AND consumed=0 AND attempts<5 AND expires_at<=?`)
        .run(freshCode(r.code), new Date(Date.now() + 30 * 60_000).toISOString(), request.refreshId,
          roomId, r.version, r.claim_hash, request.codeRevision, new Date().toISOString());
      return state(roomId);
    },
    /** Call inside the membership transaction. No async gap between validation and consumption. */
    consume(roomId, secret, code, candidate, codeRevision) {
      const r = row(roomId); if (!r) return;
      ownClaim(r, secret);
      if (!r.expires_at || Date.parse(r.expires_at) <= Date.now()) throw new Error('INVITATION_CODE_EXPIRED');
      if (codeRevision !== undefined && codeRevision !== r.code_revision) throw new Error('INVITATION_CODE_EXPIRED');
      if (!r.ready || !same(JSON.parse(r.ready), candidate)) throw new Error('INVITATION_CLAIMED');
      if (typeof code !== 'string' || !/^\d{4}$/.test(code) || code !== r.code) throw new Error('INVITATION_CODE_INVALID');
      db.prepare('UPDATE chamber_rooms SET consumed=1,joiner_binding=?,code=NULL WHERE room_id=? AND version=? AND consumed=0')
        .run(JSON.stringify(candidate.binding), roomId, r.version);
    },
    recordWrongCode(roomId, secret) {
      const r = row(roomId); ownClaim(r, secret);
      if (!r.expires_at || Date.parse(r.expires_at) <= Date.now()) throw new Error('INVITATION_CODE_EXPIRED');
      db.prepare('UPDATE chamber_rooms SET attempts=attempts+1 WHERE room_id=?').run(roomId);
    },
    /** Rotation and rooms.access_hash update are performed in the caller's transaction. */
    rotate(roomId) {
      const r = row(roomId); if (!r || r.consumed) throw new Error('ROOM_SEALED');
      db.prepare('UPDATE chamber_rooms SET version=version+1,claim_hash=NULL,request_id=NULL,expires_at=NULL,ready=NULL,code=NULL,attempts=0,code_revision=1,refresh_id=NULL WHERE room_id=?')
        .run(roomId);
      return state(roomId, true);
    },
  };
}
