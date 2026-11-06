// Runs inside the isolated browser fixture; never reads a user's vault.
export async function verifyArchiveCheckpoints(page) {
  return page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    const c = await import('/src/lib/room-archive-crypto.ts');
    const k = await import('/src/lib/browser-room-key.ts');
    const cryptoLib = await import('/src/lib/crypto.ts');
    const identity = await cryptoLib.generateIdentity();
    const key = c.newArchiveKey();
    await v.selectLocalSpace(crypto.randomUUID());
    let owner = await v.createVault({ v:3,roomId:crypto.randomUUID(),accessToken:'synthetic',role:'creator',
      creatorFingerprint:'synthetic',identity,members:[{...identity.publicBundle,role:'creator',status:'active'}],
      lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:new Date().toISOString(),roomArchiveV2:{key} },
      '', 'platform', await k.automaticRoomCredential());
    const object = await c.sealArchiveObject(key,{v:2,kind:'media',bytes:'A'.repeat(512*1024)});
    owner.vault.archiveState={cursor:0,revision:0,preparing:{itemId:'synthetic-checkpoint',media:[],next:object}};
    await v.saveVault(owner);
    const original=JSON.stringify(owner.stored);
    const put=IDBObjectStore.prototype.put;
    let aborted=false;
    IDBObjectStore.prototype.put=function(...args){
      const request=put.apply(this,args);
      if(this.name==='preferences'&&String(args[0]?.id).includes('archive-checkpoint:')){
        request.addEventListener('success',()=>{aborted=true;this.transaction.abort();},{once:true});
      }
      return request;
    };
    let failed=false;
    try{await v.compactRoomArchiveState(owner);}catch{failed=true;}finally{IDBObjectStore.prototype.put=put;}
    if(!failed||!aborted||JSON.stringify(owner.stored)!==original||owner.vault.archiveState.preparing.next.v!==2)
      throw Error('Aborted checkpoint migration changed in-memory progress');
    const retained=await v.readStoredRoom(v.vaultSpaceId(owner.stored));
    if(JSON.stringify(retained)!==original)throw Error('Aborted migration replaced the original durable vault');
    await v.compactRoomArchiveState(owner);
    const reference=owner.vault.archiveState.preparing.next;
    if(reference.v!==1||reference.id!==object.id||owner.stored.payload.ciphertext.length>100_000)
      throw Error('Migration did not preserve identity in a compact vault');
    owner=await v.unlockVault(await k.browserRoomKey(),undefined,owner.stored);
    if(JSON.stringify(await v.loadArchiveCheckpoint(owner,reference))!==JSON.stringify(object))throw Error('Checkpoint changed after reopen');
    const database=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const id=`${owner.vault.localDataScope??owner.vault.roomId}:archive-checkpoint:${v.vaultSpaceId(owner.stored)}:${reference.id}`;
    const edit=(operation)=>new Promise((resolve,reject)=>{const tx=database.transaction('preferences','readwrite');const request=operation(tx.objectStore('preferences'));tx.oncomplete=()=>resolve(request?.result);tx.onabort=()=>reject(tx.error);});
    const record=await edit(store=>store.get(id));
    const rejects=async()=>{try{await v.loadArchiveCheckpoint(owner,reference);return false;}catch{return true;}};
    await edit(store=>store.put({...record,ciphertext:(record.ciphertext[0]==='A'?'B':'A')+record.ciphertext.slice(1)}));
    if(!await rejects())throw Error('Corrupt encrypted checkpoint was accepted');
    await edit(store=>store.delete(id));
    if(!await rejects())throw Error('Missing checkpoint was accepted');
    await edit(store=>store.put(record));
    const foreign={...owner,stored:{...owner.stored,spaceId:crypto.randomUUID()}};
    let isolated=false;try{await v.loadArchiveCheckpoint(foreign,reference);}catch{isolated=true;}
    if(!isolated)throw Error('A different vault slot read this checkpoint');
    database.close();
    const remove=IDBObjectStore.prototype.delete;let retireAborted=false;
    IDBObjectStore.prototype.delete=function(...args){const request=remove.apply(this,args);if(this.name==='preferences'&&String(args[0]).includes('archive-checkpoint:'))request.addEventListener('success',()=>{retireAborted=true;this.transaction.abort();},{once:true});return request;};
    let retireFailed=false;try{await v.saveRoomArchiveState(owner,{cursor:1,revision:1});}catch{retireFailed=true;}finally{IDBObjectStore.prototype.delete=remove;}
    if(!retireFailed||!retireAborted||owner.vault.archiveState.cursor!==0||JSON.stringify(await v.loadArchiveCheckpoint(owner,reference))!==JSON.stringify(object))throw Error('Aborted retirement lost checkpoint or advanced cursor');
    // Both recovery storage transitions clear preferences: keep their carried
    // checkpoint self-contained rather than leaving a dangling local reference.
    owner.vault.pendingRecovery={};await v.saveVault(owner);
    await v.withVaultMutation(owner,mutation=>v.finishVaultRecovery(owner,{...owner.vault,pendingRecovery:undefined},mutation));
    if(owner.vault.archiveState.preparing.next.v!==2)throw Error('Recovery retained a deleted local reference');
    await v.compactRoomArchiveState(owner);
    owner.vault.pendingJointRecovery={preserveHistory:true};await v.saveVault(owner);
    await v.finishJointRecovery(owner,{...owner.vault,pendingJointRecovery:undefined},new AbortController().signal);
    if(owner.vault.archiveState.preparing.next.v!==2)throw Error('Joint recovery retained a deleted local reference');
    await v.compactRoomArchiveState(owner);
    const exported=await v.prepareRecoveryPackage(owner);
    await v.selectLocalSpace(crypto.randomUUID());
    await v.importRecoveryPackage(new File([exported.blob],'synthetic-recovery.json',{type:'application/json'}));
    const recovered=await v.unlockRecoveryVault(exported.recoveryCode);
    if(JSON.stringify(recovered.vault.archiveState.preparing.next)!==JSON.stringify(object))throw Error('Portable recovery lost the original upload object');
    await v.selectLocalSpace(v.vaultSpaceId(owner.stored));
    // A legitimate repair carries an inline copy into its independent slot.
    const repaired=await v.createArchiveRepairVault(structuredClone(owner.vault),owner,await k.automaticRoomCredential(),()=>true);
    await v.compactRoomArchiveState(repaired);
    await v.saveRoomArchiveState(owner,{cursor:0,revision:0});
    if(!await rejects())throw Error('Consumed checkpoint was not retired atomically');
    if(JSON.stringify(await v.loadArchiveCheckpoint(repaired,repaired.vault.archiveState.preparing.next))!==JSON.stringify(object))
      throw Error('Retiring the source checkpoint broke the repaired slot');
    await v.deleteNewRoomLocal(repaired);
    let deleted=false;try{await v.loadArchiveCheckpoint(repaired,repaired.vault.archiveState.preparing.next);}catch{deleted=true;}
    if(!deleted)throw Error('Local room deletion retained checkpoint data');
    return {abort:true,reopen:true,missing:true,tamper:true,slotIsolation:true,repair:true,retired:true,deleted:true};
  });
}
