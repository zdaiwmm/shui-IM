import {canonicalStringify} from './protocol.mjs';
import {personalHash,verifyPersonalDeviceBinding,verifyPersonalProof} from './personal-protocol.mjs';
const same=(a,b)=>canonicalStringify(a)===canonicalStringify(b);
export function createChamberMigrations(db,{getMember,roomState,chamberInvitations,personalDirectory}) {
  const read=roomId=>db.prepare('SELECT * FROM chamber_migrations WHERE room_id=?').get(roomId);
  const status=roomId=>{const r=read(roomId);return {bindings:r?JSON.parse(r.bindings):{},verified:r?JSON.parse(r.verified):{},activated:Boolean(r?.activated)};};
  return {
    status,
    async bind(roomId,deviceId,binding) {
      const m=getMember(roomId,deviceId),state=roomState(roomId);
      if(!m || m.status!=='active' || !state?.sealedAt || state.protocol!=='mls-rfc9420' || chamberInvitations.exists(roomId) ||
        !await verifyPersonalDeviceBinding(binding,{deviceId:m.deviceId,encryptionKey:m.encryptionKey,signingKey:m.signingKey,mlsKeyPackage:m.mlsKeyPackage}))throw new Error('INVALID_BACKUP');
      db.exec('BEGIN IMMEDIATE');
      try {
        if(getMember(roomId,deviceId)?.status!=='active' || chamberInvitations.exists(roomId))throw new Error('UNAUTHORIZED');
        const current=status(roomId),bindings=current.bindings;
        if(bindings[m.role]&&!same(bindings[m.role],binding))throw new Error('BACKUP_CONFLICT');
        if(Object.values(bindings).some(b=>b.identity.id===binding.identity.id)&&!bindings[m.role])throw new Error('INVALID_BACKUP');
        bindings[m.role]=binding;personalDirectory.register(binding.identity);
        db.prepare('INSERT INTO chamber_migrations(room_id,bindings,base_seq) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET bindings=excluded.bindings').run(roomId,canonicalStringify(bindings),state.nextSeq);
        db.exec('COMMIT');return status(roomId);
      }catch(cause){db.exec('ROLLBACK');throw cause;}
    },
    verify(roomId,deviceId,input) {
      const member=getMember(roomId,deviceId),current=status(roomId),{payload,proof,signature}=input??{},owner=member&&current.bindings[member.role]?.identity;
      if(!owner || member.status!=='active' || current.activated || Object.keys(payload??{}).sort().join(',')!=='generation,historyRequestId,ownerId,purpose,roomId,scopeHash,targetId,upperSeq,v' ||
        payload.v!==1 || payload.purpose!=='chamber-migration-verification-v1' || payload.roomId!==roomId || payload.ownerId!==owner.id || payload.targetId!==deviceId || payload.generation!==1 ||
        proof?.roomId!==roomId || proof.deviceId!==deviceId || proof.version!==1 || proof.payloadHash!==personalHash(payload) || !verifyPersonalProof(owner,proof,signature))throw new Error('INVALID_BACKUP');
      const request=db.prepare('SELECT * FROM chamber_history_requests WHERE room_id=? AND request_id=?').get(roomId,payload.historyRequestId);
      const restored=request&&JSON.parse(request.request);
      const newDevice=db.prepare("SELECT request FROM chamber_device_requests WHERE room_id=? AND target_id=? AND status='approved'").get(roomId,deviceId);
      if(!newDevice || !restored || request.target_id!==deviceId || request.owner_id!==owner.id || Date.parse(request.expires_at)<=Date.now() || restored.proof.payloadHash!==payload.scopeHash ||
        restored.scope.scope!==(member.role==='creator'?'all':'chat') || payload.upperSeq!==Math.max(...restored.scope.heads.map(h=>h.upperSeq)) ||
        db.prepare('SELECT COUNT(*) AS n FROM chamber_history_releases WHERE request_id=?').get(payload.historyRequestId).n!==restored.scope.units.length ||
        payload.upperSeq<read(roomId).base_seq)throw new Error('BACKUP_NOT_FOUND');
      return personalDirectory.authorize(proof,signature,'bind-legacy-room',identity=>{
        if(identity.id!==owner.id || getMember(roomId,deviceId)?.status!=='active')throw new Error('UNAUTHORIZED');
        const verified=status(roomId).verified;verified[member.role]=input;
        db.prepare('UPDATE chamber_migrations SET verified=? WHERE room_id=? AND activated=0').run(canonicalStringify(verified),roomId);return status(roomId);
      });
    },
  };
}
