import {DatabaseSync} from 'node:sqlite';
import {afterEach,expect,it,vi} from 'vitest';
import {ROOM_LINK_TTL_MS,formatRoomLinkRemaining} from '../src/lib/room-link-lifetime.mjs';
import {createShortInvites} from '../server/short-invites.mjs';
let db:DatabaseSync|undefined;
afterEach(()=>{db?.close();db=undefined;vi.restoreAllMocks();});
it('keeps previews non-consuming, rejects replacement, and expires encrypted envelopes',()=>{
 db=new DatabaseSync(':memory:');const store=createShortInvites(db),now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
 const id='a'.repeat(22),envelope={v:2,iv:'b'.repeat(16),ciphertext:'c'.repeat(120)};
 store.put('room','device',id,envelope);expect(store.get(id)).toEqual(envelope);expect(store.get(id)).toEqual(envelope);
 expect(()=>store.put('room','peer',id,envelope)).toThrow('CONFLICT');expect(()=>store.put('room','device',id,{...envelope,ciphertext:'d'.repeat(120)})).toThrow('CONFLICT');
 vi.mocked(Date.now).mockReturnValue(now+ROOM_LINK_TTL_MS-1);expect(store.get(id)).toEqual(envelope);
 store.put('room','device',id,envelope);
 vi.mocked(Date.now).mockReturnValue(now+ROOM_LINK_TTL_MS);expect(()=>store.get(id)).toThrow('INVALID_REPAIR_LINK');
});

it('shows remaining hours and minutes without wrapping at an hour or a day',()=>{
 expect(formatRoomLinkRemaining(ROOM_LINK_TTL_MS)).toBe('24:00');
 expect(formatRoomLinkRemaining(61*60_000)).toBe('01:01');
 expect(formatRoomLinkRemaining(1)).toBe('00:01');
 expect(formatRoomLinkRemaining(-1)).toBe('00:00');
});
