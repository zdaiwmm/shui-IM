import assert from 'node:assert/strict';
import {fillFormInput} from './helpers/form-input.mjs';
import {submitPassword} from './helpers/password.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'quiet-new-room-ui-'));let service,vite,browser,debugPage;
try{
 service=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
 vite=await createServer({root:process.cwd(),configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${service.port}`,'/ws':{target:`ws://127.0.0.1:${service.port}`,ws:true}}}});await vite.listen();
 browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
 const origin=`http://127.0.0.1:${vite.httpServer.address().port}`,contexts=[],mobile=process.env.QR_MOBILE==='1',list='.is-space-list-page:not(.space-sidebar)';
 const newPage=async(asMobile=mobile)=>{const context=await browser.newContext({permissions:['clipboard-read','clipboard-write'],...(asMobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'}:{})});contexts.push(context);return context.newPage();};
 const alice=await newPage(),bob=await newPage(),errors=[];debugPage=bob;
 for(const page of [alice,bob])page.on('pageerror',error=>errors.push(error.message));
 const snapshot=page=>page.evaluate(async()=>{const v=await import('/src/lib/vault.ts'),k=await import('/src/lib/browser-room-key.ts');let session;for(let attempt=0;attempt<5;attempt++){try{session=await v.unlockVault(await k.browserRoomKey(),undefined,await v.readStoredVault());break;}catch(error){if(!String(error).includes('本机会话已在其它窗口')||attempt===4)throw error;}}return {id:session.vault.identity.publicBundle.deviceId,roomId:session.vault.roomId,token:session.vault.accessToken,archiveId:session.vault.roomArchiveV2.key.descriptor.id};});
 const send=async(page,text)=>{await page.locator('#message-input').fill(text);await page.locator('#composer').evaluate(form=>form.requestSubmit());};
 let creationResponsesLost=0;await alice.route('**/api/rooms',async route=>{if(route.request().method()==='POST'&&creationResponsesLost===0){creationResponsesLost++;await route.fetch();await route.abort('failed');}else await route.continue();});
 await alice.goto(origin);await alice.locator('#create-room').click();await alice.locator('#copy-invite').waitFor();
 assert.equal(await alice.locator('.numeric-password-page').count(),0);
 await alice.locator('#copy-invite').click();await alice.locator('.app-toast').filter({hasText:'已复制'}).waitFor();
 const invite=await alice.evaluate(()=>navigator.clipboard.readText());assert.match(invite,/#j=[A-Za-z0-9_-]{43}$/);assert.ok(invite.length<100);
 await bob.goto(invite);await bob.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);
 assert.equal(new URL(bob.url()).hash,'');
 await send(bob,'before-replacement');await alice.getByText('before-replacement',{exact:true}).waitFor();
 const previous=await snapshot(bob),creator=await snapshot(alice);
 await bob.reload();await bob.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);await bob.getByText('before-replacement',{exact:true}).waitFor();
 const stranger=await newPage();await stranger.goto(invite);await stranger.locator('#create-room').waitFor();await stranger.locator('.app-toast').filter({hasText:'失效'}).waitFor();assert.equal(await stranger.locator('#message-input').count(),0);
 // An independently keyed second device of the same person survives replacement.
 await bob.bringToFront();await bob.locator('#chat-settings').click();await bob.locator('#manage-devices').click();await bob.locator('#add-own-device').click();await bob.locator('.app-toast').filter({hasText:'设备链接已复制'}).waitFor();
 const ownLink=await bob.evaluate(()=>navigator.clipboard.readText()),otherDevice=await newPage(!mobile);otherDevice.on('pageerror',error=>errors.push(error.message));
 await otherDevice.goto(ownLink);await otherDevice.locator('.device-inline-code').waitFor();assert.equal(await otherDevice.locator('.numeric-password-page').count(),0);
 await bob.bringToFront();await bob.locator('#refresh-devices').click();await bob.getByRole('button',{name:'安全码一致，允许加入',exact:true}).waitFor();
 assert.equal(await bob.locator('.pending-device-card .device-inline-code').textContent(),await otherDevice.locator('.device-inline-code').textContent());await bob.getByRole('button',{name:'安全码一致，允许加入',exact:true}).click();
 await otherDevice.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);const untouched=await snapshot(otherDevice);assert.equal(untouched.roomId,previous.roomId);assert.notEqual(untouched.archiveId,previous.archiveId);
 await bob.locator('#device-back').click();
 await alice.bringToFront();await alice.locator('#chat-settings').click();await alice.locator('#new-chat-link').click();await alice.locator(`input[value="${previous.id}"]`).check();await alice.locator('[data-copy]').click();await alice.locator('.app-toast').filter({hasText:'聊天链接已复制'}).waitFor();
 const replacement=await alice.evaluate(()=>navigator.clipboard.readText());assert.ok(replacement.length<100);assert.notEqual(replacement,invite);await alice.locator('[data-cancel]').click();
 const wrongType=await newPage(!mobile);await wrongType.goto(replacement);await wrongType.locator('.app-toast').filter({hasText:'这条链接用于接替'}).waitFor();assert.equal(await wrongType.locator('#message-input').count(),0);
 await bob.bringToFront();await bob.goto(replacement);await bob.locator('.app-toast').filter({hasText:'已进入密室'}).waitFor({timeout:30000});await bob.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false,{},{timeout:20000});await bob.getByText('before-replacement',{exact:true}).waitFor();
 const next=await snapshot(bob);assert.notEqual(next.id,previous.id);assert.equal(next.archiveId,previous.archiveId);
 const oldStatus=await fetch(`http://127.0.0.1:${service.port}/api/rooms/${previous.roomId}`,{headers:{Authorization:`Bearer ${previous.token}`}});assert.ok([401,403].includes(oldStatus.status));
 const creatorStatus=await fetch(`http://127.0.0.1:${service.port}/api/rooms/${creator.roomId}`,{headers:{Authorization:`Bearer ${creator.token}`}});assert.equal(creatorStatus.status,200);
 await send(bob,'after-replacement');await alice.getByText('after-replacement',{exact:true}).waitFor();await otherDevice.getByText('after-replacement',{exact:true}).waitFor();assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/rooms/${untouched.roomId}`,{headers:{Authorization:`Bearer ${untouched.token}`}})).status,200);
 // A copied old live-room token cannot revoke or read with the new endpoint.
 await bob.evaluate(async()=>{const k=await import('/src/lib/browser-room-key.ts'),p=await import('/src/lib/password-protection.ts');await k.protectBrowserRoomKey(await p.deriveNumericPasswordCredential('927451'));k.clearBrowserRoomKey();if(await k.browserRoomKey()!==null)throw new Error('Application lock retained automatic access');const v=await import('/src/lib/vault.ts');if('secret'in await v.readRoomProtection())throw new Error('Automatic secret is still durable');});
 await bob.reload();await bob.locator('.numeric-password-page').waitFor();assert.equal(await bob.locator('#message-input').count(),0);
 await bob.locator('[data-numeric-left]').click();await bob.getByRole('dialog',{name:'无法解锁本机',exact:true}).waitFor();
 await bob.locator('[data-help-action]').click();await bob.getByRole('dialog',{name:'清除全部本机数据？',exact:true}).getByRole('button',{name:'取消',exact:true}).click();await bob.getByRole('dialog',{name:'清除全部本机数据？',exact:true}).waitFor({state:'detached'});
 assert.equal(await bob.evaluate(async()=>!!await(await import('/src/lib/vault.ts')).readStoredVault()),true,'Cancelling global clear retains locked data');
 await bob.locator('[data-close]').click();await bob.getByRole('dialog',{name:'无法解锁本机',exact:true}).waitFor({state:'detached'});
 await submitPassword(bob,'111111');await bob.locator('.app-toast').waitFor();assert.equal(await bob.locator('.numeric-password-description').textContent(),'');
 await submitPassword(bob,'927451');await bob.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);assert.equal((await snapshot(bob)).archiveId,next.archiveId);
 await bob.locator('#chat-settings').click();await bob.locator('#room-lock-settings').click();
 bob.once('dialog',d=>d.dismiss());await bob.locator('[data-remove-room-lock]').click();assert.equal(await bob.evaluate(async()=>(await(await import('/src/lib/vault.ts')).readRoomProtection()).method),'password');
 await bob.locator('#auto-lock-back').click();
 // Exercise saved-card verification and private restoration through the actual settings UI.
 await bob.locator('#chat-settings').click();await bob.locator('#archive-settings').click();await bob.locator('[data-sync]').click();
 await bob.waitForFunction(()=>document.querySelector('[data-sync]')?.disabled===false);
 await bob.locator('[data-archive-status]').filter({hasText:'当前记录及原文件已备份'}).waitFor();
 if(mobile){const layout=await bob.locator('.backup-setting-copy').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));assert.ok(layout.length>0&&layout.every(width=>width>200),'Archive rows retain the shared full-width text column');assert.equal(await bob.locator('.subpage-header h1').evaluate(node=>parseFloat(getComputedStyle(node).fontSize)),26);}
 if(process.env.QR_VISUAL_DIR)await bob.screenshot({path:path.join(process.env.QR_VISUAL_DIR,'archive-settings.png')});
 await bob.locator('[data-card]').click();const phrase='a private recovery phrase';
 await bob.locator('[data-archive-help]').click();await bob.getByRole('dialog',{name:'没有可用的恢复口令',exact:true}).waitFor();await bob.locator('[data-close]').click();await bob.getByRole('dialog',{name:'没有可用的恢复口令',exact:true}).waitFor({state:'detached'});
 await fillFormInput(bob,bob.locator('[data-card-form] input[name=password]'),phrase);await fillFormInput(bob,bob.locator('[data-card-form] input[name=confirm]'),phrase);await bob.locator('[data-card-form] button').click();
 const cardPath=path.join(dataDir,'saved-card.png');
 if(mobile){
   // Chromium's simulated iPhone uses a controlled OS share receiver; the PNG
   // handed to it is still generated by the actual product and re-imported.
   await bob.evaluate(()=>{Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.savedTestCard=data.files[0];}});});
   await bob.locator('[data-download]').click();await bob.waitForFunction(()=>!!window.savedTestCard);
   await writeFile(cardPath,Buffer.from(await bob.evaluate(async()=>Array.from(new Uint8Array(await window.savedTestCard.arrayBuffer())))));
 }else{const downloadPromise=bob.waitForEvent('download');await bob.locator('[data-download]').click();await(await downloadPromise).saveAs(cardPath);}
 const choose=async selector=>{const chooserPromise=bob.waitForEvent('filechooser');await bob.locator(selector).click();await (await chooserPromise).setFiles(cardPath);};
 await choose('[data-verify] input[type=file]');await fillFormInput(bob,bob.locator('[data-verify] input[name=password]'),'incorrect long password');await bob.locator('[data-verify] button').click();await bob.locator('.app-toast').filter({hasText:'恢复口令不正确'}).waitFor();
 await fillFormInput(bob,bob.locator('[data-verify] input[name=password]'),phrase);await bob.locator('[data-verify] button').click();await bob.getByText('已保存并验证',{exact:true}).waitFor();
 await bob.locator('[data-back]').click();await bob.locator('#chamber-switch-space').click();await bob.locator(`${list} #space-create`).click();await bob.locator('#copy-invite').waitFor();
 const fresh=await snapshot(bob);assert.notEqual(fresh.roomId,next.roomId);assert.notEqual(fresh.archiveId,next.archiveId);
 await bob.locator('#chat-settings').click();await bob.locator('#archive-settings').click();await bob.locator('[data-restore]').click();await choose('[data-restore-form] input[type=file]');await fillFormInput(bob,bob.locator('[data-restore-form] input[name=password]'),phrase);await bob.locator('[data-restore-form] button').click();
 await bob.locator('.private-archive-message').filter({hasText:'before-replacement'}).waitFor();await bob.locator('.private-archive-message').filter({hasText:'after-replacement'}).waitFor();assert.ok(await bob.locator('.private-archive-message').evaluateAll(rows=>rows.every(row=>{const text=row.querySelector('.message-text'),label=row.querySelector('small'),time=row.querySelector('time');return !text||(label.getBoundingClientRect().bottom<=text.getBoundingClientRect().top+1&&text.getBoundingClientRect().bottom<=time.getBoundingClientRect().top+1);})), 'Private history labels and timestamps never overlap message text');if(process.env.QR_VISUAL_DIR)await bob.screenshot({path:path.join(process.env.QR_VISUAL_DIR,'restored-chat.png')});
 await bob.locator('#chat-settings').click();await bob.locator('#chamber-switch-space').click();const selected=bob.locator(`${list} .space-row.is-selected`);await selected.dispatchEvent('contextmenu');bob.once('dialog',d=>d.dismiss());await bob.locator('#space-delete').click();assert.equal(await bob.locator(`${list} .space-row`).count(),2);
 await bob.locator(`${list} .space-row.is-selected`).dispatchEvent('contextmenu');bob.once('dialog',d=>d.accept());await bob.locator('#space-delete').click();await bob.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);
 assert.equal((await snapshot(bob)).roomId,next.roomId);assert.equal(await bob.locator('.private-archive-message').count(),0);
 await bob.locator('#chat-settings').click();await bob.locator('#room-lock-settings').click();bob.once('dialog',d=>d.accept());await bob.locator('[data-remove-room-lock]').click();await submitPassword(bob,'927451');await bob.locator('#message-input').waitFor();
 assert.equal(await bob.evaluate(async()=>(await(await import('/src/lib/vault.ts')).readRoomProtection()).method),'automatic');
 assert.equal((await snapshot(bob)).archiveId,next.archiveId,'Removing the app lock preserves archive identity');
 await bob.evaluate(async()=>{const k=await import('/src/lib/browser-room-key.ts'),p=await import('/src/lib/password-protection.ts'),v=await import('/src/lib/vault.ts');await k.protectBrowserRoomKey(await p.deriveNumericPasswordCredential('927451'));const record=await v.readRoomProtection();let rejected=false;try{await v.clearAllRoomBrowserData({...record,revision:'stale'});}catch{rejected=true;}if(!rejected||!await v.readStoredVault())throw new Error('Stale reset deleted room data');});
 await bob.reload();await bob.locator('.numeric-password-page').waitFor();await bob.locator('[data-numeric-left]').click();await bob.locator('[data-help-action]').click();await bob.getByRole('dialog',{name:'清除全部本机数据？',exact:true}).getByRole('button',{name:'确认清除',exact:true}).click();await bob.locator('#create-room').waitFor();
 assert.equal(await bob.evaluate(async()=>{const v=await import('/src/lib/vault.ts');return !!await v.readStoredVault()||!!await v.readRoomProtection();}),false,'Confirmed global clear removes room data and protection');
 assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/rooms/${creator.roomId}`,{headers:{Authorization:`Bearer ${creator.token}`}})).status,200,'Local reset leaves the peer room intact');
 assert.equal(creationResponsesLost,1);assert.deepEqual(errors,[]);console.log('New-room UI passed: no-lock create/join/refresh, short single-use link, exact replacement preserving local history/card, live chat and application-lock toast.');
}catch(error){console.error('UI_FAILURE_STATE',await debugPage?.locator('body').innerText());throw error;}finally{await browser?.close();await vite?.close();await service?.close();await rm(dataDir,{recursive:true,force:true});}
