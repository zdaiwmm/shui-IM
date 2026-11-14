import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect,it } from 'vitest';
import { startServer } from '../server/index.mjs';
import { generateIdentity } from '../src/lib/crypto';
import { randomBase64Url } from '../src/lib/base64';

it('confines HTTP task credentials to one blob/direction and retires completed grants',async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'chamber-transfer-'));
  let server:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
    server=await startServer({host:'127.0.0.1',port:0,dataDir,quiet:true});
    const identity=await generateIdentity(),credential=randomBase64Url(32);
    const {roomId}=server.store.createRoom(identity.publicBundle,credential);
    const blobId=crypto.randomUUID(),otherId=crypto.randomUUID();
    server.store.createBlob(roomId,blobId,1,20,identity.publicBundle.deviceId);
    const base=`http://127.0.0.1:${server.port}/api/rooms/${roomId}/blobs/${blobId}/transfer`;
    const grant=async(direction:string)=>{
      const response=await fetch(base,{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:JSON.stringify({direction})});
      expect(response.status).toBe(201);return response.json();
    };
    const upload=await grant('upload');
    const headers={Authorization:'Transfer '+upload.token,'X-Transfer-Direction':'upload','Content-Type':'application/octet-stream'};
    expect((await fetch(base+'/chunks/0',{method:'PUT',headers,body:new Uint8Array(20)})).status).toBe(200);
    expect((await fetch(base+'/complete',{method:'POST',headers})).status).toBe(200);
    expect((await fetch(base+'/done',{method:'POST',headers})).status).toBe(200);
    expect((await fetch(base,{headers})).status).toBe(401);
    let prior=upload.token;
    for(let index=0;index<10;index++){
      const download=await grant('download');expect(download.token).not.toBe(prior);prior=download.token;
      const scoped={Authorization:'Transfer '+download.token,'X-Transfer-Direction':'download'};
      const bytes=await fetch(base+'/chunks/0',{headers:scoped});expect(bytes.status).toBe(200);expect((await bytes.arrayBuffer()).byteLength).toBe(20);
      expect((await fetch(base.replace(blobId,otherId),{headers:scoped})).status).toBe(401);
      expect((await fetch(base+'/chunks/0',{method:'PUT',headers:scoped,body:new Uint8Array(20)})).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${server.port}/api/rooms/${roomId}`,{headers:scoped})).status).toBe(401);
      expect((await fetch(base+'/done',{method:'POST',headers:scoped})).status).toBe(200);
    }
  }finally{await server?.close();await rm(dataDir,{recursive:true,force:true});}
});
