import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
import {fillFormInput} from './helpers/form-input.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'chamber-passkey-'));let backend,vite,browser;
try {
  backend=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
  vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[{name:'chamber-observer',enforce:'pre',transform(code,id){if(id===path.join(process.cwd(),'src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],
    server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});await vite.listen();
  browser=await chromium.launch(process.env.CI?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true}),page=await context.newPage();page.setDefaultTimeout(20_000);
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,hasPrf:true,automaticPresenceSimulation:true,isUserVerified:true}});
  // Declare the virtual device's capabilities; actual assertions and both PRF
  // evaluations still run through Chrome's WebAuthn implementation.
  await context.addInitScript(()=>{
    Object.defineProperty(PublicKeyCredential,'getClientCapabilities',{configurable:true,value:async()=>({'extension:prf':true,userVerifyingPlatformAuthenticator:true})});
  });
  let persisted=false,errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://localhost:${vite.httpServer.address().port}/`);
  await page.route('**/api/rooms',async route=>{if(route.request().method()==='POST')persisted=await page.evaluate(async()=>Boolean((await(await import('/src/lib/vault.ts')).readPersonalIdentity())?.payload.ciphertext));await route.continue();});
  await page.locator('#create-room').click();assert.equal(await page.locator('.space-profile-overlay').count(),0);
  await page.locator('[data-device-verify]').click();await page.locator('.chat-shell').waitFor();assert.equal(persisted,true);
  const metadata=await page.evaluate(async()=>{
    const v=await import('/src/lib/vault.ts'),p=await import('/src/lib/personal-identity-vault.ts'),stored=await v.readPersonalIdentity(),daily=v.cloneDeviceCredential(app.session);
    try {
      let refused=false;try{await p.usePersonalIdentity(stored,{record:stored.protection.platform,prfOutput:daily.prfOutput},()=>undefined);}catch{refused=true;}
      return {method:stored.protection.method,sameCredential:stored.protection.platform.credentialId===stored.protection.dailyPlatform.credentialId,separateSalt:stored.protection.platform.prfSalt!==stored.protection.dailyPlatform.prfSalt,refused,rootId:stored.identity.id};
    }finally{daily.prfOutput.fill(0);daily.browserAccessPrf?.fill(0);}
  });assert.equal(metadata.method,'passkey');assert.equal(metadata.sameCredential,true);assert.equal(metadata.separateSalt,true);assert.equal(metadata.refused,true);
  await page.locator('[data-personal-guide="mnemonic"]').click();await page.locator('[data-personal-show]').click();await page.locator('.chamber-mnemonic-grid li').first().waitFor();
  assert.equal(await page.locator('.chamber-mnemonic-grid li').count(),12);
  await page.evaluate(()=>app.lockNow());assert.equal(await page.locator('.chamber-mnemonic-grid').count(),0);
  assert.deepEqual(errors,[]);console.log('Chamber: real virtual WebAuthn PRF setup, distinct root/daily PRF salts, durable root before room creation, fresh root verification and synchronous mnemonic hiding passed.');
}finally{await browser?.close();await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true});}
