import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createStore } from '../server/storage.mjs';
const bundle = () => ({ deviceId:crypto.randomUUID(),encryptionKey:{kty:'EC'},signingKey:{kty:'EC'} });
it('atomically deletes an unjoined room and updates its encrypted catalog while enforcing capabilities and revisions', async () => {
  const dataDir=await mkdtemp(path.join(tmpdir(),'qr-delete-'));
  const store=await createStore({dataDir});
  try {
    const token='a'.repeat(43), room=store.createRoom(bundle(),token), id='x'.repeat(22);
    const value={roomId:room.roomId,revision:1,fetchToken:'f'.repeat(43),writeToken:'w'.repeat(43),sealed:{iv:'i'.repeat(16),ciphertext:'c'.repeat(43)}};
    store.browserCatalogs.save(id,token,value);
    const changed={...value,revision:2,sealed:{...value.sealed,ciphertext:'d'.repeat(43)}};
    expect(()=>store.deleteRoom(room.roomId,'z'.repeat(43),{id,value:changed})).toThrow('UNAUTHORIZED');
    expect(()=>store.deleteRoom(room.roomId,token,{id,value:{...changed,writeToken:'z'.repeat(43)}})).toThrow('UNAUTHORIZED');
    expect(()=>store.deleteRoom(room.roomId,token,{id,value:{...changed,revision:3}})).toThrow('BACKUP_CONFLICT');
    expect(store.roomState(room.roomId)).not.toBeNull();
    expect(store.browserCatalogs.fetch(id,value.fetchToken).revision).toBe(1);
    expect(store.deleteRoom(room.roomId,token,{id,value:changed})).toEqual({deleted:true});
    expect(store.roomState(room.roomId)).toBeNull();
    expect(store.browserCatalogs.fetch(id,value.fetchToken)).toEqual({revision:2,sealed:changed.sealed});
    const joined=store.createRoom(bundle(),token);
    store.joinRoom(joined.roomId,bundle(),'proof');
    expect(()=>store.deleteRoom(joined.roomId,token,{id,value:{...changed,roomId:joined.roomId,revision:3}})).toThrow('ROOM_SEALED');
    expect(store.browserCatalogs.fetch(id,value.fetchToken).revision).toBe(2);
    expect(store.roomState(joined.roomId)).not.toBeNull();
  } finally { store.close();await rm(dataDir,{recursive:true,force:true}); }
});

it('authenticates before reading a deletion catalog and rejects malformed JSON without mutation', async () => {
  const {startServer}=await import('../server/index.mjs');
  const dataDir=await mkdtemp(path.join(tmpdir(),'qr-delete-http-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,quiet:true});
  try {
    const token='a'.repeat(43),room=server.store.createRoom(bundle(),token);
    const url=`http://127.0.0.1:${server.port}/api/rooms/${room.roomId}`;
    expect((await fetch(url,{method:'DELETE',headers:{Authorization:'Bearer '+'z'.repeat(43)},body:'{broken'})).status).toBe(401);
    expect((await fetch(url,{method:'DELETE',headers:{Authorization:`Bearer ${token}`},body:'{broken'})).status).toBe(400);
    expect(server.store.roomState(room.roomId)).not.toBeNull();
    expect((await fetch(url,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})).status).toBe(200);
    expect(server.store.roomState(room.roomId)).toBeNull();
  } finally {await server.close();await rm(dataDir,{recursive:true,force:true});}
});
