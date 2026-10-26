import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
const vite=await createServer({root:process.cwd(),configFile:false,appType:'custom',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'backup-facts',configureServer(s){s.middlewares.use('/__backup_facts',(_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');});}}]});let browser;
try{await vite.listen();for(const engine of [chromium,webkit]){
 browser=await engine.launch(engine===webkit?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
 const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(`http://localhost:${vite.httpServer.address().port}/__backup_facts`);
 await page.evaluate(async()=>{
  await import('/src/styles.css');await import('/src/auth-recovery.css');await import('/src/room-polish.css');
  const v=await import('/src/lib/vault.ts'),c=await import('/src/lib/crypto.ts'),k=await import('/src/lib/browser-room-key.ts'),a=await import('/src/lib/room-archive-crypto.ts'),{mountArchiveSettings}=await import('/src/lib/archive-settings.ts'),{readArchiveBackupSnapshot}=await import('/src/lib/archive-backup-state.ts');
  const identity=await c.generateIdentity(),roomId=crypto.randomUUID(),session=await v.createVault({v:3,roomId,accessToken:'synthetic',creatorFingerprint:'synthetic',role:'creator',pairingSecret:'',identity,members:[{...identity.publicBundle,role:'creator',status:'active',joinProof:null}],lastSeq:2,lastReceiptSeq:0,pairingState:'ready',createdAt:'2026-10-27T00:00:00Z',protocol:'mls-rfc9420',roomArchiveV2:{key:a.newArchiveKey(),cardVerified:true,credential:'synthetic-credential'}},'','platform',await k.automaticRoomCredential());
  const meta=await v.readPrivateCatalogMeta(session);session.vault.archiveState={cursor:2,revision:2,head:{id:crypto.randomUUID(),hash:'synthetic'},counts:{messages:2,images:1,videos:0,files:0,audio:0},countsRevision:2,syncedAt:'2026-10-27T00:00:00Z',lastComplete:{archiveId:session.vault.roomArchiveV2.key.descriptor.id,scope:session.vault.localDataScope??roomId,sharedThrough:2,privateRevision:meta.revision,revision:2,at:'2026-10-27T00:00:00Z'}};
  const root=document.querySelector('#app'),life=new AbortController(),facts={running:false,error:''};
  window.backupFixture={session,root,life,facts};
  window.mountBackup=(managed=false)=>mountArchiveSettings({root,session,startWithCredential:managed,signal:life.signal,name:()=> 'chamber1',verify:async()=>{},active:()=>!life.signal.aborted,notice:()=>{},back:()=>{},sync:async()=>{},restored:()=>{},beginPick:()=>true,finishPick:async()=>false,saveImage:async()=>{},backupSnapshot:()=>readArchiveBackupSnapshot(session,life.signal,facts)});
  window.mountBackup();
 });
 await page.locator('[data-archive-status][data-coverage=complete]').waitFor();
 await page.evaluate(()=>{const {session,facts,root}=window.backupFixture;session.vault.lastSeq=3;facts.error='原文件缺失';root.dispatchEvent(new Event('archivebackupchange'));});
 await page.locator('[data-archive-status][data-coverage=partial]').waitFor();assert.match(await page.locator('[data-archive-status]').textContent(),/原文件缺失.*已有已确认/);
 await page.evaluate(()=>window.mountBackup(true));await page.locator('[data-archive-count=messages]').filter({hasText:'2'}).waitFor();
 assert.match(await page.locator('[data-archive-auto-state]').textContent(),/原文件缺失/);
 await page.evaluate(()=>{const f=window.backupFixture;f.session.vault.roomArchiveV2.automaticBackup=false;f.facts.error='';f.root.dispatchEvent(new Event('archivebackupchange'));});
 await page.locator('[data-archive-auto][aria-checked=false]').waitFor();assert.match(await page.locator('[data-archive-auto-state]').textContent(),/自动备份已关闭/);assert.equal(await page.locator('[data-archive-count=messages]').textContent(),'2');
 if(process.env.QUIET_ROOM_ARCHIVE_QA&&engine===chromium){await mkdir(process.env.QUIET_ROOM_ARCHIVE_QA,{recursive:true});for(const [name,width,dark,zoom] of [['mobile-light',390,false,1],['mobile-dark-large-text',390,true,2],['desktop-light',1440,false,1]]){await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:dark?'dark':'light'});await page.evaluate(zoom=>{document.documentElement.style.fontSize=`${16*zoom}px`;},zoom);await page.screenshot({path:path.join(process.env.QUIET_ROOM_ARCHIVE_QA,`${name}.png`),fullPage:true});}}
 // Invalidate counts without downloading originals; a failed chain read is unavailable, not zero.
 await page.route('**/api/private-archives/**',route=>route.fulfill({status:404,contentType:'application/json',body:'{"error":"synthetic unavailable"}'}));
 await page.evaluate(()=>{const f=window.backupFixture;delete f.session.vault.archiveState.counts;delete f.session.vault.archiveState.countsRevision;f.root.dispatchEvent(new Event('archivebackupchange'));});
 await page.locator('[data-archive-count=messages]').filter({hasText:'暂不可用'}).waitFor();assert.equal(await page.locator('[data-archive-auto-state]').getAttribute('data-coverage'),'unknown');
 await page.evaluate(()=>{window.backupFixture.life.abort();window.backupFixture.root.innerHTML='<p id="later-page">后续页面</p>';window.backupFixture.root.dispatchEvent(new Event('archivebackupchange'));});
 assert.equal(await page.locator('#later-page').textContent(),'后续页面');assert.equal(await page.locator('[data-archive-count]').count(),0);
 console.log(`Backup state UI passed (${engine.name()}): live completion/error/pause, retained old counts, unknown counts and page cancellation.`);
 await browser.close();browser=null;
}}finally{await browser?.close();await vite.close();}
