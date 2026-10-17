import { canonicalStringify, validatePublicBundle, validateMlsWelcomeShape, verifyEnvelopeSignature } from './protocol.mjs';
import { personalHash, verifyPersonalProof, verifyPersonalDeviceBinding } from './personal-protocol.mjs';
import { createHash } from 'node:crypto';
const same=(a,b)=>canonicalStringify(a)===canonicalStringify(b);
const fields=(x,list)=>!!x && Object.keys(x).sort().join(',')===list;
const roles=['creator','joiner'];
export function createChamberLifecycle(db,{getMember,roomState,chamberInvitations,personalDirectory}) {
  db.exec(`CREATE TABLE IF NOT EXISTS chamber_lifecycle(room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 1,closed INTEGER NOT NULL DEFAULT 0,receipt TEXT);
    CREATE TABLE IF NOT EXISTS chamber_reopen(room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,version INTEGER NOT NULL,expires_at TEXT NOT NULL,offers TEXT NOT NULL,proposal TEXT,approvals TEXT NOT NULL DEFAULT '{}',result TEXT);`);
  const state=roomId=> {
    const row=db.prepare('SELECT * FROM chamber_lifecycle WHERE room_id=?').get(roomId);
    return row?{version:row.version,generation:row.generation,closed:Boolean(row.closed),receipt:row.receipt?JSON.parse(row.receipt):null}:{version:1,generation:1,closed:false,receipt:null};
  };
  const roots=roomId=>{const r=chamberInvitations.state(roomId);if(!r?.joinerBinding)throw new Error('ROOM_SEALED');return {creator:r.creatorBinding.identity,joiner:r.joinerBinding.identity};};
  const snapshot=row=>({requestId:row.request_id,version:row.version,expiresAt:row.expires_at,offers:JSON.parse(row.offers),proposal:row.proposal?JSON.parse(row.proposal):null,approvals:JSON.parse(row.approvals),result:row.result?JSON.parse(row.result):null});
  const row=roomId=>db.prepare('SELECT * FROM chamber_reopen WHERE room_id=?').get(roomId);
  const migration=roomId=>{
    const r=db.prepare('SELECT * FROM chamber_migrations WHERE room_id=? AND activated=0').get(roomId);
    return r?{bindings:JSON.parse(r.bindings),verified:JSON.parse(r.verified)}:null;
  };
  const allowed=(roomId,s,purpose)=>purpose==='chamber-migration-offer-v1'?!s.closed&&!chamberInvitations.exists(roomId)&&Boolean(migration(roomId)?.verified.creator&&migration(roomId)?.verified.joiner):
    purpose==='chamber-recovery-offer-v1'?!s.closed&&chamberInvitations.exists(roomId):s.closed&&chamberInvitations.exists(roomId);
  const fenced=roomId=> {
    db.prepare('DELETE FROM push_subscriptions WHERE room_id=?').run(roomId);
    db.prepare('DELETE FROM unread_observers WHERE room_id=?').run(roomId);
    db.prepare('DELETE FROM device_links WHERE room_id=?').run(roomId);
    db.prepare('DELETE FROM repair_links WHERE room_id=?').run(roomId);
    db.prepare("UPDATE recovery_requests SET status='expired' WHERE room_id=? AND status='pending'").run(roomId);
    db.prepare('DELETE FROM chamber_history_requests WHERE room_id=?').run(roomId);
    db.prepare('DELETE FROM chamber_device_requests WHERE room_id=?').run(roomId);
    db.prepare("UPDATE joint_recoveries SET expires_at=? WHERE room_id=? AND result IS NULL").run(new Date().toISOString(),roomId);
    db.prepare('UPDATE chamber_rooms SET code=NULL,attempts=5 WHERE room_id=?').run(roomId);
  };
  const authenticatedRow=(roomId,token)=> {
    const r=row(roomId);if(!r || !/^[A-Za-z0-9_-]{43}$/.test(token??''))throw new Error('UNAUTHORIZED');
    const hash=createHash('sha256').update(token).digest('base64url');
    if(!Object.values(JSON.parse(r.offers)).some(o=>o.payload.tokenHash===hash))throw new Error('UNAUTHORIZED');
    if(!r.result && Date.parse(r.expires_at)<=Date.now())throw new Error('PERSONAL_PROOF_EXPIRED');
    return r;
  };
  return {
    state,
    closed:roomId=>state(roomId).closed,
    deviceForToken(roomId,token) {
      if(!/^[A-Za-z0-9_-]{43}$/.test(token??''))throw new Error('UNAUTHORIZED');
      const device=db.prepare('SELECT device_id FROM members WHERE room_id=? AND access_hash=?').get(roomId,createHash('sha256').update(token).digest());
      if(!device)throw new Error('UNAUTHORIZED');return device.device_id;
    },
    inspect(roomId,input) {
      const {proof,signature}=input??{};
      if(proof?.roomId!==roomId || proof.payloadHash!==personalHash({purpose:'chamber-inspect-v1',roomId}))throw new Error('UNAUTHORIZED');
      return personalDirectory.authorize(proof,signature,'read-directory',identity=>{
        if(!Object.values(roots(roomId)).some(root=>root.id===identity.id))throw new Error('UNAUTHORIZED');
        const r=row(roomId);return {...state(roomId),migration:migration(roomId),pending:r&&!r.result&&Date.parse(r.expires_at)>Date.now()?{requestId:r.request_id,expiresAt:r.expires_at,purpose:Object.values(JSON.parse(r.offers))[0].payload.purpose}:null};
      });
    },
    close(roomId,deviceId,input) {
      if(!chamberInvitations.exists(roomId))throw new Error('PERSONAL_IDENTITY_REQUIRED');
      const rootSet=roots(roomId),member=getMember(roomId,deviceId),owner=member&&rootSet[member.role],before=state(roomId);
      const {payload,proof,signature}=input??{};
      if(before.closed && same(before.receipt,input))return before;
      if(!member || member.status!=='active' || !owner || !fields(input,'payload,proof,signature') ||
        !fields(payload,'closed,generation,purpose,roomId,v,version') || payload.v!==1 || payload.purpose!=='chamber-close-v1' || payload.roomId!==roomId ||
        payload.closed!==true || payload.version!==before.version || payload.generation!==before.generation || proof?.deviceId!==deviceId ||
        proof.roomId!==roomId || proof.version!==before.version || proof.payloadHash!==personalHash(payload))throw new Error('INVALID_BACKUP');
      if(before.closed) { if(same(before.receipt,input))return before;throw new Error('ROOM_CLOSED'); }
      return personalDirectory.authorize(proof,signature,'close-room',identity=> {
        if(identity.id!==owner.id || state(roomId).version!==before.version || getMember(roomId,deviceId)?.status!=='active')throw new Error('UNAUTHORIZED');
        fenced(roomId);db.prepare('DELETE FROM chamber_reopen WHERE room_id=?').run(roomId);
        db.prepare("UPDATE members SET status='revoked',revoked_at=? WHERE room_id=? AND status IN ('active','pending')").run(new Date().toISOString(),roomId);
        db.prepare('INSERT INTO chamber_lifecycle VALUES(?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET version=excluded.version,closed=1,receipt=excluded.receipt')
          .run(roomId,before.version+1,before.generation,1,canonicalStringify(input));
        return state(roomId);
      });
    },
    offer(roomId,input) {
      const {payload,proof,signature}=input??{},s=state(roomId),rootSet=roots(roomId),owner=rootSet[payload?.role];
      const migrate=payload?.purpose==='chamber-migration-offer-v1';
      if(!allowed(roomId,s,payload?.purpose) || !owner || !fields(input,'payload,proof,signature') ||
        !fields(payload,'binding,bundle,capabilities,deviceName,generation,purpose,requestId,role,roomId,tokenHash,v,version') ||
        payload.v!==1 || !['chamber-reopen-offer-v1','chamber-migration-offer-v1','chamber-recovery-offer-v1'].includes(payload.purpose) || payload.roomId!==roomId || payload.version!==s.version || payload.generation!==s.generation+1 ||
        !/^[0-9a-f-]{36}$/i.test(payload.requestId) || !validatePublicBundle(payload.bundle) || !payload.bundle.mlsKeyPackage ||
        Object.keys(payload.bundle).sort().join(',')!=='deviceId,encryptionKey,mlsKeyPackage,signingKey' || getMember(roomId,payload.bundle.deviceId) ||
        !same(payload.binding.identity,owner) || typeof payload.deviceName!=='string' || payload.deviceName.length<1 || payload.deviceName.length>40 ||
        !Array.isArray(payload.capabilities) || payload.capabilities.length>32 || !payload.capabilities.every(x=>/^[a-z0-9-]{1,40}$/.test(x)) ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.tokenHash) || proof?.roomId!==roomId || proof.deviceId!==payload.bundle.deviceId || proof.version!==s.version || proof.payloadHash!==personalHash(payload))throw new Error('INVALID_BACKUP');
      return (async()=> {
        if(!await verifyPersonalDeviceBinding(payload.binding,payload.bundle))throw new Error('UNAUTHORIZED');
        const prior=row(roomId);
        if(prior && Date.parse(prior.expires_at)>Date.now() && prior.request_id===payload.requestId && same(JSON.parse(prior.offers)[payload.role],input))return snapshot(prior);
        return personalDirectory.authorize(proof,signature,'restore-room',identity=> {
          if(identity.id!==owner.id || !allowed(roomId,state(roomId),payload.purpose) || state(roomId).version!==s.version)throw new Error('UNAUTHORIZED');
          let r=row(roomId);
          if(!r || Date.parse(r.expires_at)<=Date.now()) {
            db.prepare('DELETE FROM chamber_reopen WHERE room_id=?').run(roomId);
            db.prepare("INSERT INTO chamber_reopen(room_id,request_id,version,expires_at,offers) VALUES(?,?,?,?,?)").run(roomId,payload.requestId,s.version,proof.expiresAt,canonicalStringify({[payload.role]:input}));
          } else {
            if(r.request_id!==payload.requestId || r.version!==s.version || r.proposal || Object.values(JSON.parse(r.offers)).some(o=>o.payload.purpose!==payload.purpose))throw new Error('BACKUP_CONFLICT');
            const offers=JSON.parse(r.offers);if(offers[payload.role])throw new Error('BACKUP_CONFLICT');
            offers[payload.role]=input;db.prepare('UPDATE chamber_reopen SET offers=? WHERE room_id=?').run(canonicalStringify(offers),roomId);
          }
          return snapshot(row(roomId));
        });
      })();
    },
    status(roomId,token) {return snapshot(authenticatedRow(roomId,token));},
    cancel(roomId,token,input) {
      const r=authenticatedRow(roomId,token);if(r.result)throw new Error('BACKUP_CONFLICT');
      const {proof,signature}=input??{},offers=JSON.parse(r.offers),role=roles.find(role=>offers[role]?.proof.identityId===proof?.identityId);
      if(!role||proof.roomId!==roomId||proof.deviceId!==offers[role].payload.bundle.deviceId||proof.version!==r.version||
        proof.payloadHash!==personalHash({purpose:'chamber-recovery-cancel-v1',roomId,requestId:r.request_id,version:r.version}))throw new Error('UNAUTHORIZED');
      return personalDirectory.authorize(proof,signature,'restore-room',()=>{
        const latest=authenticatedRow(roomId,token);if(latest.result||latest.request_id!==r.request_id)throw new Error('BACKUP_CONFLICT');
        db.prepare('UPDATE chamber_reopen SET expires_at=? WHERE room_id=? AND request_id=?').run(new Date().toISOString(),roomId,r.request_id);return {cancelled:true};
      });
    },
    async propose(roomId,token,proposal) {
      const r=authenticatedRow(roomId,token),offers=JSON.parse(r.offers),s=state(roomId);
      const migrate=offers.creator?.payload.purpose==='chamber-migration-offer-v1';
      if(!allowed(roomId,s,offers.creator?.payload.purpose) || !roles.every(role=>offers[role]) || !fields(proposal,migrate?'expiresAt,generation,migration,offers,purpose,requestId,roomId,v,version,welcome':'expiresAt,generation,offers,purpose,requestId,roomId,v,version,welcome') ||
        proposal.v!==1 || proposal.purpose!==offers.creator.payload.purpose.replace('-offer-','-proposal-') || migrate&&!same(proposal.migration,migration(roomId).verified) || proposal.roomId!==roomId || proposal.requestId!==r.request_id ||
        proposal.version!==r.version || proposal.generation!==s.generation+1 || proposal.expiresAt!==r.expires_at || !same(proposal.offers,offers) ||
        proposal.welcome?.senderId!==offers.creator.payload.bundle.deviceId || proposal.welcome?.recipientId!==offers.joiner.payload.bundle.deviceId ||
        !validateMlsWelcomeShape(proposal.welcome,roomId) || Object.keys(proposal.welcome).sort().join(',')!=='protocol,recipientId,roomId,senderId,signature,v,welcome' ||
        !await verifyEnvelopeSignature(proposal.welcome,offers.creator.payload.bundle.signingKey))throw new Error('INVALID_BACKUP');
      const latest=authenticatedRow(roomId,token);
      if(latest.result)return snapshot(latest);
      if(!allowed(roomId,state(roomId),offers.creator.payload.purpose) || state(roomId).version!==r.version)throw new Error('BACKUP_CONFLICT');
      if(latest.proposal && !same(JSON.parse(latest.proposal),proposal))throw new Error('BACKUP_CONFLICT');
      if(!latest.proposal)db.prepare('UPDATE chamber_reopen SET proposal=? WHERE room_id=? AND proposal IS NULL').run(canonicalStringify(proposal),roomId);
      return snapshot(row(roomId));
    },
    approve(roomId,token,input) {
      const r=authenticatedRow(roomId,token);if(r.result)return snapshot(r);
      const proposal=r.proposal&&JSON.parse(r.proposal),rootSet=roots(roomId),{proof,signature}=input??{},role=roles.find(role=>rootSet[role].id===proof?.identityId);
      if(!proposal || !role || !fields(input,'proof,signature') || proof.roomId!==roomId || proof.deviceId!==proposal.offers[role].payload.bundle.deviceId ||
        proof.version!==r.version || proof.payloadHash!==personalHash(proposal))throw new Error('INVALID_BACKUP');
      return personalDirectory.authorize(proof,signature,'restore-room',identity=> {
        const latest=authenticatedRow(roomId,token),s=state(roomId);
        const migrate=proposal.purpose==='chamber-migration-proposal-v1';
        if(identity.id!==rootSet[role].id || !allowed(roomId,s,proposal.offers.creator.payload.purpose) || s.version!==r.version || latest.proposal!==r.proposal)throw new Error('UNAUTHORIZED');
        const approvals=JSON.parse(latest.approvals);approvals[role]=input;
        db.prepare('UPDATE chamber_reopen SET approvals=? WHERE room_id=?').run(canonicalStringify(approvals),roomId);
        if(roles.every(role=>approvals[role])) {
          const original=roomState(roomId),now=new Date().toISOString(),eventSeq=original.nextMlsEventSeq+1;
          if(migrate) {
            if(!same(proposal.migration,migration(roomId).verified) || roles.some(role=>proposal.migration[role].payload.upperSeq!==original.nextSeq))throw new Error('BACKUP_CONFLICT');
            const bindings=migration(roomId).bindings;
            db.prepare('INSERT INTO chamber_rooms(room_id,creator_binding,joiner_binding,consumed) VALUES(?,?,?,1)').run(roomId,canonicalStringify(bindings.creator),canonicalStringify(bindings.joiner));
            db.prepare('UPDATE chamber_migrations SET activated=1 WHERE room_id=?').run(roomId);
            // Both roots attested that independent devices restored every
            // existing record. Only now retire this room's old private-key
            // checkpoint/archive capabilities; local copies remain untouched.
            db.prepare('DELETE FROM recovery_backups WHERE room_id=?').run(roomId);
          }
          fenced(roomId);
          db.prepare("UPDATE members SET status='revoked',revoked_at=? WHERE room_id=? AND status IN ('active','pending')").run(now,roomId);
          for(const participant of roles) {
            const offer=proposal.offers[participant].payload,bundle=offer.bundle;
            db.prepare(`INSERT INTO members(room_id,device_id,role,encryption_jwk,signing_jwk,mls_key_package,join_proof,access_hash,device_name,status,added_by,join_seq,join_receipt_seq,capabilities,created_at)
              VALUES(?,?,?,?,?,?,NULL,?,?,'active',?,?,?,?,?)`).run(roomId,bundle.deviceId,participant,canonicalStringify(bundle.encryptionKey),canonicalStringify(bundle.signingKey),bundle.mlsKeyPackage,
              Buffer.from(offer.tokenHash,'base64url'),offer.deviceName,original.members.find(m=>m.role===participant&&!m.addedBy).deviceId,original.nextSeq,original.nextReceiptSeq,canonicalStringify(offer.capabilities),now);
          }
          // New MLS generation; no old sender ratchet is restored.
          db.prepare('UPDATE rooms SET window_enabled=0,window_from_seq=0,mls_welcome=?,next_mls_event_seq=?,mls_epoch_offset=? WHERE room_id=?').run(canonicalStringify(proposal.welcome),eventSeq,eventSeq,roomId);
          const result={eventSeq,nextSeq:original.nextSeq,nextReceiptSeq:original.nextReceiptSeq,completedAt:now,generation:s.generation+1,version:s.version+1};
          db.prepare('UPDATE chamber_reopen SET result=? WHERE room_id=?').run(canonicalStringify(result),roomId);
          db.prepare('INSERT INTO chamber_lifecycle VALUES(?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET closed=0,generation=excluded.generation,version=excluded.version,receipt=excluded.receipt').run(roomId,result.version,result.generation,0,canonicalStringify({proposal,approvals}));
        }
        return snapshot(row(roomId));
      });
    },
  };
}
