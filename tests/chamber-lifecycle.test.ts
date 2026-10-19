import { mkdtemp,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createStore} from '../server/storage.mjs';
import {personalHash} from '../server/personal-protocol.mjs';
import {generateIdentity,createJoinProof,bundleFingerprint} from '../src/lib/crypto';
import {randomBase64Url,toBase64Url} from '../src/lib/base64';
import {sha256} from '@noble/hashes/sha2.js';
import {bindPersonalDevice} from '../src/lib/personal-device-binding';
import {signPersonalProof} from '../src/lib/personal-identity';
import {createCreatorMlsState,prepareCreatorWelcome,joinMlsGroup,encryptMlsApplication,decryptMlsApplication} from '../src/lib/mls';
import {verifyChamberClosure,verifyChamberReopen,type ChamberReopenOffer,type ChamberReopenProposal,type PendingChamberReopen} from '../src/lib/chamber-lifecycle';
import type {Vault,RoomMember} from '../src/lib/types';
const dirs:string[]=[],roots={creator:new Uint8Array(16).fill(21),joiner:new Uint8Array(16).fill(22)};
afterEach(async()=>{vi.useRealTimers();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(){
  const dataDir=await mkdtemp(path.join(tmpdir(),'chamber-lifecycle-'));dirs.push(dataDir);
  const store=await createStore({dataDir}),creator=await generateIdentity(),joiner=await generateIdentity(),pairing=randomBase64Url(32),aToken=randomBase64Url(32),bToken=randomBase64Url(32),invite=randomBase64Url(32),secret=randomBase64Url(32);
  const a=await bindPersonalDevice(roots.creator,creator),b=await bindPersonalDevice(roots.joiner,joiner);
  const room=store.createRoom(creator.publicBundle,aToken,invite,'A',[],a),proof=await createJoinProof(pairing,joiner.publicBundle),candidate={bundle:joiner.publicBundle,proof,binding:b};
  store.chamberInvitations.claim(room.roomId,secret);store.chamberInvitations.ready(room.roomId,secret,candidate);
  store.joinRoom(room.roomId,joiner.publicBundle,proof,bToken,'B',[],{secret,code:store.chamberInvitations.state(room.roomId,true).code,binding:b});
  const entries={creator:{v:1 as const,roomId:room.roomId,role:'creator' as const,name:'Synthetic',creatorFingerprint:await bundleFingerprint(creator.publicBundle),heads:[],participants:[{role:'creator' as const,binding:a,bundle:creator.publicBundle},{role:'joiner' as const,binding:b,bundle:joiner.publicBundle}]},joiner:null as any};
  entries.joiner={...entries.creator,role:'joiner'};
  async function signed(role:'creator'|'joiner',action:string,deviceId:string,version:number,payload:unknown){const root=role==='creator'?a.identity:b.identity;
    const proof=store.personalDirectory.challenge(root.id,{action,roomId:room.roomId,deviceId,version,payloadHash:personalHash(payload)});return {proof,signature:await signPersonalProof(roots[role],proof)};}
  const closePayload={v:1,purpose:'chamber-close-v1',roomId:room.roomId,version:1,generation:1,closed:true};
  const closeInput={payload:closePayload,...await signed('creator','close-room',creator.publicBundle.deviceId,1,closePayload)};
  async function offer(role:'creator'|'joiner',requestId=crypto.randomUUID(),recovery=false){
    const identity=await generateIdentity(),binding=await bindPersonalDevice(roots[role],identity),token=randomBase64Url(32);
    const payload={v:1 as const,purpose:recovery?'chamber-recovery-offer-v1' as const:'chamber-reopen-offer-v1' as const,roomId:room.roomId,role,requestId,version:recovery?1:2,generation:2,bundle:identity.publicBundle,binding,
      tokenHash:toBase64Url(sha256(new TextEncoder().encode(token))),deviceName:role,capabilities:[]};
    const input={payload,...await signed(role,'restore-room',identity.publicBundle.deviceId,payload.version,payload)} as ChamberReopenOffer;
    return {identity,binding,token,input};
  }
  return {store,dataDir,room,creator,joiner,a,b,aToken,bToken,entries,signed,closeInput,offer};
}
describe('signed close and two-original-root reopen',()=>{
  it('rejects retired migration offers and persisted cutovers without changing existing rooms or tokens',async()=>{
    const f=await fixture(),db=new DatabaseSync(path.join(f.dataDir,'quiet-room.sqlite'));
    try {
      const a=await f.offer('creator',crypto.randomUUID(),true);
      const payload={...a.input.payload,purpose:'chamber-migration-offer-v1'};
      const retired={payload,...await f.signed('creator','restore-room',payload.bundle.deviceId,1,payload)};
      expect(()=>f.store.chamberLifecycle.offer(f.room.roomId,retired)).toThrow('INVALID_BACKUP');
      db.prepare('INSERT INTO chamber_reopen(room_id,request_id,version,expires_at,offers,proposal) VALUES(?,?,?,?,?,?)').run(
        f.room.roomId,payload.requestId,1,retired.proof.expiresAt,JSON.stringify({creator:retired}),JSON.stringify({purpose:'chamber-migration-proposal-v1'}));
      const before=db.prepare('SELECT * FROM chamber_reopen WHERE room_id=?').get(f.room.roomId);
      expect(()=>f.store.chamberLifecycle.status(f.room.roomId,a.token)).toThrow('INVALID_BACKUP');
      await expect(f.store.chamberLifecycle.propose(f.room.roomId,a.token,{})).rejects.toThrow('INVALID_BACKUP');
      expect(()=>f.store.chamberLifecycle.approve(f.room.roomId,a.token,{})).toThrow('INVALID_BACKUP');
      expect(()=>f.store.chamberLifecycle.cancel(f.room.roomId,a.token,{})).toThrow('INVALID_BACKUP');
      expect(db.prepare('SELECT * FROM chamber_reopen WHERE room_id=?').get(f.room.roomId)).toEqual(before);
      expect(f.store.chamberLifecycle.state(f.room.roomId)).toMatchObject({generation:1,version:1,closed:false});
      expect(f.store.authenticatedDevice(f.room.roomId,f.aToken)?.deviceId).toBe(f.creator.publicBundle.deviceId);
      expect(f.store.authenticatedDevice(f.room.roomId,f.bToken)?.deviceId).toBe(f.joiner.publicBundle.deviceId);
      expect(f.store.authenticatedDevice(f.room.roomId,a.token)).toBeNull();
    } finally {db.close();f.store.close();}
  });
  it('does not adopt stored staged bindings or delete their persisted rows on restart',async()=>{
    const f=await fixture(),db=new DatabaseSync(path.join(f.dataDir,'quiet-room.sqlite'));
    let reopened;
    try {
      db.exec("CREATE TABLE chamber_migrations(room_id TEXT PRIMARY KEY,bindings TEXT,verified TEXT,activated INTEGER,base_seq INTEGER)");
      const bindings=JSON.stringify({creator:f.a,joiner:f.b});
      db.prepare("INSERT INTO chamber_migrations VALUES(?,?,'{}',0,0)").run(f.room.roomId,bindings);
      db.prepare('DELETE FROM chamber_rooms WHERE room_id=?').run(f.room.roomId);
      expect(f.store.chamberInvitations.state(f.room.roomId)).toBeNull();
      expect(()=>f.store.personalDirectory.challenge(f.a.identity.id,{action:'bind-legacy-room',roomId:f.room.roomId,deviceId:f.creator.publicBundle.deviceId,version:1,payloadHash:randomBase64Url(32)})).toThrow('INVALID_JSON');
      f.store.close();reopened=await createStore({dataDir:f.dataDir});
      expect(reopened.chamberInvitations.state(f.room.roomId)).toBeNull();
      expect(db.prepare('SELECT bindings FROM chamber_migrations WHERE room_id=?').get(f.room.roomId)?.bindings).toBe(bindings);
      expect(reopened.authenticatedDevice(f.room.roomId,f.aToken)?.deviceId).toBe(f.creator.publicBundle.deviceId);
      expect(reopened.authenticatedDevice(f.room.roomId,f.bToken)?.deviceId).toBe(f.joiner.publicBundle.deviceId);
    } finally {db.close();if(reopened)reopened.close();else f.store.close();}
  });
  it('revokes both participants atomically, retains the room and accepts only the exact retry receipt',async()=>{
    const f=await fixture();try{
      const state=f.store.chamberLifecycle.close(f.room.roomId,f.creator.publicBundle.deviceId,f.closeInput);
      expect(state).toMatchObject({closed:true,version:2,generation:1});expect(verifyChamberClosure(state,f.entries.creator)).toBe(true);
      expect(f.store.authenticatedDevice(f.room.roomId,f.aToken)).toBeNull();expect(f.store.authenticatedDevice(f.room.roomId,f.bToken)).toBeNull();
      expect(f.store.roomState(f.room.roomId)).not.toBeNull();expect(f.store.chamberLifecycle.close(f.room.roomId,f.creator.publicBundle.deviceId,f.closeInput)).toEqual(state);
      expect(verifyChamberClosure({...state,version:3},f.entries.creator)).toBe(false);
    }finally{f.store.close();}
  });
  it('requires both roots on the same device set and creates fresh MLS keys with old tokens permanently revoked',async()=>{
    const f=await fixture();try{
      f.store.chamberLifecycle.close(f.room.roomId,f.creator.publicBundle.deviceId,f.closeInput);
      const a=await f.offer('creator');let snapshot=await f.store.chamberLifecycle.offer(f.room.roomId,a.input);
      expect(f.store.chamberLifecycle.closed(f.room.roomId)).toBe(true);expect(f.store.authenticatedDevice(f.room.roomId,a.token)).toBeNull();
      const b=await f.offer('joiner',a.input.payload.requestId);snapshot=await f.store.chamberLifecycle.offer(f.room.roomId,b.input);
      const members:RoomMember[]=[{...a.identity.publicBundle,role:'creator',status:'active',joinProof:null,addedBy:null},{...b.identity.publicBundle,role:'joiner',status:'active',joinProof:null,addedBy:null}];
      const base={v:3 as const,roomId:f.room.roomId,pairingSecret:'',creatorFingerprint:f.entries.creator.creatorFingerprint,members,lastSeq:0,createdAt:new Date().toISOString(),protocol:'mls-rfc9420' as const};
      const av:Vault={...base,identity:a.identity,accessToken:a.token,role:'creator',mls:await createCreatorMlsState(f.room.roomId,a.identity,members)};av.mls=await prepareCreatorWelcome(av);
      const proposal:ChamberReopenProposal={v:1,purpose:'chamber-reopen-proposal-v1',roomId:f.room.roomId,requestId:snapshot.requestId,version:2,generation:2,expiresAt:snapshot.expiresAt,offers:{creator:a.input,joiner:b.input},welcome:av.mls.pendingWelcome!};
      snapshot=await f.store.chamberLifecycle.propose(f.room.roomId,a.token,proposal);
      const bv:Vault={...base,identity:b.identity,accessToken:b.token,role:'joiner'};bv.mls=await joinMlsGroup(bv,proposal.welcome);
      const pending:PendingChamberReopen={entry:f.entries.creator,offer:a.input,proposal,mls:av.mls};await verifyChamberReopen(pending,snapshot);
      const aApproval=await f.signed('creator','restore-room',a.identity.publicBundle.deviceId,2,proposal);
      snapshot=f.store.chamberLifecycle.approve(f.room.roomId,a.token,aApproval);expect(snapshot.result).toBeNull();expect(f.store.chamberLifecycle.closed(f.room.roomId)).toBe(true);
      const changed={...proposal,requestId:crypto.randomUUID()},badApproval=await f.signed('joiner','restore-room',b.identity.publicBundle.deviceId,2,changed);
      expect(()=>f.store.chamberLifecycle.approve(f.room.roomId,b.token,badApproval)).toThrow('INVALID_BACKUP');
      snapshot=f.store.chamberLifecycle.approve(f.room.roomId,b.token,await f.signed('joiner','restore-room',b.identity.publicBundle.deviceId,2,proposal));
      expect(snapshot.result).toMatchObject({version:3,generation:2});await verifyChamberReopen(pending,snapshot);
      expect(f.store.authenticatedDevice(f.room.roomId,a.token)?.deviceId).toBe(a.identity.publicBundle.deviceId);expect(f.store.authenticatedDevice(f.room.roomId,f.aToken)).toBeNull();
      const payload={v:1 as const,kind:'text' as const,text:'New generation',sentAt:new Date().toISOString()};
      const encrypted=await encryptMlsApplication(av,payload,crypto.randomUUID());
      expect((await decryptMlsApplication(bv,encrypted.envelope)).payload).toEqual(payload);
      vi.useFakeTimers();vi.setSystemTime(Date.now()+31*60_000);
      const resumed=f.store.chamberLifecycle.status(f.room.roomId,b.token);
      expect(resumed.result).toEqual(snapshot.result);await verifyChamberReopen(pending,resumed);
    }finally{f.store.close();}
  });
  it('rejects expired recovery requests without reopening or activating the pending devices',async()=>{
    const f=await fixture();try{
      f.store.chamberLifecycle.close(f.room.roomId,f.creator.publicBundle.deviceId,f.closeInput);const a=await f.offer('creator');await f.store.chamberLifecycle.offer(f.room.roomId,a.input);
      vi.useFakeTimers();vi.setSystemTime(Date.now()+31*60_000);
      expect(()=>f.store.chamberLifecycle.status(f.room.roomId,a.token)).toThrow('PERSONAL_PROOF_EXPIRED');expect(f.store.chamberLifecycle.closed(f.room.roomId)).toBe(true);
      expect(f.store.authenticatedDevice(f.room.roomId,a.token)).toBeNull();
    }finally{f.store.close();}
  });
  it('cancels only the scoped request and allows a fresh request without changing the room or original devices',async()=>{
    const f=await fixture();try{
      const a=await f.offer('creator',crypto.randomUUID(),true);await f.store.chamberLifecycle.offer(f.room.roomId,a.input);
      const payload={purpose:'chamber-recovery-cancel-v1',roomId:f.room.roomId,requestId:a.input.payload.requestId,version:1};
      const wrong=await f.signed('joiner','restore-room',a.identity.publicBundle.deviceId,1,payload);
      expect(()=>f.store.chamberLifecycle.cancel(f.room.roomId,a.token,wrong)).toThrow('UNAUTHORIZED');
      const input=await f.signed('creator','restore-room',a.identity.publicBundle.deviceId,1,payload);
      expect(f.store.chamberLifecycle.cancel(f.room.roomId,a.token,input)).toEqual({cancelled:true});
      expect(()=>f.store.chamberLifecycle.status(f.room.roomId,a.token)).toThrow('PERSONAL_PROOF_EXPIRED');
      expect(f.store.chamberLifecycle.state(f.room.roomId)).toMatchObject({closed:false,generation:1,version:1});
      expect(f.store.authenticatedDevice(f.room.roomId,f.aToken)).not.toBeNull();expect(f.store.authenticatedDevice(f.room.roomId,a.token)).toBeNull();
      const next=await f.offer('creator',crypto.randomUUID(),true);expect((await f.store.chamberLifecycle.offer(f.room.roomId,next.input)).requestId).toBe(next.input.payload.requestId);
    }finally{f.store.close();}
  });
  it('recovers an open room after both devices are lost using both original roots, while a single root cannot replace either device',async()=>{
    const f=await fixture();try{
      const a=await f.offer('creator',crypto.randomUUID(),true);let snapshot=await f.store.chamberLifecycle.offer(f.room.roomId,a.input);
      expect(f.store.authenticatedDevice(f.room.roomId,f.aToken)).not.toBeNull();expect(f.store.authenticatedDevice(f.room.roomId,a.token)).toBeNull();
      const b=await f.offer('joiner',a.input.payload.requestId,true);snapshot=await f.store.chamberLifecycle.offer(f.room.roomId,b.input);
      const members:RoomMember[]=[{...a.identity.publicBundle,role:'creator',status:'active',joinProof:null},{...b.identity.publicBundle,role:'joiner',status:'active',joinProof:null}];
      const vault:Vault={v:3,roomId:f.room.roomId,role:'creator',identity:a.identity,accessToken:a.token,pairingSecret:'',creatorFingerprint:f.entries.creator.creatorFingerprint,members,lastSeq:0,createdAt:new Date().toISOString(),protocol:'mls-rfc9420',mls:await createCreatorMlsState(f.room.roomId,a.identity,members)};
      vault.mls=await prepareCreatorWelcome(vault);
      const proposal:ChamberReopenProposal={v:1,purpose:'chamber-recovery-proposal-v1',roomId:f.room.roomId,requestId:snapshot.requestId,version:1,generation:2,expiresAt:snapshot.expiresAt,offers:{creator:a.input,joiner:b.input},welcome:vault.mls.pendingWelcome!};
      snapshot=await f.store.chamberLifecycle.propose(f.room.roomId,a.token,proposal);
      snapshot=f.store.chamberLifecycle.approve(f.room.roomId,a.token,await f.signed('creator','restore-room',a.identity.publicBundle.deviceId,1,proposal));
      expect(snapshot.result).toBeNull();expect(f.store.authenticatedDevice(f.room.roomId,f.bToken)).not.toBeNull();
      snapshot=f.store.chamberLifecycle.approve(f.room.roomId,b.token,await f.signed('joiner','restore-room',b.identity.publicBundle.deviceId,1,proposal));
      expect(snapshot.result).toMatchObject({generation:2,version:2});expect(f.store.authenticatedDevice(f.room.roomId,f.aToken)).toBeNull();expect(f.store.authenticatedDevice(f.room.roomId,a.token)).not.toBeNull();
      await verifyChamberReopen({entry:f.entries.creator,offer:a.input,proposal,mls:vault.mls},snapshot);
    }finally{f.store.close();}
  });
});
