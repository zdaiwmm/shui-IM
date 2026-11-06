import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {createStore} from '../../server/storage.mjs';
const oldRows=`FROM messages
 JOIN members AS sender ON sender.room_id=messages.room_id AND sender.device_id=messages.sender_device_id
 WHERE messages.room_id=?1 AND messages.server_seq>?2 AND messages.count_unread=1 AND sender.role<>?3
 AND NOT EXISTS(SELECT 1 FROM unread_observers AS observer
 JOIN members AS reader ON reader.room_id=observer.room_id AND reader.device_id=observer.device_id
 WHERE observer.room_id=messages.room_id AND reader.role=?3
 AND messages.server_seq>reader.join_seq AND messages.server_seq<=observer.read_seq)`;
const indexSql='CREATE INDEX messages_unread_sender_seq ON messages(room_id,sender_device_id,server_seq) WHERE count_unread=1';
const samples=(fn,n=50)=>Array.from({length:n},()=>{const start=performance.now();fn();return performance.now()-start});
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
if(!isMainThread){
 const store=await createStore({dataDir:workerData.directory});parentPort.postMessage({ready:true});
 parentPort.once('message',()=>{try{const latency=samples(()=>assert.equal(store.unreadCount(workerData.roomId,workerData.deviceId,workerData.token).count,workerData.expected));parentPort.postMessage({latency});}finally{store.close()}});
}else{
 const output=path.resolve('.artifacts/audit-remediation');await mkdir(output,{recursive:true});
 const directory=await mkdtemp(path.join(tmpdir(),'qr-unread-profile-'));
 let store=await createStore({dataDir:directory});const filename=path.join(directory,'quiet-room.sqlite');
 const db=new DatabaseSync(filename),workers=[];
 const results={kind:'real-sqlite-synthetic-ciphertext',coldDefinition:'new SQLite connection and prepared statements; OS cache not flushed; store initialization excluded',cases:[]};
 const bundle=id=>({deviceId:id,encryptionKey:{kty:'EC',crv:'P-256',x:'x',y:'y'},signingKey:{kty:'EC',crv:'P-256',x:'x',y:'y'}});
 try{
  for(const count of [100,1000,10000,100000]){
   const creator=crypto.randomUUID(),peer=crypto.randomUUID(),token='c'.repeat(43);
   const {roomId}=store.createRoom(bundle(creator),'a'.repeat(43));store.joinRoom(roomId,bundle(peer),'synthetic','b'.repeat(43));
   const ids=[creator,peer],tokens=[token,'d'.repeat(43)];
   for(let i=0;i<4;i++){const id=crypto.randomUUID();ids.push(id);tokens.push(String.fromCharCode(101+i).repeat(43));db.prepare(`INSERT INTO members(room_id,device_id,role,encryption_jwk,signing_jwk,access_hash,status,join_seq,created_at) SELECT room_id,?,?,encryption_jwk,signing_jwk,access_hash,'active',0,created_at FROM members WHERE room_id=? AND device_id=?`).run(id,i%2?'joiner':'creator',roomId,creator)}
   const insert=db.prepare('INSERT INTO messages(room_id,server_seq,client_msg_id,sender_device_id,envelope,accepted_at,count_unread) VALUES(?,?,?,?,?,?,?)');
   db.exec('BEGIN');for(let seq=1;seq<=count;seq++)insert.run(roomId,seq,'synthetic-'+seq,peer,'A'.repeat(1024),'2026-11-07T00:00:00Z',1);db.prepare('UPDATE rooms SET next_seq=?,message_count=? WHERE room_id=?').run(count,count,roomId);db.exec('COMMIT');
   for(let i=0;i<6;i++)store.saveUnreadObserver(roomId,ids[i],{token:tokens[i],readSeq:0});
   const writeBatch=()=>{db.exec('BEGIN');for(let n=1;n<=1000;n++)insert.run(roomId,count+n,'write-'+n,peer,'A'.repeat(1024),'2026-11-07T00:00:00Z',n%5?1:0);db.exec('COMMIT');db.prepare('DELETE FROM messages WHERE room_id=? AND server_seq>?').run(roomId,count)};
   db.exec('DROP INDEX messages_unread_sender_seq');
   const old=db.prepare('SELECT COUNT(*) AS count '+oldRows);
   const oldWarmMs=samples(()=>assert.equal(old.get(roomId,0,'creator').count,count));
   const oldWriteMs=samples(writeBatch,5),oldColdMs=[];
   for(let i=0;i<15;i++){const cold=new DatabaseSync(filename),query=cold.prepare('SELECT COUNT(*) AS count '+oldRows);oldColdMs.push(samples(()=>assert.equal(query.get(roomId,0,'creator').count,count),1)[0]);cold.close()}
   const pageBytesBefore=db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size;
   const indexStart=performance.now();db.exec(indexSql);const indexBuildMs=performance.now()-indexStart;
   const newWarmMs=samples(()=>assert.equal(store.unreadCount(roomId,creator,token).count,count));
   const newWriteMs=samples(writeBatch,5),newColdMs=[];
   for(let i=0;i<15;i++){store.close();store=await createStore({dataDir:directory});newColdMs.push(samples(()=>assert.equal(store.unreadCount(roomId,creator,token).count,count),1)[0])}
   const queryPlan=db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM messages WHERE room_id=? AND sender_device_id=? AND server_seq>? AND server_seq<=? AND count_unread=1').all(roomId,peer,0,Number.MAX_SAFE_INTEGER).map(row=>row.detail);
   assert.ok(queryPlan.some(plan=>plan.includes('messages_unread_sender_seq')),JSON.stringify(queryPlan));
   const row={count,oldWarmMs,newWarmMs,oldColdMs,newColdMs,oldWriteMs,newWriteMs,indexBuildMs,queryPlan,pageBytesBefore,pageBytesAfter:db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size};
   if(count===100000){
    const ready=[],finished=[];
    for(let i=0;i<6;i++){const worker=new Worker(new URL(import.meta.url),{workerData:{directory,roomId,deviceId:ids[i],token:tokens[i],expected:i%2?0:count}});workers.push(worker);ready.push(new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)}));finished.push(new Promise((resolve,reject)=>{worker.on('message',value=>{if(value.latency)resolve(value.latency)});worker.once('error',reject)}))}
    await Promise.all(ready);const started=performance.now();workers.forEach(worker=>worker.postMessage('count'));row.sixDeviceLatencies=await Promise.all(finished);row.sixDeviceWallMs=performance.now()-started;
    row.coldP95=p95(newColdMs);row.oldColdP95=p95(oldColdMs);row.coldImprovement=1-row.coldP95/row.oldColdP95;
   }
   results.cases.push(row);await writeFile(path.join(output,'unread-profile.json'),JSON.stringify(results,null,2));console.log('UNREAD_PROFILE',JSON.stringify({count,oldP95:p95(oldColdMs),newP95:p95(newColdMs),indexBuildMs,sixDeviceWallMs:row.sixDeviceWallMs}));
  }
  const final=results.cases.at(-1);assert.ok(final.coldP95<=15,'100k cold P95 must be <=15 ms');assert.ok(final.coldImprovement>=.7,'100k cold improvement must be >=70%');
 }finally{for(const worker of workers)await worker.terminate();db.close();store.close();await rm(directory,{recursive:true,force:true})}
}
