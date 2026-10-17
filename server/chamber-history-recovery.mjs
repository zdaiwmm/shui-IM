import { canonicalStringify } from './protocol.mjs';
import { personalHash, verifyPersonalProof } from './personal-protocol.mjs';

/** Scope and releases contain only public keys and ciphertext. Each release is
 * signed by the peer root and HPKE sealed to the requesting device. */
export function createChamberHistoryRecovery(db, { getMember, chamberInvitations, personalDirectory }) {
  db.exec(`CREATE TABLE IF NOT EXISTS chamber_history_requests (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, request_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL, peer_id TEXT NOT NULL,target_id TEXT NOT NULL,expires_at TEXT NOT NULL,request TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chamber_history_releases (
    request_id TEXT NOT NULL REFERENCES chamber_history_requests(request_id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL,release TEXT NOT NULL,PRIMARY KEY(request_id,unit_id));`);
  const roots = roomId => {
    const room = chamberInvitations.state(roomId);
    if (!room?.joinerBinding) throw new Error('ROOM_SEALED');
    return [room.creatorBinding.identity, room.joinerBinding.identity];
  };
  const active = (roomId, deviceId) => { const m = getMember(roomId, deviceId); if (m?.status !== 'active') throw new Error('UNAUTHORIZED'); return m; };
  const ownRoot = (roomId, deviceId) => roots(roomId)[active(roomId, deviceId).role === 'creator' ? 0 : 1];
  const read = (roomId, requestId, deviceId) => {
    const row = db.prepare('SELECT * FROM chamber_history_requests WHERE room_id=? AND request_id=?').get(roomId, requestId);
    const root = ownRoot(roomId, deviceId);
    if (!row || ![row.owner_id, row.peer_id].includes(root.id)) throw new Error('UNAUTHORIZED');
    if (Date.parse(row.expires_at) <= Date.now()) throw new Error('PERSONAL_PROOF_EXPIRED');
    return { row, request: JSON.parse(row.request), root };
  };
  return {
    create(roomId, deviceId, request) {
      const member = active(roomId, deviceId), owner = ownRoot(roomId, deviceId), peer = roots(roomId).find(x => x.id !== owner.id);
      const { scope, proof, signature } = request ?? {};
      if (!scope || Object.keys(request).sort().join(',') !== 'proof,scope,signature' ||
        Object.keys(scope).sort().join(',') !== 'generation,heads,ownerId,peerId,purpose,roomId,scope,target,units,v' ||
        scope.v !== 1 || scope.purpose !== 'chamber-joint-history-scope-v1' || scope.roomId !== roomId || scope.ownerId !== owner.id || scope.peerId !== peer.id ||
        scope.generation !== (db.prepare('SELECT generation FROM chamber_lifecycle WHERE room_id=?').get(roomId)?.generation??1) || !['chat','gallery','all'].includes(scope.scope) || member.role !== 'creator' && scope.scope !== 'chat' ||
        scope.target?.deviceId !== deviceId || canonicalStringify(scope.target.encryptionKey) !== canonicalStringify(member.encryptionKey) ||
        canonicalStringify(scope.target.signingKey) !== canonicalStringify(member.signingKey) || scope.target.mlsKeyPackage !== member.mlsKeyPackage ||
        Object.keys(scope.target).sort().join(',') !== 'deviceId,encryptionKey,mlsKeyPackage,signingKey' ||
        !Array.isArray(scope.heads) || scope.heads.length < 1 || scope.heads.length > 1000 || !Array.isArray(scope.units) || scope.units.length < 1 || scope.units.length > 50_000 ||
        proof?.roomId !== roomId || proof.deviceId !== deviceId || proof.version !== scope.generation || proof.payloadHash !== personalHash(scope) ||
        !verifyPersonalProof(owner, proof, signature)) throw new Error('INVALID_BACKUP');
      const heads = new Map(), ids = new Set(), hashes = new Set();
      for (const h of scope.heads) {
        if (!h || Object.keys(h).sort().join(',') !== 'afterSeq,deviceId,digest,id,revision,upperSeq' || heads.has(h.deviceId) ||
          !Number.isSafeInteger(h.revision) || h.revision < 1 || !Number.isSafeInteger(h.afterSeq) || h.afterSeq < 0 || !Number.isSafeInteger(h.upperSeq) || h.upperSeq < h.afterSeq ||
          !/^[A-Za-z0-9_-]{43}$/.test(h.id) || !/^[A-Za-z0-9_-]{43}$/.test(h.digest)) throw new Error('INVALID_BACKUP');
        heads.set(h.deviceId,h);
      }
      const serialized = canonicalStringify(request);
      if (Buffer.byteLength(serialized) > 8 * 1024 ** 2) throw new Error('BACKUP_QUOTA');
      const existing = db.prepare('SELECT request FROM chamber_history_requests WHERE request_id=?').get(proof.requestId);
      if (existing) { if (existing.request !== serialized) throw new Error('BACKUP_CONFLICT'); return { requestId: proof.requestId }; }
      return personalDirectory.authorize(proof, signature, 'restore-history', () => {
        active(roomId, deviceId);
        db.prepare('DELETE FROM chamber_history_requests WHERE expires_at<=?').run(new Date().toISOString());
        if (db.prepare('SELECT COUNT(*) AS n FROM chamber_history_requests WHERE room_id=?').get(roomId).n >= 3 ||
          db.prepare('SELECT COALESCE(SUM(length(request)),0) AS n FROM chamber_history_requests').get().n + Buffer.byteLength(serialized) > 64 * 1024 ** 2) throw new Error('BACKUP_QUOTA');
        for (const unit of scope.units) {
          if (!unit || Object.keys(unit).sort().join(',') !== 'deviceId,envelopeHash,id,revision' || ids.has(unit.id) || hashes.has(unit.envelopeHash) ||
            !Number.isSafeInteger(unit.revision) || unit.revision < 1 || unit.revision > (heads.get(unit.deviceId)?.revision ?? 0)) throw new Error('INVALID_BACKUP');
          const stored = db.prepare("SELECT device_id,revision,json_extract(record,'$.keyEnvelope') AS envelope FROM chamber_history WHERE room_id=? AND owner_id=? AND unit_id=?").get(roomId, owner.id, unit.id);
          if (!stored || stored.device_id !== unit.deviceId || stored.revision !== unit.revision || personalHash(JSON.parse(stored.envelope)) !== unit.envelopeHash) throw new Error('BACKUP_NOT_FOUND');
          ids.add(unit.id); hashes.add(unit.envelopeHash);
        }
        for (const head of heads.values()) if (!ids.has(head.id)) throw new Error('INVALID_BACKUP');
        db.prepare('INSERT INTO chamber_history_requests VALUES(?,?,?,?,?,?,?)').run(roomId,proof.requestId,owner.id,peer.id,deviceId,proof.expiresAt,serialized);
        return { requestId: proof.requestId };
      });
    },
    list(roomId, deviceId) {
      const root = ownRoot(roomId, deviceId);
      return db.prepare('SELECT request FROM chamber_history_requests WHERE room_id=? AND expires_at>? AND (peer_id=? OR target_id=?) ORDER BY expires_at LIMIT 3')
        .all(roomId,new Date().toISOString(),root.id,deviceId).map(row => {
          const {scope,proof} = JSON.parse(row.request);
          return {requestId:proof.requestId,ownerId:scope.ownerId,peerId:scope.peerId,targetId:scope.target.deviceId,expiresAt:proof.expiresAt,scope:scope.scope,
            unitCount:scope.units.length,releasedCount:db.prepare('SELECT COUNT(*) AS n FROM chamber_history_releases WHERE request_id=?').get(proof.requestId).n,
            upperSeq:Math.max(...scope.heads.map(h=>h.upperSeq))};
        });
    },
    manifest(roomId,requestId,deviceId) { return read(roomId,requestId,deviceId).request; },
    page(roomId, requestId, deviceId, after = 0) {
      const { request, root } = read(roomId, requestId, deviceId);
      if (!Number.isSafeInteger(after) || after < 0 || after > request.scope.units.length) throw new Error('INVALID_JSON');
      return request.scope.units.slice(after,after+100).map(unit => {
        const stored = db.prepare("SELECT json_extract(record,'$.keyEnvelope') AS envelope FROM chamber_history WHERE room_id=? AND unit_id=?").get(roomId,unit.id);
        if (!stored) throw new Error('BACKUP_NOT_FOUND');
        const release = db.prepare('SELECT release FROM chamber_history_releases WHERE request_id=? AND unit_id=?').get(requestId,unit.id);
        return { id: unit.id, envelope: JSON.parse(stored.envelope), ...(release ? { release: JSON.parse(release.release) } : {}), peer: root.id === request.scope.peerId };
      });
    },
    release(roomId, requestId, deviceId, input) {
      const { request, root } = read(roomId,requestId,deviceId), { unitId, release } = input ?? {};
      const target=active(roomId,request.scope.target.deviceId);
      if(canonicalStringify(target.encryptionKey)!==canonicalStringify(request.scope.target.encryptionKey)||canonicalStringify(target.signingKey)!==canonicalStringify(request.scope.target.signingKey))throw new Error('UNAUTHORIZED');
      if (root.id !== request.scope.peerId || !request.scope.units.some(unit => unit.id === unitId && unit.envelopeHash === release?.envelopeHash) ||
        !release || Object.keys(release).sort().join(',') !== 'delivery,envelopeHash,peerProof,peerSignature,v' || release.v !== 1 ||
        !release.delivery || Object.keys(release.delivery).sort().join(',') !== 'ciphertext,enc' || !/^[A-Za-z0-9_-]{87}$/.test(release.delivery.enc) ||
        !/^[A-Za-z0-9_-]{22,2048}$/.test(release.delivery.ciphertext) ||
        canonicalStringify(release.peerProof) !== canonicalStringify({ ...request.proof, identityId: root.id,
          payloadHash: personalHash({ purpose:'chamber-history-release-v1',ownerRequestHash:personalHash(request.proof),envelopeHash:release.envelopeHash,delivery:release.delivery }) }) ||
        !verifyPersonalProof(root,release.peerProof,release.peerSignature)) throw new Error('INVALID_BACKUP');
      const serialized = canonicalStringify(release);
      const existing = db.prepare('SELECT release FROM chamber_history_releases WHERE request_id=? AND unit_id=?').get(requestId,unitId);
      if (existing && existing.release !== serialized) throw new Error('BACKUP_CONFLICT');
      if (!existing) {
        const used=db.prepare('SELECT COALESCE(SUM(length(release)),0) AS n FROM chamber_history_releases').get().n + db.prepare('SELECT COALESCE(SUM(length(request)),0) AS n FROM chamber_history_requests').get().n;
        if(used+Buffer.byteLength(serialized)>64*1024**2)throw new Error('BACKUP_QUOTA');
        db.prepare('INSERT INTO chamber_history_releases VALUES(?,?,?)').run(requestId,unitId,serialized);
      }
      return { saved: true };
    },
  };
}
