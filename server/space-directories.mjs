import { createHash, timingSafeEqual } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest();
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const matches = (value, digest) => token(value) && digest?.length === 32 && timingSafeEqual(hash(value), digest);
const fail = code => { throw new Error(code); };
/** Opaque collection capability. It cannot authorize membership or read a room. */
export function createSpaceDirectories(db, { authenticatedDevice }, browserCatalog = false) {
  const table = browserCatalog ? 'browser_access_catalogs' : 'space_directories';
  const maxCiphertext = browserCatalog ? 4 * 1024 * 1024 : 131072;
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    id TEXT PRIMARY KEY, owner_room TEXT NOT NULL, owner_device TEXT NOT NULL,
    revision INTEGER NOT NULL, fetch_hash BLOB NOT NULL, write_hash BLOB NOT NULL,
    sealed TEXT NOT NULL, request_hash BLOB NOT NULL
  )`);
  const row = id => db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  return {
    fetch(id, capability) {
      const current = row(id);
      if (!current || !matches(capability, current.fetch_hash)) fail('BACKUP_UNAVAILABLE');
      return { revision: current.revision, sealed: JSON.parse(current.sealed) };
    },
    save(id, deviceToken, value) {
      if (!value || typeof value.roomId !== 'string') fail('INVALID_BACKUP');
      const member = authenticatedDevice(value.roomId, deviceToken);
      if (!member) fail('UNAUTHORIZED');
      if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !token(value.fetchToken) || !token(value.writeToken) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
          !/^[A-Za-z0-9_-]{16}$/.test(value.sealed?.iv ?? '') || typeof value.sealed?.ciphertext !== 'string' || value.sealed.ciphertext.length > maxCiphertext || !/^[A-Za-z0-9_-]{22,}$/.test(value.sealed.ciphertext) ||
          Object.keys(value).some(k => !['roomId','revision','fetchToken','writeToken','sealed'].includes(k)) || Object.keys(value.sealed).sort().join(',') !== 'ciphertext,iv') fail('INVALID_BACKUP');
      const fingerprint = hash(JSON.stringify(value));
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = row(id);
        if (current) {
          if (!matches(value.writeToken, current.write_hash) || !matches(value.fetchToken, current.fetch_hash)) fail('UNAUTHORIZED');
          if (value.revision === current.revision && timingSafeEqual(fingerprint, current.request_hash)) { db.exec('COMMIT'); return { revision: current.revision }; }
          if (value.revision !== current.revision + 1) fail('BACKUP_CONFLICT');
          db.prepare(`UPDATE ${table} SET revision=?, sealed=?, request_hash=? WHERE id=?`).run(value.revision, JSON.stringify(value.sealed), fingerprint, id);
        } else {
          if (value.revision !== 1) fail('BACKUP_CONFLICT');
          if (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_room=? AND owner_device=?`).get(value.roomId, member.deviceId).n >= 4) fail('BACKUP_QUOTA');
          db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?)`).run(id, value.roomId, member.deviceId, value.revision, hash(value.fetchToken), hash(value.writeToken), JSON.stringify(value.sealed), fingerprint);
        }
        db.exec('COMMIT'); return { revision: value.revision };
      } catch (cause) { db.exec('ROLLBACK'); throw cause; }
    },
  };
}
