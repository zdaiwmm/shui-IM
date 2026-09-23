import { createHash, timingSafeEqual } from 'node:crypto';
import { ACCESS_TTL_MS, canonical, publicAccessKey, validAccessProof, verifyAccessProof, verifyAccessIntroduction } from '../src/lib/browser-access-proof.mjs';
const digest = token => createHash('sha256').update(token).digest();
const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const now = () => new Date().toISOString();
const fail = (code = 'INVALID_BROWSER_ACCESS') => { throw new Error(code); };
function authentic(expected, token) { return secret(token) && expected && timingSafeEqual(Buffer.from(expected), digest(token)); }
export function createBrowserAccess({ db, getMember, assertDeviceActive, roomState }) {
  db.exec(`CREATE TABLE IF NOT EXISTS browser_access_mail (
    mailbox TEXT NOT NULL, request_id TEXT NOT NULL, token_hash BLOB NOT NULL,
    request TEXT NOT NULL, reply TEXT, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY(mailbox,request_id));
    CREATE TABLE IF NOT EXISTS space_access_requests (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, request_id TEXT NOT NULL,
    source_id TEXT NOT NULL, target_id TEXT NOT NULL, token_hash BLOB NOT NULL, proof TEXT NOT NULL, proof_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(room_id,request_id),
    UNIQUE(room_id,target_id));
    CREATE INDEX IF NOT EXISTS space_access_expiry ON space_access_requests(status,expires_at);`);
  function sweep() {
    db.prepare("UPDATE browser_access_mail SET status='expired',reply=NULL WHERE status IN ('pending','approved') AND expires_at<=?").run(now());
    db.prepare("UPDATE space_access_requests SET status='expired' WHERE status='pending' AND expires_at<=?").run(now());
    db.prepare(`UPDATE space_access_requests SET status='revoked' WHERE status='pending' AND NOT EXISTS (
      SELECT 1 FROM members m WHERE m.room_id=space_access_requests.room_id AND m.device_id=space_access_requests.source_id AND m.status='active')`).run();
    db.prepare(`UPDATE members SET status='revoked',revoked_at=? WHERE status='pending' AND EXISTS (
      SELECT 1 FROM space_access_requests r WHERE r.room_id=members.room_id AND r.target_id=members.device_id AND r.status IN ('expired','rejected','canceled','revoked'))`).run(now());
    db.prepare("UPDATE space_access_requests SET proof='' WHERE status<>'pending' AND proof<>''").run();
  }
  function mail(mailbox, token, requestId, action, body) {
    if (!secret(mailbox) || !secret(token) || (requestId && !uuid(requestId))) fail();
    sweep();
    // The shared PRF capability authenticates a mailbox, never a room. Mailbox
    // contents carry no room identity until an endpoint explicitly encrypts a reply.
    const existing = db.prepare('SELECT token_hash FROM browser_access_mail WHERE mailbox=? LIMIT 1').get(mailbox);
    if (existing && !authentic(existing.token_hash, token)) fail('UNAUTHORIZED');
    if (action === 'list') return { requests: db.prepare("SELECT request,expires_at FROM browser_access_mail WHERE mailbox=? AND status='pending' ORDER BY expires_at LIMIT 8").all(mailbox).map(r => ({ ...JSON.parse(r.request), expiresAt: r.expires_at })), serverTime: now() };
    let row = db.prepare('SELECT * FROM browser_access_mail WHERE mailbox=? AND request_id=?').get(mailbox, requestId);
    if (action === 'create') {
      if (!body || Object.keys(body).some(k => !['requestId','browserId','browserKey'].includes(k)) || body.requestId !== requestId || !uuid(body.browserId) || !publicAccessKey(body.browserKey)) fail();
      if (row) { if (row.request !== canonical(body)) fail('ACCESS_CONFLICT'); }
      else {
        if (db.prepare("SELECT COUNT(*) AS n FROM browser_access_mail WHERE status IN ('pending','approved')").get().n >= 1024 || db.prepare('SELECT COUNT(*) AS n FROM browser_access_mail').get().n >= 100000 || db.prepare("SELECT COUNT(*) AS n FROM browser_access_mail WHERE mailbox=? AND status='pending'").get(mailbox).n >= 3) fail('ACCESS_QUOTA');
        db.prepare('INSERT INTO browser_access_mail(mailbox,request_id,token_hash,request,expires_at) VALUES(?,?,?,?,?)').run(mailbox, requestId, digest(token), canonical(body), new Date(Date.now() + ACCESS_TTL_MS).toISOString());
        row = db.prepare('SELECT * FROM browser_access_mail WHERE mailbox=? AND request_id=?').get(mailbox, requestId);
      }
    }
    if (!row || !authentic(row.token_hash, token)) fail('UNAUTHORIZED');
    if (action === 'approve') {
      if (row.status !== 'pending' || row.expires_at <= now()) fail('ACCESS_EXPIRED');
      const sealed = body?.sealed;
      if (!sealed || Object.keys(sealed).some(k => !['iv','ciphertext'].includes(k)) || !/^[A-Za-z0-9_-]{16}$/.test(sealed.iv) || typeof sealed.ciphertext !== 'string' || sealed.ciphertext.length > 65536 || !/^[A-Za-z0-9_-]{22,}$/.test(sealed.ciphertext)) fail();
      db.prepare("UPDATE browser_access_mail SET reply=?,status='approved' WHERE mailbox=? AND request_id=? AND status='pending'").run(JSON.stringify(sealed), mailbox, requestId);
    }
    if (action === 'cancel' && row.status === 'pending') db.prepare("UPDATE browser_access_mail SET status='canceled' WHERE mailbox=? AND request_id=?").run(mailbox, requestId);
    row = db.prepare('SELECT * FROM browser_access_mail WHERE mailbox=? AND request_id=?').get(mailbox, requestId);
    return { status: row.status, expiresAt: row.expires_at, serverTime: now(), ...(row.status === 'approved' ? { sealed: JSON.parse(row.reply) } : {}) };
  }
  async function create(roomId, proof, token, deviceName, capabilities = []) {
    if (!validAccessProof(proof, roomId) || !secret(token) || digest(token).toString('base64url') !== proof.request.tokenHash ||
      typeof deviceName !== 'string' || deviceName.length > 80 ||
      !Array.isArray(capabilities) || capabilities.length > 16 || capabilities.some(value => typeof value !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value))) fail();
    const source = getMember(roomId, proof.certificate.sourceDeviceId);
    if (!source || !await verifyAccessProof(proof, roomId, source)) fail('UNAUTHORIZED');
    sweep();
    db.exec('BEGIN IMMEDIATE');
    try {
      assertDeviceActive(roomId, source.deviceId);
      if (canonical(getMember(roomId, source.deviceId)?.signingKey) !== canonical(source.signingKey)) fail('UNAUTHORIZED');
      const room = db.prepare('SELECT protocol FROM rooms WHERE room_id=?').get(roomId);
      if (room?.protocol !== 'mls-rfc9420') fail('PROTOCOL_MISMATCH');
      const previous = db.prepare('SELECT * FROM space_access_requests WHERE room_id=? AND request_id=?').get(roomId, proof.request.requestId);
      if (previous) {
        if (previous.proof_hash !== digest(canonical(proof)).toString('base64url') || !authentic(previous.token_hash, token)) fail('ACCESS_CONFLICT');
      } else {
        if (!db.prepare("SELECT 1 FROM members WHERE room_id=? AND role<>? AND status='active'").get(roomId, source.role)) fail('PEER_NOT_READY');
        if (db.prepare("SELECT COUNT(*) AS n FROM members WHERE room_id=? AND role=? AND status IN ('active','pending')").get(roomId, source.role).n >= 3) fail('DEVICE_LIMIT');
        if (db.prepare('SELECT COUNT(*) AS n FROM space_access_requests WHERE room_id=?').get(roomId).n >= 10000) fail('ACCESS_QUOTA');
        const t = proof.request.target;
        if (getMember(roomId, t.deviceId)) fail('ACCESS_CONFLICT');
        db.prepare(`INSERT INTO members(room_id,device_id,role,encryption_jwk,signing_jwk,mls_key_package,access_hash,device_name,status,added_by,capabilities,created_at)
          VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?)`).run(roomId,t.deviceId,source.role,JSON.stringify(t.encryptionKey),JSON.stringify(t.signingKey),t.mlsKeyPackage,digest(token),deviceName,source.deviceId,JSON.stringify(capabilities),now());
        db.prepare('INSERT INTO space_access_requests(room_id,request_id,source_id,target_id,token_hash,proof,proof_hash,expires_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(roomId,proof.request.requestId,source.deviceId,t.deviceId,digest(token),canonical(proof),digest(canonical(proof)).toString('base64url'),new Date(Date.now()+ACCESS_TTL_MS).toISOString());
      }
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    return status(roomId, proof.request.requestId, token);
  }
  function status(roomId, id, token) {
    sweep();
    const row = db.prepare('SELECT * FROM space_access_requests WHERE room_id=? AND request_id=?').get(roomId,id);
    if (!row || !authentic(row.token_hash,token)) fail('UNAUTHORIZED');
    const active = row.status === 'approved' && getMember(roomId,row.target_id)?.status === 'active';
    return { status: row.status === 'approved' && !active ? 'revoked' : row.status, expiresAt:row.expires_at, serverTime:now(), ...(active ? {state:roomState(roomId)} : {}) };
  }
  function list(roomId, peerId) {
    sweep(); assertDeviceActive(roomId,peerId);
    const peer = getMember(roomId,peerId);
    return {requests:db.prepare("SELECT r.* FROM space_access_requests r JOIN members m ON m.room_id=r.room_id AND m.device_id=r.source_id WHERE r.room_id=? AND r.status='pending' AND m.role<>? AND m.status='active'").all(roomId,peer.role)
      .map(r=>({proof:JSON.parse(r.proof),expiresAt:r.expires_at,target:getMember(roomId,r.target_id)})),serverTime:now()};
  }
  function dismiss(roomId,id,deviceId,token) {
    sweep();
    const row=db.prepare('SELECT * FROM space_access_requests WHERE room_id=? AND request_id=?').get(roomId,id);
    if (!row || row.status!=='pending') fail('ACCESS_EXPIRED');
    const peer=deviceId ? getMember(roomId,deviceId) : null, source=getMember(roomId,row.source_id);
    if (peer) { assertDeviceActive(roomId,deviceId); if(peer.role===source?.role) fail('UNAUTHORIZED'); }
    else if (!authentic(row.token_hash,token)) fail('UNAUTHORIZED');
    db.prepare("UPDATE space_access_requests SET status=? WHERE room_id=? AND request_id=? AND status='pending'").run(peer?'rejected':'canceled',roomId,id);
    sweep(); return {ok:true};
  }
  // Called inside saveMlsEvent's transaction, after the peer's signature check.
  function assertCommit(roomId,envelope,sender,target) {
    const row=db.prepare('SELECT * FROM space_access_requests WHERE room_id=? AND request_id=?').get(roomId,envelope.browserAccess?.request.requestId ?? '');
    const source=row && getMember(roomId,row.source_id);
    if (!row || row.status!=='pending' || row.expires_at<=now() || !source || source.status!=='active' ||
      sender.role===source.role || target?.role!==source.role || target?.deviceId!==row.target_id || target.addedBy!==source.deviceId ||
      canonical(envelope.browserAccess)!==row.proof) fail('INVALID_BROWSER_ACCESS');
    assertDeviceActive(roomId,source.deviceId);
    return row;
  }
  function complete(roomId,envelope) { if(envelope.browserAccess) db.prepare("UPDATE space_access_requests SET status='approved' WHERE room_id=? AND request_id=? AND status='pending'").run(roomId,envelope.browserAccess.request.requestId); }
  async function capacity(roomId, body) {
    sweep();
    const source = getMember(roomId, body?.certificate?.sourceDeviceId);
    if (!source || !await verifyAccessIntroduction(body, roomId, source)) fail('UNAUTHORIZED');
    const count = db.prepare("SELECT COUNT(*) AS n FROM members WHERE room_id=? AND role=? AND status IN ('active','pending')").get(roomId, source.role).n;
    return { full: count >= 3, count };
  }
  return {mail,create,status,list,dismiss,assertCommit,complete,sweep,capacity};
}
