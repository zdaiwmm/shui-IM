import {DatabaseSync} from 'node:sqlite';
import {afterEach,expect,it,vi} from 'vitest';
import {createShortInvites} from '../server/short-invites.mjs';
let db:DatabaseSync;
afterEach(()=>{db?.close();vi.restoreAllMocks();});
it('keeps previews non-consuming, rejects replacement, and expires encrypted envelopes',()=>{
 db=new DatabaseSync(':memory:');const store=createShortInvites(db),now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
 const id='a'.repeat(22),envelope={v:2,iv:'b'.repeat(16),ciphertext:'c'.repeat(120)};
 store.put('room','device',id,envelope);expect(store.get(id)).toEqual(envelope);expect(store.get(id)).toEqual(envelope);
 expect(()=>store.put('room','peer',id,envelope)).toThrow('CONFLICT');expect(()=>store.put('room','device',id,{...envelope,ciphertext:'d'.repeat(120)})).toThrow('CONFLICT');
 vi.mocked(Date.now).mockReturnValue(now+15*60_000);expect(()=>store.get(id)).toThrow('INVALID_REPAIR_LINK');
});
