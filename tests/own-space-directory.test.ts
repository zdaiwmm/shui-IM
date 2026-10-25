import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/lib/crypto';
import { mergeOwnSpaceRecords, openOwnDirectory, sealOwnDirectory, validOwnSpaceRecords, type OwnSpaceRecord } from '../src/lib/own-space-directory';
import { createOwnSpaceDirectory } from '../server/own-space-directory.mjs';
import type { Vault, RoomMember } from '../src/lib/types';

const entry = (revision = 1): OwnSpaceRecord => ({roomId:crypto.randomUUID(),name:'本人私密名称',revision,writer:crypto.randomUUID(),removed:false});
describe('own-device metadata directory', () => {
  it('merges offline edits and retained removals deterministically', () => {
    const before = entry(), removed = {...before,revision:2,removed:true}, concurrent = {...before,writer:crypto.randomUUID(),name:'另一名称'};
    expect(mergeOwnSpaceRecords([removed],[before])).toEqual([removed]);
    expect(mergeOwnSpaceRecords([before],[concurrent])).toEqual(mergeOwnSpaceRecords([concurrent],[before]));
    expect(() => mergeOwnSpaceRecords([before],[{...before,name:'同版本不同内容'}])).toThrow('版本冲突');
  });
  it('rejects hidden capability/content fields and oversized metadata', () => {
    expect(validOwnSpaceRecords([{...entry(),accessToken:'secret'}])).toBe(false);
    expect(validOwnSpaceRecords([{...entry(),preview:'聊天正文'}])).toBe(false);
    expect(validOwnSpaceRecords([{...entry(),name:'x'.repeat(41)}])).toBe(false);
    expect(validOwnSpaceRecords(Array.from({length:257},()=>entry()))).toBe(false);
  });
  it('authenticates owner, room, recipient, revision and encrypted contents with real device keys', async () => {
    const [a,b,c] = await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
    const members = [a,b,c].map((identity,index)=>({...identity.publicBundle,role:index===2?'joiner':'creator',status:'active',joinProof:null})) as RoomMember[];
    const vault = {roomId:crypto.randomUUID(),role:'creator',identity:a,members} as Vault;
    const receiver = {...vault,identity:b}, peer = {...vault,role:'joiner',identity:c} as Vault;
    const records = [entry()], envelope = await sealOwnDirectory(vault,members[1]!,records,1);
    expect(JSON.stringify(envelope)).not.toContain(records[0]!.name);
    expect(await openOwnDirectory(receiver,envelope)).toEqual(records);
    await expect(openOwnDirectory(peer,envelope)).rejects.toThrow();
    for (const altered of [{...envelope,roomId:crypto.randomUUID()},{...envelope,revision:2},{...envelope,recipientId:c.publicBundle.deviceId},{...envelope,ciphertext:'A'.repeat(envelope.ciphertext.length)}]) await expect(openOwnDirectory(receiver,altered)).rejects.toThrow();
    await expect(sealOwnDirectory(vault,members[2]!,records,1)).rejects.toThrow();
    await expect(openOwnDirectory({...receiver,members:members.map(m=>m.deviceId===a.publicBundle.deviceId?{...m,status:'revoked'}:m)},envelope)).rejects.toThrow();
  });
  it('stores only bounded same-role envelopes and rejects revoked access, spoofing and rollback', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE rooms(room_id TEXT PRIMARY KEY); CREATE TABLE members(room_id TEXT,device_id TEXT,status TEXT)');
      const room = crypto.randomUUID(); db.prepare('INSERT INTO rooms VALUES(?)').run(room);
      const a={deviceId:crypto.randomUUID(),role:'creator',status:'active'}, b={deviceId:crypto.randomUUID(),role:'creator',status:'active'}, peer={deviceId:crypto.randomUUID(),role:'joiner',status:'active'};
      for(const member of [a,b,peer]) db.prepare('INSERT INTO members VALUES(?,?,?)').run(room,member.deviceId,member.status);
      const members=[a,b,peer], directory=createOwnSpaceDirectory(db,{getMember:(_room:string,id:string)=>members.find(m=>m.deviceId===id),authenticatedDevice:(_room:string,token:string)=>members.find(m=>m.deviceId===token)});
      const envelope={v:1,purpose:'quiet-room-own-directory-v1',roomId:room,senderId:a.deviceId,recipientId:b.deviceId,revision:2,iv:'i'.repeat(16),ciphertext:'C'.repeat(64),signature:'S'.repeat(86)};
      directory.save(room,a.deviceId,envelope);
      expect(directory.read(room,b.deviceId).incoming).toEqual([envelope]);
      expect(directory.read(room,peer.deviceId).incoming).toEqual([]);
      expect(()=>directory.save(room,a.deviceId,{...envelope,recipientId:peer.deviceId})).toThrow('UNAUTHORIZED');
      expect(()=>directory.save(room,b.deviceId,envelope)).toThrow();
      expect(()=>directory.save(room,a.deviceId,{...envelope,revision:1})).toThrow('DIRECTORY_CONFLICT');
      b.status='revoked';
      expect(()=>directory.read(room,b.deviceId)).toThrow('UNAUTHORIZED');
      expect(()=>directory.save(room,a.deviceId,envelope)).toThrow('UNAUTHORIZED');
      expect(directory.read(room,a.deviceId).outgoing).toEqual([]);
    } finally { db.close(); }
  });
});
