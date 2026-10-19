import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,expect,it} from 'vitest';
import {createChamberMigrations} from '../server/chamber-migrations.mjs';
import {createPersonalDirectory} from '../server/personal-directory.mjs';
import {personalHash} from '../server/personal-protocol.mjs';
import {generateIdentity} from '../src/lib/crypto';
import {bindPersonalDevice} from '../src/lib/personal-device-binding';
import {signPersonalProof} from '../src/lib/personal-identity';
import {randomBase64Url} from '../src/lib/base64';

const databases:DatabaseSync[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
async function fixture(){
  const db=new DatabaseSync(':memory:');databases.push(db);
  db.exec(`CREATE TABLE rooms(room_id TEXT PRIMARY KEY);
    CREATE TABLE chamber_migrations(room_id TEXT PRIMARY KEY,bindings TEXT,verified TEXT DEFAULT '{}',activated INTEGER DEFAULT 0,base_seq INTEGER);
    CREATE TABLE chamber_history_requests(room_id TEXT,request_id TEXT,target_id TEXT,owner_id TEXT,expires_at TEXT,request TEXT);
    CREATE TABLE chamber_history_releases(request_id TEXT,unit_id TEXT);
    CREATE TABLE chamber_device_requests(room_id TEXT,target_id TEXT,status TEXT,request TEXT);`);
  const roomId=crypto.randomUUID(),root=new Uint8Array(16).fill(31),peerRoot=new Uint8Array(16).fill(32);
  const original=await generateIdentity(),peer=await generateIdentity();
  const binding=await bindPersonalDevice(root,original),peerBinding=await bindPersonalDevice(peerRoot,peer);
  const member={...original.publicBundle,role:'creator',status:'active'};
  const getMember=(_room:string,id:string)=>id===member.deviceId?member:id===peer.publicBundle.deviceId?{...peer.publicBundle,role:'joiner',status:'active'}:null;
  const chamberInvitations={exists:()=>false,state:()=>null};
  const directory=createPersonalDirectory(db,{getMember,chamberInvitations});
  const migrations=createChamberMigrations(db,{getMember,roomState:()=>({sealedAt:new Date().toISOString(),protocol:'mls-rfc9420',nextSeq:7}),chamberInvitations,personalDirectory:directory});
  db.prepare('INSERT INTO rooms VALUES(?)').run(roomId);
  await migrations.bind(roomId,member.deviceId,binding);await migrations.bind(roomId,peer.publicBundle.deviceId,peerBinding);
  const historyRequestId=crypto.randomUUID(),scopeHash=randomBase64Url(32);
  // The history recovery module separately verifies this jointly approved scope.
  const request={scope:{scope:'all',heads:[{upperSeq:7}],units:[{id:'record-1'}]},proof:{payloadHash:scopeHash}};
  db.prepare('INSERT INTO chamber_history_requests VALUES(?,?,?,?,?,?)').run(roomId,historyRequestId,member.deviceId,binding.identity.id,new Date(Date.now()+25*60_000).toISOString(),JSON.stringify(request));
  db.prepare('INSERT INTO chamber_history_releases VALUES(?,?)').run(historyRequestId,'record-1');
  const payload={v:1,purpose:'chamber-migration-verification-v1',roomId,ownerId:binding.identity.id,targetId:member.deviceId,generation:1,historyRequestId,scopeHash,upperSeq:7,stagingDigest:randomBase64Url(32)};
  const signed=async(value:any=payload,otherRoot=false)=>{
    const proof=directory.challenge((otherRoot?peerBinding:binding).identity.id,{action:'bind-legacy-room',roomId,deviceId:value.targetId,version:1,payloadHash:personalHash(value)});
    return {payload:value,proof,signature:await signPersonalProof(otherRoot?peerRoot:root,proof)};
  };
  return {db,roomId,member,migrations,request,payload,signed};
}
describe('original-device migration authorization',()=>{
  it('requires the original root, a complete approved scope and signed staging digest without consuming a device slot',async()=>{
    const f=await fixture(),input=await f.signed();
    const result=f.migrations.verify(f.roomId,f.member.deviceId,input);
    expect(result.verified).toEqual({creator:input});expect(result.activated).toBe(false);
    expect(f.db.prepare('SELECT count(*) AS n FROM chamber_device_requests').get()?.n).toBe(0);
    expect(()=>f.migrations.verify(f.roomId,f.member.deviceId,input)).toThrow('PERSONAL_PROOF_EXPIRED');
  });
  it.each(['no-digest','bad-digest','wrong-root','tampered-digest','wrong-target','wrong-generation','wrong-upper-seq','wrong-scope-hash','partial-scope','missing-release','expired-request','replaced-device','activated'])(
    'rejects %s without writing a verification receipt',async scenario=>{
      const f=await fixture(),payload:any={...f.payload};
      if(scenario==='no-digest')delete payload.stagingDigest;
      if(scenario==='bad-digest')payload.stagingDigest='invalid';
      if(scenario==='wrong-target')payload.targetId=crypto.randomUUID();
      if(scenario==='wrong-generation')payload.generation=2;
      if(scenario==='wrong-upper-seq')payload.upperSeq=6;
      if(scenario==='wrong-scope-hash')payload.scopeHash=randomBase64Url(32);
      if(scenario==='partial-scope'){f.request.scope.scope='chat';f.db.prepare('UPDATE chamber_history_requests SET request=?').run(JSON.stringify(f.request));}
      if(scenario==='missing-release')f.db.exec('DELETE FROM chamber_history_releases');
      if(scenario==='expired-request')f.db.prepare('UPDATE chamber_history_requests SET expires_at=?').run(new Date(Date.now()-1).toISOString());
      if(scenario==='replaced-device')f.member.encryptionKey=(await generateIdentity()).publicBundle.encryptionKey;
      if(scenario==='activated')f.db.exec('UPDATE chamber_migrations SET activated=1');
      const input=await f.signed(payload,scenario==='wrong-root');
      if(scenario==='tampered-digest')input.payload.stagingDigest=randomBase64Url(32);
      expect(()=>f.migrations.verify(f.roomId,f.member.deviceId,input)).toThrow();
      expect(f.migrations.status(f.roomId).verified).toEqual({});
    });
  it('retains the existing approved independent-device compatibility path',async()=>{
    const f=await fixture(),device=await generateIdentity();Object.assign(f.member,device.publicBundle);
    const payload:any={...f.payload,targetId:device.publicBundle.deviceId};delete payload.stagingDigest;
    f.db.prepare('UPDATE chamber_history_requests SET target_id=?').run(device.publicBundle.deviceId);
    f.db.prepare('INSERT INTO chamber_device_requests VALUES(?,?,?,?)').run(f.roomId,f.member.deviceId,'approved','{}');
    expect(f.migrations.verify(f.roomId,f.member.deviceId,await f.signed(payload)).verified.creator.payload).toEqual(payload);
  });
});
