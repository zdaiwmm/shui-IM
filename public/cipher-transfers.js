/* Narrow background transport. This worker never receives chat or file keys. */
(() => {
  const jobs=new Map();
  let sourceChain=Promise.resolve();
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function valid(task){return task && [task.roomId,task.deviceId,task.blobId].every(id=>uuid.test(id))
    && ['upload','download'].includes(task.direction) && /^[A-Za-z0-9_-]{43}$/.test(task.token)
    && Number.isSafeInteger(task.expiresAt) && task.expiresAt>Date.now()
    && task.chunkSize===2097152 && Number.isSafeInteger(task.originalSize) && task.originalSize>0 && task.originalSize<=2*1024**3
    && task.chunkCount===Math.ceil(task.originalSize/task.chunkSize)
    && task.id.startsWith([task.roomId,task.deviceId,task.blobId,task.direction].join(':')+':')
    && uuid.test(task.id.split(':').at(-1));}
  function open(){return new Promise((resolve,reject)=>{const request=indexedDB.open('quiet-room-cipher-transfers-v1',1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('tasks',{keyPath:'id'});const p=request.result.createObjectStore('parts',{keyPath:'id'});p.createIndex('taskId','taskId');};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  async function transaction(mode,fn){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(['tasks','parts'],mode);let value;
    tx.oncomplete=()=>{db.close();resolve(value);};tx.onabort=()=>{db.close();reject(tx.error??Error('Cancelled'));};tx.onerror=()=>{};
    try{fn(tx,result=>{value=result;});}catch(error){tx.abort();reject(error);}});}
  const get=id=>transaction('readonly',(tx,done)=>{const r=tx.objectStore('tasks').get(id);r.onsuccess=()=>done(r.result);});
  async function roomFor(bytes){
    const estimate=typeof navigator!=='undefined'&&navigator.storage?.estimate?await navigator.storage.estimate().catch(()=>null):null;
    if(estimate&&Math.min(estimate.quota??Infinity,10*1024**3)-(estimate.usage??0)<bytes+64*1024**2)throw Error('Transfer storage full');
  }
  async function update(id,fields,part){return transaction('readwrite',(tx,done)=>{const store=tx.objectStore('tasks'),r=store.get(id);
    r.onsuccess=()=>{if(!r.result||r.result.state==='cancelled'){tx.abort();return;}
      store.put({...r.result,...fields,updated:Date.now()});if(part)tx.objectStore('parts').put(part);done();};});}
  async function runSource(task,signal,source){
    const id=task.id,limit=2*1024**3,chunk=1024**2;
    let response,reader;
    try{
      const url=new URL(source?.url??'');
      if(url.origin!=='https://video.twimg.com'||url.username||url.password||!url.pathname.endsWith('.mp4')
        || !(source.key instanceof CryptoKey)||source.key.type!=='secret'||source.key.algorithm.name!=='AES-GCM'||source.key.algorithm.length!==256
        ||source.key.usages.length!==1||source.key.usages[0]!=='encrypt'||!(source.ivPrefix instanceof Uint8Array)||source.ivPrefix.byteLength!==8
        || ![task.roomId,task.deviceId,task.blobId].every(value=>uuid.test(value))||task.chunkSize!==chunk||task.expiresAt<=Date.now())throw Error('Invalid source task');
      const offset=task.receivedBytes??0;
      if(!Number.isSafeInteger(offset)||offset<0||offset>limit)throw Error('Invalid source offset');
      if(offset>0&&offset===task.originalSize){
        let complete=true;
        for(let index=0;index<Math.ceil(offset/chunk);index++){const part=await transaction('readonly',(tx,done)=>{const r=tx.objectStore('parts').get(id+':'+index);r.onsuccess=()=>done(r.result);});
          if(!(part?.bytes instanceof ArrayBuffer)||part.bytes.byteLength!==Math.min(chunk,offset-index*chunk)+16){complete=false;break;}}
        await update(id,complete?{state:'done',chunkCount:Math.ceil(offset/chunk)}:{state:'restart'});return;
      }
      if(offset%chunk!==0){await update(id,{state:'restart'});return;}
      if(offset && !task.etag){await update(id,{state:'restart'});return;}
      response=await fetch(url.href,{signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
        ...(offset?{headers:{Range:`bytes=${offset}-`,'If-Range':task.etag}}:{})});
      if(!response.ok||!response.body)throw Error('Source paused');
      const etag=response.headers.get('etag');
      const strong=typeof etag==='string'&&/^"[\x21\x23-\x7e]{1,200}"$/.test(etag);
      let total=Number(response.headers.get('content-length'))||0;
      if(offset){
        const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');
        if(response.status!==206||!range||Number(range[1])!==offset||Number(range[2])+1!==Number(range[3])||etag!==task.etag||Number(range[3])!==task.originalSize){
          await response.body.cancel();await update(id,{state:'restart'});return;
        }
        total=Number(range[3]);
      }else if(response.status!==200)throw Error('Invalid source response');
      if(total>limit||total<0||!Number.isSafeInteger(total))throw Error('Source too large');
      await update(id,{state:'running',originalSize:total,etag:strong?etag:undefined});
      let received=offset,index=offset/chunk,pending=new Uint8Array(chunk),used=0;
      const commit=async(size,final=false)=>{
        const current=await get(id);if(!current||current.state==='cancelled')throw Error('Cancelled');signal.throwIfAborted();
        const iv=new Uint8Array(12);iv.set(source.ivPrefix);new DataView(iv.buffer).setUint32(8,index,false);
        const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(id+':'+index)},source.key,pending.slice(0,size));
        signal.throwIfAborted();
        await roomFor(bytes.byteLength);
        await update(id,{receivedBytes:received,...(final?{state:'done',originalSize:received,chunkCount:index+1}:{})},{id:id+':'+index,taskId:id,index,bytes});index++;used=0;pending=new Uint8Array(chunk);
      };
      reader=response.body.getReader();
      while(true){
        const part=await reader.read();if(part.done)break;
        if(received+part.value.byteLength>limit||total&&received+part.value.byteLength>total)throw Error('Source size mismatch');
        for(let start=0;start<part.value.byteLength;){const length=Math.min(chunk-used,part.value.byteLength-start);
          pending.set(part.value.subarray(start,start+length),used);start+=length;used+=length;received+=length;
          if(used===chunk)await commit(chunk);
        }
      }
      if(!received||total&&received!==total)throw Error('Source incomplete');
      if(used){await commit(used,true);return;}
      await update(id,{state:'done',originalSize:received,chunkCount:index,receivedBytes:received});
    }catch{await update(id,{state:'paused'}).catch(()=>{});}
    finally{await reader?.cancel().catch(()=>{});reader?.releaseLock();if(!reader)await response?.body?.cancel().catch(()=>{});}
  }
  async function exactBytes(response,expected){
    if(!response.body)throw Error('Transfer body missing');
    const reader=response.body.getReader(),bytes=new Uint8Array(expected);let length=0;
    try{while(true){const part=await reader.read();if(part.done)break;if(length+part.value.byteLength>expected)throw Error('Transfer too large');bytes.set(part.value,length);length+=part.value.byteLength;}
      if(length!==expected)throw Error('Transfer truncated');return bytes.buffer;
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async function run(id,signal,source){let task=await get(id);if(task?.direction==='source'){if(['ready','running'].includes(task.state))await runSource(task,signal,source);return;}if(!valid(task)||!['ready','running'].includes(task.state))return;
    const endpoint=`/api/rooms/${task.roomId}/blobs/${task.blobId}/transfer`;
    const headers={Authorization:'Transfer '+task.token,'X-Transfer-Direction':task.direction};
    const request=async(path,init={})=>{signal.throwIfAborted();const response=await fetch(endpoint+path,{...init,headers:{...headers,...init.headers},signal,credentials:'omit',cache:'no-store',redirect:'error'});
      if(!response.ok)throw Error('Transfer paused');return response;};
    try{
      await update(id,{state:'running'});
      const remote=task.direction==='upload'?await (await request('')).json():null;
      if(remote && (!Array.isArray(remote.uploadedIndexes)||remote.chunkCount!==task.chunkCount||remote.expectedBytes!==task.originalSize+16*task.chunkCount))throw Error('Transfer status mismatch');
      const uploaded=new Set(remote?.uploadedIndexes??[]);
      for(let index=0;index<task.chunkCount;index++){
        task=await get(id);if(!valid(task)||task.state==='cancelled')return;signal.throwIfAborted();
        if(task.direction==='upload'&&uploaded.has(index)){await update(id,{acknowledgedChunks:index+1});continue;}
        const existing=await transaction('readonly',(tx,done)=>{const r=tx.objectStore('parts').get(id+':'+index);r.onsuccess=()=>done(r.result);});
        const expected=Math.min(task.chunkSize,task.originalSize-index*task.chunkSize)+16;
        if(task.direction==='upload'){
          if(!(existing?.bytes instanceof ArrayBuffer)||existing.bytes.byteLength!==expected)throw Error('Transfer chunk unavailable');
          await request('/chunks/'+index,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:existing.bytes});
          await update(id,{acknowledgedChunks:index+1});
        }else if(!(existing?.bytes instanceof ArrayBuffer)||existing.bytes.byteLength!==expected){
          const response=await request('/chunks/'+index);const length=Number(response.headers.get('content-length'));
          if(length && length!==expected)throw Error('Transfer size mismatch');
          const bytes=await exactBytes(response,expected);
          await roomFor(bytes.byteLength);
          await update(id,{}, {id:id+':'+index,taskId:id,index,bytes});
        }
      }
      if(task.direction==='upload')await request('/complete',{method:'POST'});
      let retired=false;try{await request('/done',{method:'POST'});retired=true;}catch{}
      await update(id,{state:'done',...(retired?{token:''}:{})});
    }catch{await update(id,{state:'paused'}).catch(()=>{});}
  }
  self.addEventListener('message',event=>{
    const {type,id}=event.data??{};
    if(typeof id!=='string'||id.length>180||!event.source?.url||new URL(event.source.url).origin!==self.location.origin)return;
    if(type==='quiet-room-cipher-transfer-cancel'){jobs.get(id)?.abort();return;}
    if(type!=='quiet-room-cipher-transfer')return;
    event.ports?.[0]?.postMessage({version:1});
    if(jobs.has(id))return;
    const controller=new AbortController();jobs.set(id,controller);
    const operation=event.data.source
      ? (sourceChain=sourceChain.catch(()=>{}).then(()=>run(id,controller.signal,event.data.source)))
      : run(id,controller.signal);
    event.waitUntil(operation.finally(()=>jobs.delete(id)));
  });
})();
