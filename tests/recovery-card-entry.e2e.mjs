import { legacyCreationPlugin } from './fixtures/legacy-create.mjs';
import { submitPassword } from './helpers/password.mjs';
import { fillFormInput, cancelPasswordForm } from './helpers/form-input.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'quiet-card-e2e-'));
const backend=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[legacyCreationPlugin,{name:'entry-test-observer',enforce:'pre',transform(code,id){if(id===path.join(process.cwd(),'src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});
let browser;
const secret='246810';
async function password(page){await submitPassword(page, secret);}
try {
 await vite.listen();browser=await chromium.launch(process.env.CI?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
 const pages=[];for(let i=0;i<3;i++){const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,acceptDownloads:true});const page=await context.newPage();page.setDefaultTimeout(20000);pages.push(page);}
 const [a,b,c]=pages;const url=`http://127.0.0.1:${vite.httpServer.address().port}/`;
 await a.goto(url);assert.equal(await a.locator('#continue-browser').count(),0);assert.equal(await a.locator('#restore-cloud').count(),0);
 await a.locator('#create-room').click();await fillFormInput(a, a.locator('#new-space-name'), '验收空间');await a.locator('#profile-done').click();
 assert.match(await a.locator('[data-device-verify]').textContent(),/应用锁/);await a.locator('[data-device-verify]').click();
 await a.locator('.password-form').waitFor();await a.clock.install();await a.clock.fastForward(65_000);
 assert.equal(await a.locator('.password-form').count(),1,'Reading a password form has no automatic timeout');
 await a.clock.resume();await cancelPasswordForm(a);await a.locator('.password-form').waitFor({state:'detached'});
 assert.equal(await a.locator('.welcome-actions .form-error').textContent(),'','Cancellation returns quietly');
 await a.locator('[data-device-verify]').click();await password(a);
 await a.locator('.chat-shell').waitFor();assert.equal(await a.locator('.space-invite-overlay').count(),0);await a.locator('#copy-invite').waitFor();
 assert.equal(await a.locator('#entrance-card-banner').count(),0);
 assert.match(await a.locator('#invite-countdown').textContent(),/剩余 \d+:\d{2}/);
 await a.locator('#chat-settings').click();await a.locator('.space-drawer-overlay[aria-label="设置"]').waitFor();await a.locator('.space-close').click();await a.locator('.space-drawer-overlay').waitFor({state:'detached'});
 await a.locator('#open-spaces').click();await a.locator('.space-row.is-selected').click();await a.locator('.space-drawer-overlay').waitFor({state:'detached'});
 assert.equal(await a.locator('.space-invite-overlay').count(),0,'Waiting-space row returns directly to chat');
 assert.match(await a.locator('#invite-countdown').textContent(),/剩余/);
 const invite=await a.locator('#invite-url').inputValue();await b.goto(invite);await b.locator('[data-device-verify]').click();await password(b);
 for(const page of [a,b])await page.waitForFunction(()=>app.session?.vault.mls?.phase==='active'&&!document.querySelector('#message-input')?.disabled);
 assert.equal(await a.locator('#welcome-chat').count(),0);
 // Editing uses the real persisted private directory and leaves the composer draft intact.
 await a.locator('#message-input').fill('未发送的草稿');await a.locator('#open-spaces').click();await a.locator('.space-row.is-selected').click({button:'right'});await a.locator('#space-avatar-edit').click();
 assert.equal(await a.locator('.space-profile-overlay').count(),0,'Avatar source opens over the list without an intermediate editor');
 assert.equal(await a.locator('.space-drawer-overlay').count(),1);
 await a.locator('#choose-art').click();
 await a.locator('[data-avatar-choice="fluent-yellow_heart"]').click();await a.locator('#profile-done').click();await a.locator('.space-profile-overlay').waitFor({state:'detached'});
 assert.equal(await a.locator('.space-row.is-selected img').getAttribute('data-avatar-emoji'),'fluent-yellow_heart');
 assert.equal(await a.evaluate(async()=>{const s=await import('/src/lib/spaces.ts');return (await s.localSpaces(app.session))[0].avatar.emoji;}),'fluent-yellow_heart');
 await a.evaluate(()=>app.renderRecoveryCenter());await a.locator('#save-my-code').click();await password(a);await a.locator('#download-recovery-card').waitFor();
 assert.equal(await a.evaluate(()=>Boolean(app.session.vault.recoveryExperience?.codeSaved)),false);
 const download=a.waitForEvent('download');await a.locator('#download-recovery-card').click();const file=await (await download).path();
 assert.equal(await a.evaluate(()=>Boolean(app.session.vault.recoveryExperience?.codeSaved)),false,'Download must not mark a card verified');
 await a.locator('#verify-recovery-card').click();await fillFormInput(a, a.locator('#check-saved-card textarea'), 'not a card');await a.locator('[data-card-check]').click();assert.ok((await a.locator('#check-saved-card .form-error').textContent()).length);
 const chooser=a.waitForEvent('filechooser');await a.locator('[data-card-file]').click();await(await chooser).setFiles(file);await a.getByText('已核对，恢复卡可以使用。',{exact:true}).waitFor();
 assert.equal(await a.evaluate(()=>app.session.vault.recoveryExperience.codeSaved===app.session.vault.backup.id),true);
 await a.locator('#hide-local-recovery').click();await a.locator('.local-recovery-code').waitFor({state:'detached'});
 // A new browser reads the exported file, sets daily unlock, and persists a pending recovery.
 await c.goto(url);await c.evaluate(()=>app.renderPersonalRestoreProtection());await c.locator('#restore-legacy-card').click();const importCard=c.waitForEvent('filechooser');await c.locator('[data-import-card]').click();await(await importCard).setFiles(file);
 await c.locator('[data-recovery-spaces] input').waitFor();assert.equal(await c.locator('[name=code]').inputValue(),'');await c.locator('#joint-code-form [type=submit]').click();await c.locator('[data-recovery-protect]').click();await password(c);
 await c.waitForFunction(()=>Boolean(app.session?.vault.pendingJointRecovery));
 const task=await c.evaluate(()=>app.session.vault.pendingJointRecovery.link.requestId);
 await c.reload();await c.locator('.password-form').waitFor();await password(c);await c.waitForFunction(()=>Boolean(app.session?.vault.pendingJointRecovery));
 assert.equal(await c.evaluate(()=>app.session.vault.pendingJointRecovery.link.requestId),task,'Pending request must survive encrypted local reload');
 console.log('Recovery card entry: password create, direct chat, saved-avatar persistence, export/reimport verification, new-browser recovery and encrypted resume passed.');
}finally{await browser?.close();await vite.close();await backend.close();await rm(dataDir,{recursive:true,force:true});}
