import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/storage.mjs';
import { publishBackupAdminStatus } from '../scripts/backup-admin-status.mjs';
import { adminBackupStatus, adminReleaseId } from '../server/admin-diagnostics.mjs';
import { generateIdentity } from '../src/lib/crypto';
import { newArchiveKey, sealArchiveObject, archiveWriterProof, archiveReadToken } from '../src/lib/room-archive-crypto';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers();for(const run of cleanup.splice(0))await run();});
async function fixture(){const dir=await mkdtemp(path.join(tmpdir(),'admin-metadata-'));let store=await createStore({dataDir:dir});cleanup.push(async()=>{store.close();await rm(dir,{recursive:true,force:true});});const owner=await generateIdentity();const room=store.createRoom(owner.publicBundle,'a'.repeat(43),'b'.repeat(43),'synthetic device');return {dir,owner,room,get store(){return store;},async restart(){store.close();store=await createStore({dataDir:dir});}};}
describe('administrator metadata projections',()=>{
  it('distinguishes new archives from old checkpoints without exposing capabilities or content',async()=>{
    const f=await fixture(),key=newArchiveKey();f.store.roomArchives.register(f.room.roomId,f.owner.publicBundle.deviceId,key.descriptor,'creator',archiveWriterProof(key,f.room.roomId,f.owner.publicBundle.deviceId));
    const object=await sealArchiveObject(key,{text:'private synthetic history'});f.store.roomArchives.put(f.room.roomId,f.owner.publicBundle.deviceId,key.descriptor.id,object);
    const list=f.store.adminData.roomList({format:'archive-v2'});expect(list.total).toBe(1);expect(list.rooms[0]).toMatchObject({format:'archive-v2',privateArchives:1,backups:0});
    const archive=f.store.adminData.archive(key.descriptor.id);expect(archive).toMatchObject({objects:1,writerActive:1,sourceExists:1});expect(archive.lastWrittenAt).toBeTruthy();
    const output=JSON.stringify({list,archive,summary:f.store.adminData.summary(),detail:f.store.adminData.room(f.room.roomId)});
    for(const secret of [key.seed,key.descriptor.readHash,key.descriptor.encryptionKey,key.descriptor.signingKey,object.ciphertext,'private synthetic history','descriptor','read_hash','access_hash'])expect(output).not.toContain(secret);
    expect(archive.bytes).toBeGreaterThan(0);
    expect(f.store.adminData.roomList({format:'legacy'}).total).toBe(0);
  });
  it('keeps independent archives discoverable and decryptable after source deletion and restart',async()=>{
    const f=await fixture(),key=newArchiveKey();f.store.roomArchives.register(f.room.roomId,f.owner.publicBundle.deviceId,key.descriptor,'creator',archiveWriterProof(key,f.room.roomId,f.owner.publicBundle.deviceId));
    const object=await sealArchiveObject(key,{text:'retained synthetic history'});f.store.roomArchives.put(f.room.roomId,f.owner.publicBundle.deviceId,key.descriptor.id,object);
    f.store.cloudBackups.deleteRoom(f.room.roomId);await f.store.cleanupDeletedRooms();await f.restart();
    expect(f.store.adminData.roomList().total).toBe(0);const result=f.store.adminData.archives({source:'removed'});expect(result.total).toBe(1);expect(result.archives[0]).toMatchObject({id:key.descriptor.id,sourceExists:0,writerActive:0});
    expect(f.store.roomArchives.read(key.descriptor.id,archiveReadToken(key.seed),object.id)).toEqual(object);
    expect(f.store.adminData.events().events[0]).toMatchObject({action:'delete-room',targetId:f.room.roomId,result:'recorded'});
  });
  it('does not refresh last-written evidence on retries or invent dates for old archives',async()=>{
    const f=await fixture(),key=newArchiveKey();f.store.roomArchives.register(f.room.roomId,f.owner.publicBundle.deviceId,key.descriptor,'creator',archiveWriterProof(key,f.room.roomId,f.owner.publicBundle.deviceId));
    const object=await sealArchiveObject(key,{text:'synthetic'});f.store.roomArchives.put(f.room.roomId,f.owner.publicBundle.deviceId,key.descriptor.id,object);const before=f.store.adminData.archive(key.descriptor.id).lastWrittenAt;
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+60_000);f.store.roomArchives.put(f.room.roomId,f.owner.publicBundle.deviceId,key.descriptor.id,object);expect(f.store.adminData.archive(key.descriptor.id).lastWrittenAt).toBe(before);
    const db=new DatabaseSync(path.join(f.dir,'quiet-room.sqlite'));db.prepare('DELETE FROM private_archive_admin_meta_v1 WHERE archive_id=?').run(key.descriptor.id);db.close();await f.restart();
    expect(f.store.adminData.archive(key.descriptor.id)).toMatchObject({createdAt:null,lastWrittenAt:null,objects:1});
  });
  it('bounds filters, pages, and audit output without creating mutation capabilities',async()=>{
    const f=await fixture();for(const opts of [{q:"%' OR 1=1 --"},{offset:-1},{offset:1.5},{format:'bogus'},{state:'bogus'}])expect(()=>f.store.adminData.roomList(opts)).toThrow('INVALID_ADMIN_FILTER');
    for(const opts of [{roomId:'bad?'},{source:'bogus'},{offset:1_000_001}])expect(()=>f.store.adminData.archives(opts)).toThrow('INVALID_ADMIN_FILTER');
    expect(()=>f.store.adminData.events({q:'x%'})).toThrow('INVALID_ADMIN_FILTER');
    f.store.adminData.recordEvent('expression-patch','expression','synthetic-resource');expect(f.store.adminData.events({q:'synthetic-resource'})).toMatchObject({total:1,events:[{targetType:'expression',targetId:'synthetic-resource',result:'succeeded'}]});
    expect(f.store.adminData.archive('missing')).toBeNull();expect(f.store.adminData.roomList({q:f.room.roomId.slice(0,8)}).total).toBe(1);
  });
});
describe('bounded diagnostic evidence',()=>{
  it('shows missing and invalid receipts as unavailable and only returns allowlisted metadata',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'admin-receipt-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json'),now=Date.now();
    expect(await adminBackupStatus(undefined)).toEqual({available:false,code:'NOT_CONNECTED'});
    await writeFile(file,JSON.stringify({sampledAt:new Date(now).toISOString(),lastVerifiedAt:new Date(now-1000).toISOString(),snapshotCreatedAt:new Date(now-2000).toISOString(),lastAttemptAt:new Date(now-1000).toISOString(),lastAttemptSucceeded:true,destination:'mac-pull',secret:'never expose',path:'/private/snapshot'}));
    const result=await adminBackupStatus(file,now);expect(result).toMatchObject({available:true,healthy:true,destination:'mac-pull'});expect(JSON.stringify(result)).not.toMatch(/never expose|private\/snapshot|secret/);
    expect(await adminBackupStatus(file,now+121_000)).toMatchObject({available:false,code:'STALE_STATUS'});
    await publishBackupAdminStatus(dir,path.join(dir,'status'),now+37*60*60_000);
    // The canonical source is separate from the projected administrator file.
    await writeFile(path.join(dir,'.backup-state.json'),await (await import('node:fs/promises')).readFile(file));
    await publishBackupAdminStatus(dir,path.join(dir,'status'),now+37*60*60_000);
    const projected=path.join(dir,'status','backup.json');
    expect(await adminBackupStatus(projected,now+37*60*60_000)).toMatchObject({available:true,healthy:false,code:'BACKUP_STALE'});
    expect(JSON.stringify(await adminBackupStatus(projected,now+37*60*60_000))).not.toMatch(/never expose|private\/snapshot|secret/);
    await writeFile(file,'x'.repeat(4097));expect(await adminBackupStatus(file)).toMatchObject({available:false,code:'INVALID_RECEIPT'});
    await writeFile(file,'{}');expect(await adminBackupStatus(file)).toMatchObject({available:false,code:'STALE_STATUS'});
    await writeFile(path.join(dir,'sw.js'),"const RELEASE_ID = '2026.10.25.1';\n");expect(await adminReleaseId(dir)).toBe('2026.10.25.1');
  });
});
