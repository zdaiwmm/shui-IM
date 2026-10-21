import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,expect,it} from 'vitest';
import {createRoomArchives} from '../server/room-archives.mjs';
import {newArchiveKey,sealArchiveObject,archiveReadToken,archiveWriterProof} from '../src/lib/room-archive-crypto';
const databases:DatabaseSync[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
function setup(budget?:number){const db=new DatabaseSync(':memory:');databases.push(db);return createRoomArchives(db,budget?{maxArchiveBytes:budget,maxTotalBytes:budget}:{});}
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
 it('fails capacity without deleting a previously committed archive',async()=>{
  const store=setup(1500),key=newArchiveKey();store.register('r','d',key.descriptor,'creator',archiveWriterProof(key,'r','d'));
  const first=await sealArchiveObject(key,{text:'keep'});store.put('r','d',key.descriptor.id,first);
  const large=await sealArchiveObject(key,{text:'x'.repeat(2000)});
  expect(()=>store.put('r','d',key.descriptor.id,large)).toThrow('QUOTA');
  expect(store.read(key.descriptor.id,archiveReadToken(key.seed),first.id)).toEqual(first);
 });
});
