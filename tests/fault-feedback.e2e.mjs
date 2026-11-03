// Two isolated application processes, each behind its own same-origin frontend.
// Inject faults at storage boundaries, never via a production debug endpoint.
import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root=await mkdtemp(path.join(os.tmpdir(),'room-fault-e2e-'));
const environments=[];
let browser;
async function start(dataDir) {
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {startServer} from './server/index.mjs';
    const app=await startServer({port:0,dataDir:process.env.DATA_DIR,quiet:true});
    app.store.putBlobChunk=async()=>{throw Object.assign(new Error('sensitive-test-file'),{code:'ENOSPC'});};
    process.send(app.port);
    process.on('message',async()=>{await app.close();process.disconnect();});
  `],{env:{...process.env,DATA_DIR:dataDir},stdio:['ignore','ignore','inherit','ipc']});
  const port=await Promise.race([once(child,'message').then(([port])=>port),once(child,'exit').then(()=>{throw Error('fault test server exited before ready')})]);
  return {port,stop:async()=>{const stopped=once(child,'exit');child.send('stop');await stopped;}};
}
function lookup(dir,id) {
  return JSON.parse(execFileSync(process.execPath,['scripts/fault-lookup.mjs',id],{env:{...process.env,DATA_DIR:dir},encoding:'utf8'}));
}
try {
  browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
  for (const name of ['production','tokyo-public']) {
    const dataDir=path.join(root,name);
    const server=await start(dataDir);
    const env={server,dataDir,ids:[]};environments.push(env);
    const vite=await createServer({configFile:false,appType:'custom',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':{target:'http://127.0.0.1:'+server.port}}}});
    env.vite=vite;
    vite.middlewares.use('/__faults',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<main id="app"></main>')});
    await vite.listen();
    const page=await browser.newPage({locale:'zh-CN'});
    await page.goto('http://127.0.0.1:'+vite.httpServer.address().port+'/__faults');
    await page.evaluate(async()=>{
      const {QuietRoomApp}=await import('/src/app.ts'), {createVault}=await import('/src/lib/vault.ts');
      const {generateIdentity}=await import('/src/lib/crypto.ts'), {createRoom}=await import('/src/lib/api.ts');
      const identity=await generateIdentity(),token=crypto.randomUUID()+crypto.randomUUID();
      const caps=['file-message-v1'];
      const {roomId,createdAt}=await createRoom(identity.publicBundle,token,token,'test',caps);
      const own={...identity.publicBundle,role:'creator',status:'active',capabilities:caps};
      const vault=await createVault({v:1,roomId,createdAt,accessToken:token,role:'creator',protocol:'legacy-v1',lastSeq:0,members:[own],identity},'fixture-password','password');
      const app=new QuietRoomApp(document.querySelector('#app'));
      app.session=vault;app.privacyCovered=false;app.runtimeAbort=new AbortController();
      app.retryOperation=operation=>operation();
      window.failStep=async function(step){
        const tx=IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction=function(stores,mode,...rest){
          if ((step==='chat.preferences' && stores==='preferences' && mode==='readonly') ||
            (step==='send.outbox' && [stores].flat().includes('outbox') && mode==='readwrite'))throw new DOMException('private-test-value','QuotaExceededError');
          return tx.call(this,stores,mode,...rest);
        };
        try {
          if(step==='chat.preferences') await app.openSession();
          else if(step==='send.outbox')await app.enqueuePayload({v:1,kind:'text',text:'private-test-value',sentAt:new Date().toISOString()});
          else {
            app.renderChat();
            const file=new File(['secret'],'sensitive-test-file',{type:'text/plain'});
            if(step==='upload.read')file.slice=()=>({arrayBuffer:async()=>{throw new Error('private-test-value')}});
            await app.processImageBatch([file],'chat');
          }
        }catch(error){if(!['chat.preferences','send.outbox'].includes(step))throw error;}
        finally{IDBDatabase.prototype.transaction=tx;}
      };
    });
    let offline=true;
    await page.route('**/api/faults',route=>offline?route.abort('internetdisconnected'):route.continue());
    for(const stage of ['chat.preferences','send.outbox','upload.read','upload.write']){
      await page.evaluate(step=>window.failStep(step),stage);
      const panel=page.locator('.fault-notice');
      if(offline){
        await panel.getByText('尚未上报',{exact:true}).waitFor();
        const localId=await panel.locator('code').textContent();
        assert.throws(()=>lookup(dataDir,localId),error=>error.status===1);
        offline=false;await panel.getByText('重试上报',{exact:true}).click();
        assert.equal(await panel.locator('code').textContent(),localId);
      }
      await panel.getByText('服务器已记录',{exact:true}).waitFor({timeout:10000});
      const id=await panel.locator('code').textContent();
      const row=lookup(dataDir,id);
      assert.equal(row.stage,stage);assert.equal(row.source,stage==='upload.write'?'server':'browser');
      if(stage==='upload.write')assert.equal(row.reason,'ENOSPC');
      assert.doesNotMatch(JSON.stringify(row),/secret|private-test-value|sensitive-test-file/);
      env.ids.push([id,stage]);
      if(stage==='upload.write'){
        await panel.getByText('用户反馈',{exact:true}).click();
        const attachment=page.locator('.fault-attach input');
        assert.equal(await attachment.isChecked(),false);await attachment.check();
        await page.locator('#feedback-email').fill('review@example.invalid');
        await page.locator('#feedback-message').fill('Synthetic feedback');
        const submission=page.waitForRequest('**/api/feedback');
        await page.locator('.feedback-form button[type=submit]').click();
        assert.equal((await submission).postDataJSON().faultId,id);
        await page.getByText('反馈已提交',{exact:true}).waitFor();
      }else await panel.getByText('关闭',{exact:true}).click();
    }
    await page.close();await vite.close();env.vite=null;
    await server.stop();env.server=null;env.server=await start(dataDir);
  }
  for(const env of environments)for(const [id,stage] of env.ids){
    assert.equal(lookup(env.dataDir,id).stage,stage);
    const other=environments.find(item=>item!==env);
    assert.throws(()=>lookup(other.dataDir,id),error=>error.status===1&&error.stderr.includes('FAULT_NOT_FOUND'));
  }
  console.log('Both environments: chat entry, send, file read and server chunk write isolated and persisted across fresh server processes.');
} finally {
  await browser?.close();
  for(const env of environments){await env.vite?.close();await env.server?.stop();}
  await rm(root,{recursive:true,force:true});
}
