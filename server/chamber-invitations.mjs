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
  db.exec(`CREATE TABLE IF NOT EXISTS chamber_migrations(room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
    bindings TEXT NOT NULL DEFAULT '{}',verified TEXT NOT NULL DEFAULT '{}',activated INTEGER NOT NULL DEFAULT 0,base_seq INTEGER NOT NULL DEFAULT 0);`);
  if(!db.prepare('PRAGMA table_info(chamber_migrations)').all().some(c=>c.name==='base_seq'))db.exec('ALTER TABLE chamber_migrations ADD COLUMN base_seq INTEGER NOT NULL DEFAULT 0');
  const row = roomId => db.prepare('SELECT * FROM chamber_rooms WHERE room_id=?').get(roomId);
  const live = record => {
    if (!record || record.consumed || !record.expires_at || Date.parse(record.expires_at) <= Date.now() || record.attempts >= 5) throw new Error('INVITATION_ENDED');
  };
  const ownClaim = (record, secret) => {
    live(record);
    if (!secretValid(secret) || !record.claim_hash || !timingSafeEqual(Buffer.from(record.claim_hash, 'hex'), Buffer.from(digest(secret), 'hex'))) throw new Error('INVITATION_CLAIMED');
  };
  function state(roomId, creator = false) {
    const r = row(roomId);
    if (!r) {
      const migration=db.prepare('SELECT * FROM chamber_migrations WHERE room_id=?').get(roomId);
      const bindings=migration&&JSON.parse(migration.bindings);
      if(!bindings?.creator || !bindings?.joiner)return null;
      return {v:1,creatorBinding:bindings.creator,joinerBinding:bindings.joiner,version:1,requestId:null,expiresAt:null,stage:'joined',migration:'preparing'};
    }
    return { v: 1, creatorBinding: JSON.parse(r.creator_binding), joinerBinding: r.joiner_binding ? JSON.parse(r.joiner_binding) : null,
      version: r.version, requestId: r.request_id, expiresAt: r.expires_at,
      stage: r.consumed ? 'joined' : r.expires_at && (Date.parse(r.expires_at) <= Date.now() || r.attempts >= 5) ? 'expired' : r.ready ? 'code' : r.claim_hash ? 'preparing' : 'available',
      ...(creator && r.claim_hash && !r.consumed && Date.parse(r.expires_at) > Date.now() && r.attempts < 5
        ? { ...(r.code ? { code: r.code } : {}), ...(r.ready ? { candidate: JSON.parse(r.ready) } : {}) } : {}) };
  }
  return {
    exists: roomId => !!row(roomId), state,
    register(roomId, binding) { db.prepare('INSERT INTO chamber_rooms(room_id,creator_binding) VALUES(?,?)').run(roomId, JSON.stringify(binding)); },
    claim(roomId, secret) {
      if (!secretValid(secret)) throw new Error('INVALID_JSON');
      // This synchronous UPDATE is the single winner across processes and tabs.
      db.prepare(`UPDATE chamber_rooms SET claim_hash=?,request_id=?,expires_at=?,code=? WHERE room_id=? AND claim_hash IS NULL AND consumed=0`)
        .run(digest(secret), randomUUID(), new Date(Date.now() + 30 * 60_000).toISOString(), String(randomInt(10_000)).padStart(4, '0'), roomId);
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
    /** Call inside the membership transaction. No async gap between validation and consumption. */
    consume(roomId, secret, code, candidate) {
      const r = row(roomId); if (!r) return;
      ownClaim(r, secret);
      if (!r.ready || !same(JSON.parse(r.ready), candidate)) throw new Error('INVITATION_CLAIMED');
      if (typeof code !== 'string' || !/^\d{4}$/.test(code) || code !== r.code) throw new Error('INVITATION_CODE_INVALID');
      db.prepare('UPDATE chamber_rooms SET consumed=1,joiner_binding=?,code=NULL WHERE room_id=? AND version=? AND consumed=0')
        .run(JSON.stringify(candidate.binding), roomId, r.version);
    },
    recordWrongCode(roomId, secret) {
      const r = row(roomId); ownClaim(r, secret);
      db.prepare('UPDATE chamber_rooms SET attempts=attempts+1 WHERE room_id=?').run(roomId);
    },
    /** Rotation and rooms.access_hash update are performed in the caller's transaction. */
    rotate(roomId) {
      const r = row(roomId); if (!r || r.consumed) throw new Error('ROOM_SEALED');
      db.prepare('UPDATE chamber_rooms SET version=version+1,claim_hash=NULL,request_id=NULL,expires_at=NULL,ready=NULL,code=NULL,attempts=0 WHERE room_id=?').run(roomId);
      return state(roomId, true);
    },
  };
}
