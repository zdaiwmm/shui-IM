import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createStore } from '../server/storage.mjs';
import { canonicalStringify } from '../server/protocol.mjs';
import { sendBackup, receiveBackup } from '../server/backup-transfer.mjs';
import { restoreBackup } from '../server/backup.mjs';
it('streams and restores an allowed signed archive after SQLite exceeds the old tmpfs limit',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'backup-large-db-')));const dataDir=path.join(root,'data'),destination=path.join(root,'mac');
 await mkdir(destination,{mode:0o700});const store=await createStore({dataDir});const data=new PassThrough(),ack=new PassThrough();
 try{
  const deviceId=randomUUID();const {roomId}=store.createRoom({deviceId,encryptionKey:{},signingKey:{}},'a'.repeat(43));
  const hash=(v:string)=>createHash('sha256').update(v).digest('base64url'),keys=generateKeyPairSync('ed25519'),token=randomBytes(32).toString('base64url');
  const publicPart={encryptionKey:randomBytes(32).toString('base64url'),signingKey:keys.publicKey.export({format:'jwk'}).x,readHash:hash(token)};
  const descriptor={v:2,id:hash(canonicalStringify(publicPart)),...publicPart};
  const proof=sign(null,Buffer.from(canonicalStringify(['quiet-room-archive-writer-v2',descriptor.id,roomId,deviceId])),keys.privateKey).toString('base64url');
  store.roomArchives.register(roomId,deviceId,descriptor,'creator',proof);
  for(let i=0;i<68;i++){
   const body={v:2,archiveId:descriptor.id,id:randomUUID(),enc:randomBytes(32).toString('base64url'),ciphertext:'A'.repeat(4_000_000)};
   store.roomArchives.put(roomId,deviceId,descriptor.id,{...body,signature:sign(null,Buffer.from(canonicalStringify(body)),keys.privateKey).toString('base64url')});
  }
  expect((await stat(path.join(dataDir,'quiet-room.sqlite'))).size).toBeGreaterThan(256*1024**2);
  const [sent,received]=await Promise.all([
   sendBackup({dataDir,temporaryRoot:path.join(root,'disk-staging'),output:data,input:ack}),
   receiveBackup({root:destination,input:data,output:ack}),
  ]);
  expect(sent.lastAttemptSucceeded).toBe(true);expect(received.verified).toBe(true);
  const restoredDir=path.join(root,'restored');await restoreBackup({backupDir:received.backupDir,targetDataDir:restoredDir});
  const restored=await createStore({dataDir:restoredDir});
  try{expect(restored.roomArchives.snapshot(descriptor.id,token).count).toBe(68);}finally{restored.close();}
 }finally{data.destroy();ack.destroy();store.close();await rm(root,{recursive:true,force:true});}
},60_000);
