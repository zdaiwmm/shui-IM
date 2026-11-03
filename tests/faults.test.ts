import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFaultStore, lookupFault } from '../server/faults.mjs';
import { startServer } from '../server/index.mjs';
import { createFeedbackStore } from '../server/feedback.mjs';

const dirs:string[]=[];
function directory(){const dir=mkdtempSync(path.join(tmpdir(),'fault-unit-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const event={id:'E-0123456789ABCDEF',stage:'send.outbox',reason:'FAILED',version:'2026.11.03.2'};
it('accepts only bounded fields, preserves exact retries and hides expired evidence',()=>{
  const dir=directory(),store=openFaultStore(dir,event.version);
  try {
    for(const body of [{...event,stack:'secret'},{...event,stage:'upload.write'},{...event,reason:'secret'},
      {...event,version:'2026.11.03.2/key'}, {...event,id:'a room ID'}, {...event,stage:'__proto__'}])
      expect(store.client(body)).toBe(400);
    expect(store.client(event)).toBe(200);
    const first=lookupFault(dir,event.id);
    expect(store.client(event)).toBe(200);
    expect(store.client({...event,reason:'TIMEOUT'})).toBe(409);
    expect(lookupFault(dir,event.id)).toEqual(first);
    const db=new DatabaseSync(path.join(dir,'faults.sqlite'));
    try {
      db.prepare('UPDATE faults SET created_at=?').run(Date.now()-7*86400000);
      expect(lookupFault(dir,event.id)).toBeNull();store.sweep();
      expect(db.prepare('SELECT COUNT(*) AS n FROM faults').get()?.n).toBe(0);
    } finally {db.close();}
  } finally {store.close();}
});
it('rejects cross-origin reporting and public lookup, limits even correctly shaped requests',async()=>{
  const server=await startServer({port:0,dataDir:directory(),quiet:true});
  try {
    const base='http://127.0.0.1:'+server.port,url=base+'/api/faults';
    const post=(origin:string)=>fetch(url,{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(event)});
    expect((await post('https://elsewhere.invalid')).status).toBe(403);
    expect((await fetch(url+'?id='+event.id)).status).toBe(405);
    for(let i=0;i<30;i++)expect(await (await post(base)).json()).toEqual({recorded:true,id:event.id});
    expect((await post(base)).status).toBe(429);
  }finally{await server.close();}
});
it('migrates existing feedback and keeps an attached fault number independent of message length',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE user_feedback(id TEXT PRIMARY KEY,email TEXT,message TEXT,digest TEXT,created_at TEXT,read_at TEXT)');
    const store=createFeedbackStore(db),value={id:crypto.randomUUID(),email:'user@example.invalid',message:'a'.repeat(5000)};
    store.submit(value);expect(store.get(value.id).faultId).toBeNull();
    const attached={...value,id:crypto.randomUUID(),faultId:event.id};
    store.submit(attached);store.submit(attached);expect(store.get(attached.id).faultId).toBe(event.id);
    expect(()=>store.submit({...attached,faultId:'E-FFFFFFFFFFFFFFFF'})).toThrow('FEEDBACK_CONFLICT');
    expect(()=>store.submit({...attached,faultId:'invalid'})).toThrow('INVALID_FEEDBACK');
  }finally{db.close();}
});
