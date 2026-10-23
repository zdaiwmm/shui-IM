import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,expect,it} from 'vitest';
import {createRoomArchives} from '../server/room-archives.mjs';
import {newArchiveKey,sealArchiveObject,archiveReadToken,archiveWriterProof,archiveAccessProof,archiveAccessHash,archiveAccessToken} from '../src/lib/room-archive-crypto';
const databases:DatabaseSync[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
function setup(budget?:number){const db=new DatabaseSync(':memory:');databases.push(db);return createRoomArchives(db,{assertWriterActive:()=>{},...(budget?{maxArchiveBytes:budget,maxTotalBytes:budget}:{})});}
describe('private archive authority and persistence',()=>{
 it('reads with only card authority, never a live-room or peer token',async()=>{
  const store=setup(),key=newArchiveKey(),other=newArchiveKey();
  store.register('room','owner',key.descriptor,'creator',archiveWriterProof(key,'room','owner'));
  const object=await sealArchiveObject(key,{text:'private'});
  store.put('room','owner',key.descriptor.id,object);
  expect(store.read(key.descriptor.id,archiveReadToken(key.seed),object.id)).toEqual(object);
  expect(()=>store.read(key.descriptor.id,archiveReadToken(other.seed),object.id)).toThrow();
  expect(()=>store.put('room','peer',key.descriptor.id,object)).toThrow('UNAUTHORIZED');
  expect(()=>store.register('different','owner',key.descriptor,'creator',archiveWriterProof(key,'different','owner'))).toThrow('CONFLICT');
 });
 it('requires private archive proof to register or rebind, and pins the owner role',async()=>{
  const store=setup(),key=newArchiveKey();
  expect(()=>store.register('r','old',key.descriptor,'creator')).toThrow('UNAUTHORIZED');
  store.register('r','old',key.descriptor,'creator',archiveWriterProof(key,'r','old'));
  expect(()=>store.register('r','new',key.descriptor,'creator',archiveWriterProof(key,'r','old'))).toThrow('UNAUTHORIZED');
  expect(()=>store.register('r','peer',key.descriptor,'joiner',archiveWriterProof(key,'r','peer'))).toThrow('CONFLICT');
  store.register('r','new',key.descriptor,'creator',archiveWriterProof(key,'r','new'));
  const object=await sealArchiveObject(key,{text:'still private'});
  expect(()=>store.put('r','old',key.descriptor.id,object)).toThrow('UNAUTHORIZED');
  store.put('r','new',key.descriptor.id,object);
  expect(store.read(key.descriptor.id,archiveReadToken(key.seed),object.id)).toEqual(object);
 });
 it('retries identically but rejects replacement and tampering',async()=>{
  const store=setup(),key=newArchiveKey();store.register('r','d',key.descriptor,'creator',archiveWriterProof(key,'r','d'));
  const object=await sealArchiveObject(key,{text:'first'});store.put('r','d',key.descriptor.id,object);store.put('r','d',key.descriptor.id,object);
  const snapshot=store.snapshot(key.descriptor.id,archiveReadToken(key.seed));
  expect(store.list(key.descriptor.id,archiveReadToken(key.seed),0,snapshot.end)).toHaveLength(1);
  expect(()=>store.put('r','d',key.descriptor.id,{...object,ciphertext:object.ciphertext.slice(1)})).toThrow('INVALID');
 });
 it('counts only the selected archive despite interleaved global cursors',async()=>{
  const store=setup(),a=newArchiveKey(),b=newArchiveKey();
  for(const key of [a,b])store.register('r','d',key.descriptor,'creator',archiveWriterProof(key,'r','d'));
  for(const key of [a,b,a,b,b])store.put('r','d',key.descriptor.id,await sealArchiveObject(key,{text:'synthetic count'}));
  const first=store.snapshot(a.descriptor.id,archiveReadToken(a.seed)),second=store.snapshot(b.descriptor.id,archiveReadToken(b.seed));
  expect(first).toMatchObject({end:3,count:2});expect(second).toMatchObject({end:5,count:3});
  expect(store.list(a.descriptor.id,archiveReadToken(a.seed),0,first.end)).toHaveLength(first.count);
 });
 it('rotates only the owner read authority, persists revocation and retries without rollback',async()=>{
  const db=new DatabaseSync(':memory:');databases.push(db);let store=createRoomArchives(db,{assertWriterActive:()=>{}});const key=newArchiveKey(),other=newArchiveKey();
  store.register('r','d',key.descriptor,'creator',archiveWriterProof(key,'r','d'));
  store.register('r','peer',other.descriptor,'joiner',archiveWriterProof(other,'r','peer'));
  const object=await sealArchiveObject(key,{text:'retained original'});store.put('r','d',key.descriptor.id,object);
  const old=archiveAccessToken(key),nextKey={...key,readToken:other.seed},next=archiveAccessHash(nextKey.readToken),expected=archiveAccessHash(old),proof=archiveAccessProof(key,'r','d',expected,next);
  expect(()=>store.rotateAccess('r','peer',key.descriptor.id,expected,next,proof)).toThrow('UNAUTHORIZED');
  expect(()=>store.rotateAccess('r','d',key.descriptor.id,expected,next,archiveWriterProof(key,'r','d'))).toThrow('UNAUTHORIZED');
  store.rotateAccess('r','d',key.descriptor.id,expected,next,proof);store=createRoomArchives(db,{assertWriterActive:()=>{}});
  expect(()=>store.snapshot(key.descriptor.id,old)).toThrow('UNAUTHORIZED');
  expect(()=>store.list(key.descriptor.id,old,0,100)).toThrow('UNAUTHORIZED');
  expect(()=>store.read(key.descriptor.id,old,object.id)).toThrow('UNAUTHORIZED');
  expect(store.read(key.descriptor.id,archiveAccessToken(nextKey),object.id)).toEqual(object);
  store.rotateAccess('r','d',key.descriptor.id,expected,next,proof);
  store.register('r','d',key.descriptor,'creator',archiveWriterProof(key,'r','d'));
  expect(()=>store.snapshot(key.descriptor.id,old)).toThrow('UNAUTHORIZED');
  const third=archiveAccessHash(newArchiveKey().seed),thirdProof=archiveAccessProof(key,'r','d',next,third);
  store.rotateAccess('r','d',key.descriptor.id,next,third,thirdProof);
  expect(()=>store.rotateAccess('r','d',key.descriptor.id,expected,next,proof)).toThrow('CONFLICT');
  expect(store.snapshot(other.descriptor.id,archiveAccessToken(other)).count).toBe(0);
 });
 it('fails capacity without deleting a previously committed archive',async()=>{
  const store=setup(1500),key=newArchiveKey();store.register('r','d',key.descriptor,'creator',archiveWriterProof(key,'r','d'));
  const first=await sealArchiveObject(key,{text:'keep'});store.put('r','d',key.descriptor.id,first);
  const large=await sealArchiveObject(key,{text:'x'.repeat(2000)});
  expect(()=>store.put('r','d',key.descriptor.id,large)).toThrow('QUOTA');
  expect(store.read(key.descriptor.id,archiveReadToken(key.seed),first.id)).toEqual(first);
 });
});

describe('current writer authorization at transaction commit',()=>{
 it('rejects revoked/fenced writers without changing objects, read authority or a new writer binding',async()=>{
  const db=new DatabaseSync(':memory:');databases.push(db);const active=new Set(['old','new']);
  const store=createRoomArchives(db,{assertWriterActive(_room:string,device:string,role:string){if(!active.has(device)||role!=='creator')throw new Error('UNAUTHORIZED');}});
  const key=newArchiveKey();store.register('r','old',key.descriptor,'creator',archiveWriterProof(key,'r','old'));
  const keep=await sealArchiveObject(key,{text:'retained'});store.put('r','old',key.descriptor.id,keep);
  active.delete('old');
  const next=archiveAccessHash(newArchiveKey().seed),expected=archiveAccessHash(archiveAccessToken(key));
  expect(()=>store.put('r','old',key.descriptor.id,keep)).toThrow('UNAUTHORIZED');
  expect(()=>store.rotateAccess('r','old',key.descriptor.id,expected,next,archiveAccessProof(key,'r','old',expected,next))).toThrow('UNAUTHORIZED');
  store.register('r','new',key.descriptor,'creator',archiveWriterProof(key,'r','new'));
  expect(()=>store.register('r','old',key.descriptor,'creator',archiveWriterProof(key,'r','old'))).toThrow('UNAUTHORIZED');
  const after=await sealArchiveObject(key,{text:'new active writer'});store.put('r','new',key.descriptor.id,after);
  expect(store.snapshot(key.descriptor.id,archiveAccessToken(key)).count).toBe(2);
  expect(store.read(key.descriptor.id,archiveAccessToken(key),keep.id)).toEqual(keep);
 });
 it('fails closed if a production caller omits the member authorization dependency',()=>{
  const db=new DatabaseSync(':memory:');databases.push(db);expect(()=>createRoomArchives(db)).toThrow('ARCHIVE_WRITER_AUTHORIZATION_REQUIRED');
 });
});
