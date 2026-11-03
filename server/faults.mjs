import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import stages from '../src/lib/fault-stages.json' with { type: 'json' };

const faultId = /^E-[0-9A-F]{16}$/;
const week = 7 * 86400000;
const reasons = new Set(['FAILED','STORAGE_QUOTA','STORE_UNAVAILABLE','TIMEOUT','NETWORK','ACCESS_DENIED','REQUEST_REJECTED']);
const internalStages = new Set(['upload.write','upload.reserve','upload.complete','send.store']);
const internalReasons = new Set(['STORAGE_QUOTA','MESSAGE_QUOTA','CHUNK_CONFLICT','BLOB_CONFLICT','BLOB_INCOMPLETE','BLOB_SIZE_MISMATCH','MESSAGE_CONFLICT','ENOSPC','EIO']);
const version = /^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/;
export const clientVersion = value => typeof value === 'string' && version.test(value) ? value : null;

export function openFaultStore(dataDir, release) {
  const db = new DatabaseSync(path.join(dataDir, 'faults.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS faults(
    id TEXT PRIMARY KEY, source TEXT NOT NULL, stage TEXT NOT NULL, reason TEXT NOT NULL,
    client_version TEXT, server_version TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fault_age ON faults(created_at)`);
  // One statement arbitrates concurrent admissions, including a rolling restart.
  const insert = db.prepare(`INSERT INTO faults
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM faults) < ?
    ON CONFLICT(id) DO NOTHING`);
  const byId = db.prepare('SELECT source,stage,reason,client_version FROM faults WHERE id=?');
  const expire = db.prepare('DELETE FROM faults WHERE created_at<=?');
  const sweep = () => expire.run(Date.now() - week);
  sweep();

  function save(id, source, stage, reason, clientRelease) {
    sweep();
    // Preserve space for server evidence even when browser reports reach capacity.
    const limit = source === 'browser' ? 9000 : 10000;
    if (insert.run(id, source, stage, reason, clientRelease, release, Date.now(), limit).changes) return 200;
    const prior = byId.get(id);
    if (!prior) return 503;
    return prior.source === source && prior.stage === stage && prior.reason === reason && prior.client_version === clientRelease ? 200 : 409;
  }
  return {
    sweep, close: () => db.close(),
    client(body) {
      if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'id,reason,stage,version' ||
        typeof body.id !== 'string' || !faultId.test(body.id) || !clientVersion(body.version) ||
        typeof body.stage !== 'string' || !Object.hasOwn(stages, body.stage) || !reasons.has(body.reason)) return 400;
      return save(body.id, 'browser', body.stage, body.reason, body.version);
    },
    server(stage, error, releaseHint) {
      if (!internalStages.has(stage)) return;
      const id = 'E-' + randomBytes(8).toString('hex').toUpperCase();
      const reason = [error?.code, error?.message].find(value => internalReasons.has(value)) ?? 'FAILED';
      try {
        if (save(id, 'server', stage, reason, clientVersion(releaseHint)) === 200) return id;
      } catch { /* Preserve the operation's original failure if diagnostics are unavailable. */ }
    }
  };
}

export function lookupFault(dataDir, id) {
  if (!faultId.test(id)) throw new Error('INVALID_FAULT_ID');
  const db = new DatabaseSync(path.join(dataDir, 'faults.sqlite'), {readOnly:true});
  try { return db.prepare('SELECT id,source,stage,reason,client_version,server_version,created_at FROM faults WHERE id=? AND created_at>?').get(id, Date.now()-week) ?? null; }
  finally { db.close(); }
}
