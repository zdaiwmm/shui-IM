import {describe,it,expect} from 'vitest';
import {RoomRuntime} from '../src/lib/room-runtime';
describe('runtime projection ownership',()=>{
 it('rejects a changed device or local namespace on the same session object',()=>{let scope='A';const runtime=new RoomRuntime({},()=>true,()=>scope);expect(runtime.isCurrent()).toBe(true);scope='B';expect(runtime.commit(()=>{throw new Error('must not run');})).toBe(false);});
 it('rejects old success, rejection and finally work with the same session',async()=>{
  const session={},updates:string[]=[];let owner:RoomRuntime<object>;const first=new RoomRuntime(session,()=>owner===first);owner=first;
  let release!:()=>void;const old=new Promise<void>(resolve=>release=resolve).then(()=>first.commit(()=>updates.push('old'))).finally(()=>{first.commit(()=>updates.push('old-finally'));});
  first.dispose();const next=new RoomRuntime(session,()=>owner===next);owner=next;next.commit(()=>updates.push('new'));release();await old;
  expect(updates).toEqual(['new']);expect(()=>first.assertCurrent()).toThrow();
 });
 it('disposes resources synchronously and exactly once',()=>{let released=0;const r=new RoomRuntime({},()=>true);r.own(()=>released++);r.dispose();r.dispose();r.own(()=>released++);expect(released).toBe(2);expect(r.signal.aborted).toBe(true);});
});
