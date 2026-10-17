import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalStringify, validatePublicBundle } from './protocol.mjs';
import { personalHash, verifyPersonalDeviceBinding, verifyPersonalProof } from './personal-protocol.mjs';
const digest = value => createHash('sha256').update(value).digest();
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b);
export function createPersonalDevices(db, { getMember, roomState, chamberInvitations, personalDirectory }) {
  db.exec(`CREATE TABLE IF NOT EXISTS chamber_device_requests (room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,target_id TEXT NOT NULL,role TEXT NOT NULL,request TEXT NOT NULL,token_hash BLOB NOT NULL,
    expires_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(room_id,request_id),UNIQUE(room_id,target_id));`);
  const row = (roomId, requestId) => db.prepare('SELECT * FROM chamber_device_requests WHERE room_id=? AND request_id=?').get(roomId, requestId);
  function sweep() {
    const now = new Date().toISOString();
    db.prepare("UPDATE chamber_device_requests SET status='expired' WHERE status='pending' AND expires_at<=?").run(now);
    db.prepare(`UPDATE members SET status='revoked',revoked_at=? WHERE status='pending' AND EXISTS
      (SELECT 1 FROM chamber_device_requests r WHERE r.room_id=members.room_id AND r.target_id=members.device_id AND r.status IN ('expired','canceled','rejected'))`).run(now);
  }
  function roots(roomId, role) {
    const state = chamberInvitations.state(roomId);
    if (!state?.joinerBinding) throw new Error('PEER_NOT_READY');
    return role === 'creator' ? [state.creatorBinding.identity, state.joinerBinding.identity] : [state.joinerBinding.identity, state.creatorBinding.identity];
  }
  function valid(request) {
    const p = request?.payload, proof = request?.proof;
    if (!p || Object.keys(request).sort().join(',') !== 'payload,proof,signature' ||
      Object.keys(p).sort().join(',') !== 'binding,bundle,capabilities,deviceName,purpose,role,roomId,tokenHash,v' || p.v !== 1 || p.purpose !== 'chamber-device-request-v1' ||
      !['creator', 'joiner'].includes(p.role) || !validatePublicBundle(p.bundle) || !p.bundle.mlsKeyPackage ||
      typeof p.deviceName !== 'string' || p.deviceName.length < 1 || p.deviceName.length > 40 ||
      !Array.isArray(p.capabilities) || p.capabilities.length > 32 || p.capabilities.some(c => typeof c !== 'string' || !/^[a-z0-9-]{1,40}$/.test(c)) ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.tokenHash)) return false;
    const [owner] = roots(p.roomId, p.role);
    return same(owner, p.binding?.identity) && proof?.action === 'bind-device' && proof.roomId === p.roomId && proof.deviceId === p.bundle.deviceId &&
      proof.version===(db.prepare('SELECT generation FROM chamber_lifecycle WHERE room_id=?').get(p.roomId)?.generation??1)&&
      proof.payloadHash === personalHash(p) && verifyPersonalProof(owner, proof, request.signature);
  }
  function status(roomId, requestId, token) {
    sweep(); const r = row(roomId, requestId);
    if (!r || typeof token !== 'string' || !timingSafeEqual(Buffer.from(r.token_hash), digest(token))) throw new Error('UNAUTHORIZED');
    const member = getMember(roomId, r.target_id), approved = r.status === 'approved' && member?.status === 'active';
    return { status: r.status === 'approved' && !approved ? 'revoked' : r.status, expiresAt: r.expires_at,
      ...(approved ? { state: roomState(roomId) } : {}) };
  }
  return {
    sweep, status,
    async create(roomId, request, token) {
      if (request?.payload?.roomId !== roomId || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        digest(token).toString('base64url') !== request.payload.tokenHash || !valid(request) ||
        !await verifyPersonalDeviceBinding(request.payload.binding, request.payload.bundle)) throw new Error('INVALID_PERSONAL_DEVICE');
      sweep();
      const previous = row(roomId, request.proof.requestId);
      if (previous) { if (!same(JSON.parse(previous.request), request)) throw new Error('INVALID_PERSONAL_DEVICE'); return status(roomId, request.proof.requestId, token); }
      personalDirectory.authorize(request.proof, request.signature, 'bind-device', root => {
        if (!valid(request) || root.id !== request.payload.binding.identity.id) throw new Error('INVALID_PERSONAL_DEVICE');
        const p = request.payload, peer = db.prepare("SELECT device_id FROM members WHERE room_id=? AND role<>? AND status='active' ORDER BY last_seen_at DESC LIMIT 1").get(roomId, p.role);
        if (!peer) throw new Error('PEER_NOT_READY');
        if (db.prepare("SELECT COUNT(*) AS n FROM members WHERE room_id=? AND role=? AND status IN ('active','pending')").get(roomId, p.role).n >= 3) throw new Error('DEVICE_LIMIT');
        if (db.prepare('SELECT COUNT(*) AS n FROM chamber_device_requests WHERE room_id=?').get(roomId).n >= 10_000 || getMember(roomId, p.bundle.deviceId)) throw new Error('INVALID_PERSONAL_DEVICE');
        db.prepare(`INSERT INTO members(room_id,device_id,role,encryption_jwk,signing_jwk,mls_key_package,access_hash,device_name,status,added_by,capabilities,created_at)
          VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?)`).run(roomId,p.bundle.deviceId,p.role,JSON.stringify(p.bundle.encryptionKey),JSON.stringify(p.bundle.signingKey),p.bundle.mlsKeyPackage,digest(token),p.deviceName,peer.device_id,JSON.stringify(p.capabilities),new Date().toISOString());
        db.prepare('INSERT INTO chamber_device_requests(room_id,request_id,target_id,role,request,token_hash,expires_at) VALUES(?,?,?,?,?,?,?)')
          .run(roomId,request.proof.requestId,p.bundle.deviceId,p.role,canonicalStringify(request),digest(token),request.proof.expiresAt);
      });
      return status(roomId, request.proof.requestId, token);
    },
    list(roomId, deviceId) {
      sweep(); const member = getMember(roomId, deviceId);
      if (!member || member.status !== 'active') throw new Error('UNAUTHORIZED');
      return db.prepare("SELECT request FROM chamber_device_requests WHERE room_id=? AND role<>? AND status='pending' ORDER BY expires_at LIMIT 6").all(roomId, member.role).map(r => JSON.parse(r.request));
    },
    /** Verified by the async route before any MLS mutation; assertion below rereads the pending request atomically. */
    async verifyAuthorization(roomId, envelope) {
      const a = envelope.personalAccess, sender = getMember(roomId, envelope.senderId);
      if (!a || Object.keys(a).sort().join(',') !== 'approvedAt,approverBinding,request' || !sender || sender.status !== 'active' ||
        envelope.action !== 'add' || a.request?.payload?.roomId !== roomId || !valid(a.request) || sender.role === a.request.payload.role ||
        !same(a.approverBinding?.identity, roots(roomId, sender.role)[0]) ||
        !await verifyPersonalDeviceBinding(a.approverBinding, { deviceId: sender.deviceId, encryptionKey: sender.encryptionKey, signingKey: sender.signingKey, mlsKeyPackage: sender.mlsKeyPackage })) throw new Error('INVALID_PERSONAL_DEVICE');
      if (typeof a.approvedAt !== 'string' || new Date(a.approvedAt).toISOString() !== a.approvedAt || Date.parse(a.approvedAt) > Date.now() + 1000 ||
        Date.parse(a.approvedAt) > Date.parse(a.request.proof.expiresAt) || Date.parse(a.approvedAt) < Date.parse(a.request.proof.expiresAt) - 30 * 60_000) throw new Error('INVALID_PERSONAL_DEVICE');
    },
    assertCommit(roomId, envelope, sender, target) {
      const request = envelope.personalAccess?.request, r = row(roomId, request?.proof?.requestId ?? '');
      if (!r || r.status !== 'pending' || Date.parse(r.expires_at) <= Date.now() || !same(JSON.parse(r.request), request) ||
        sender.role === target.role || target.role !== r.role || target.deviceId !== r.target_id || !valid(request)) throw new Error('INVALID_PERSONAL_DEVICE');
      db.prepare("UPDATE chamber_device_requests SET status='approved' WHERE room_id=? AND request_id=? AND status='pending'").run(roomId, r.request_id);
    },
  };
}
