import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createFeedbackStore,validateFeedback } from '../server/feedback.mjs';
import { startServer } from '../server/index.mjs';
import { makeAdminConfig,totp } from '../server/admin-auth.mjs';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();});
describe('explicit user feedback',()=>{
 it('validates Unicode length, email, control characters and rejects unsolicited fields',()=>{
  const value={id:randomUUID(),email:'user@example.com',message:'你😀'.repeat(2500)};
  expect(validateFeedback(value).message).toBe(value.message);
  for(const input of [{...value,message:value.message+'a'},{...value,email:'a@b'},{...value,message:' '},{...value,email:'a\n@b.com'},{...value,roomId:'private'},{...value,id:'bad'}])expect(()=>validateFeedback(input)).toThrow();
 });
 it('persists idempotently, isolates conflicts and paginates unread projections',()=>{
  const db=new DatabaseSync(':memory:');try{
   const store=createFeedbackStore(db),first={id:randomUUID(),email:'one@example.com',message:'<img src=x onerror=alert(1)>'};
   store.submit(first);store.submit(first);expect(()=>store.submit({...first,message:'changed'})).toThrow('FEEDBACK_CONFLICT');
   for(let i=0;i<26;i++)store.submit({id:randomUUID(),email:'two@example.com',message:`entry ${i}`});
   expect(store.list().total).toBe(27);expect(store.list().items).toHaveLength(25);expect(store.list({offset:25}).items).toHaveLength(2);
   expect(store.markRead(first.id)).toBe(true);expect(store.markRead(first.id)).toBe(true);
   expect(store.list({status:'read'}).total).toBe(1);expect(store.list({status:'unread'}).total).toBe(26);
   expect(store.get(first.id).message).toBe(first.message);expect(store.list().items[0]).not.toHaveProperty('digest');
   expect(createFeedbackStore(db).list().total).toBe(27);expect(()=>store.list({offset:-1})).toThrow();
  }finally{db.close();}
 });
 it('enforces public origin/body limits, admin authentication/CSRF and source throttling',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'quiet-feedback-'));const password='test-feedback-admin-strong-password';const config=await makeAdminConfig(password);
  const server=await startServer({port:0,host:'127.0.0.1',dataDir:dir,adminConfig:config,quiet:true});cleanup.push(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const send=(route:string,method='POST',body:unknown={},headers:Record<string,string>={})=>new Promise<{status:number;body:any;cookie:string}>((resolve,reject)=>{
   const req=httpRequest({hostname:'127.0.0.1',port:server.port,path:route,method,headers:{Host:'app.example.com',Origin:'https://app.example.com','Content-Type':'application/json',...headers}},res=>{
    const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]??''}));
   });req.on('error',reject);req.end(method==='GET'?undefined:JSON.stringify(body));
  });
  const value={id:randomUUID(),email:'user@example.com',message:'A feedback message'};
  expect((await send('/api/feedback','POST',value,{Origin:'https://elsewhere.example'})).status).toBe(403);
  expect((await send('/api/feedback','POST',value)).status).toBe(200);
  expect((await send('/api/feedback','POST',value)).status).toBe(200);
  const admin={Host:'admin.mijiu.cloud',Origin:'https://admin.mijiu.cloud'};
  expect((await send('/admin-api/feedback','GET',{},admin)).status).toBe(401);
  const login=await send('/admin-api/login','POST',{password,code:totp(config.totpSecret)},admin);expect(login.status).toBe(200);
  const authorized={...admin,Cookie:login.cookie,'X-CSRF-Token':login.body.csrf};
  expect((await send('/admin-api/feedback','GET',{},authorized)).body.total).toBe(1);
  expect((await send(`/admin-api/feedback/${value.id}`,'GET',{},authorized)).body.message).toBe(value.message);
  expect((await send(`/admin-api/feedback/${value.id}/read`,'POST',{}, {...admin,Cookie:login.cookie})).status).toBe(403);
  expect((await send(`/admin-api/feedback/${value.id}/read`,'POST',{},authorized)).status).toBe(200);
  expect((await send('/admin-api/feedback?status=read','GET',{},authorized)).body.total).toBe(1);
  expect((await send('/api/feedback','POST',{...value,message:'x'.repeat(33000)})).status).toBe(413);
  await send('/api/feedback','POST',value);await send('/api/feedback','POST',value);
  expect((await send('/api/feedback','POST',value)).status).toBe(429);
 });
});
