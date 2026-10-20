import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'new-room-passkey-'));let backend,vite,browser;
try {
 backend=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
 vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[{name:'passkey-observer',enforce:'pre',transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});await vite.listen();
 browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
 const context=await browser.newContext(),page=await context.newPage(),cdp=await context.newCDPSession(page),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,hasPrf:true,automaticPresenceSimulation:true,isUserVerified:true}});
 await context.addInitScript(()=>Object.defineProperty(PublicKeyCredential,'getClientCapabilities',{configurable:true,value:async()=>({'extension:prf':true,userVerifyingPlatformAuthenticator:true})}));
 await page.goto(`http://localhost:${vite.httpServer.address().port}/`);await page.locator('#create-room').click();await page.locator('#copy-invite').waitFor();
 const original=await page.evaluate(()=>app.session.vault.roomArchiveV2.key.descriptor.id);
 await page.locator('[data-personal-guide=lock]').click();await page.locator('.auto-lock-page').waitFor();
 const method=await page.evaluate(async()=>{const v=await import('/src/lib/vault.ts');const record=await v.readRoomProtection();if('secret'in record)throw new Error('Automatic key retained');return record.method;});assert.equal(method,'platform');
 await page.evaluate(()=>app.manualLock());assert.equal(await page.locator('#message-input').count(),0);assert.equal(await page.evaluate(()=>!!app.desktopAccess.peek()),false);
 await page.reload();await page.locator('#copy-invite,[data-room-unlock]:not(:disabled)').first().waitFor();if(await page.locator('#copy-invite').count()===0)await page.locator('[data-room-unlock]').click().catch(async error=>{if(await page.locator('#copy-invite').count()===0)throw error;});await page.locator('#copy-invite').waitFor();assert.equal(await page.evaluate(()=>app.session.vault.roomArchiveV2.key.descriptor.id),original);
 assert.deepEqual(errors,[]);console.log('New-room WebAuthn PRF application lock passed: optional setup, no automatic secret, manual lock discards desktop return, authenticated reopen preserves archive.');
}finally{await browser?.close();await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true});}
