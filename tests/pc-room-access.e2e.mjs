import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
import {submitPassword} from './helpers/password.mjs';

const dataDir=await mkdtemp(path.join(tmpdir(),'quiet-pc-room-access-'));let service,vite,browser;let participants=[];let stage='start';
const errors=[];
try {
  service=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
  vite=await createServer({root:process.cwd(),configFile:false,logLevel:'error',cacheDir:path.join(dataDir,'vite'),plugins:[{name:'pc-room-access-observer',enforce:'pre',transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${service.port}`,'/ws':{target:`ws://127.0.0.1:${service.port}`,ws:true}}}});await vite.listen();
  browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
  const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  const newPage=async()=>{const context=await browser.newContext({permissions:['clipboard-read','clipboard-write'],viewport:{width:1440,height:900}});await context.addInitScript(()=>{localStorage.setItem('quiet-room:auto-lock-seconds','0');localStorage.setItem('quiet-room:lock-on-hidden','0');});const page=await context.newPage();page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));return page;};
  const owner=await newPage(),peer=await newPage(),candidate=await newPage();participants=[owner,peer,candidate];
  const capture=async(page,name)=>{if(process.env.QR_VISUAL_DIR){await mkdir(process.env.QR_VISUAL_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.QR_VISUAL_DIR,name+'.png')});}};
  const ready=page=>page.waitForFunction(()=>document.querySelector('#message-input')?.disabled===false);
  const invite=async page=>{await page.locator('#copy-invite').click();return page.evaluate(()=>app.participantInviteUrl(app.session));};
  await owner.goto(origin);await owner.locator('#create-room').click();await owner.locator('#copy-invite').waitFor();
  await peer.goto(await invite(owner));await ready(peer);await ready(owner);
  const carrierRoom=await owner.evaluate(()=>app.session.vault.roomId);
  await owner.evaluate(()=>app.renderAddOwnDevice());await owner.locator('#copy-device-join').click();await submitPassword(owner,'123456');await submitPassword(owner,'123456');
  await owner.locator('.app-toast').filter({hasText:'设备链接已复制'}).waitFor();
  const deviceLink=await owner.evaluate(async()=>(await import('/src/lib/invite-link.ts')).makeDeviceInviteUrl(app.ownDeviceInvite));await candidate.goto(deviceLink);await ready(candidate);
  await owner.evaluate(()=>{localStorage.setItem('quiet-room:auto-lock-seconds','0');app.scheduleIdleLock();});
  await owner.evaluate(()=>app.renderCreate());await owner.waitForFunction(old=>app.session?.vault.roomId&&app.session.vault.roomId!==old,carrierRoom);await owner.locator('#copy-invite').waitFor();
  stage='join target peer';await peer.evaluate(()=>app.leaveSpace());await peer.goto(await invite(owner));await ready(peer);stage='target owner ready';await ready(owner);
  const targetRoom=await owner.evaluate(()=>app.session.vault.roomId);let approvalLinks=0;owner.on('request',r=>{if(r.method()==='POST'&&/\/device-links$/.test(new URL(r.url()).pathname))approvalLinks++;});
  await owner.locator('#message-input').fill('synthetic message before admission');await owner.locator('#composer').evaluate(f=>f.requestSubmit());await peer.getByText('synthetic message before admission',{exact:true}).waitFor();
  await candidate.waitForFunction(async roomId=>(await(await import('/src/lib/own-space-directory.ts')).ownDirectorySpaces(app.session)).some(s=>s.roomId===roomId&&s.catalogOnly),targetRoom);
  assert.equal(await candidate.evaluate(()=>app.session.vault.roomId),carrierRoom);
  assert.equal(await candidate.locator('.desktop-sidebar-toggle,.desktop-sidebar').count(),0,'New-room chat has no extra sidebar control');
  // Real UI request: a catalog entry must never be confused with membership.
  await candidate.locator('#chat-settings').click();await candidate.locator('#chamber-switch-space').click();
  assert.equal(await candidate.locator('.space-drawer-header #space-settings').count(),0);
  const row=candidate.locator('.space-row').filter({hasText:'尚未在此浏览器接入'});await row.click();
  await candidate.getByText('申请已发送',{exact:false}).waitFor();
  await owner.locator('[data-own-authorization]').waitFor();await capture(owner,'pc-authorization');
  assert.equal(await candidate.evaluate(()=>app.session.vault.roomId),carrierRoom,'Pending approval does not install the target room');
  assert.equal(approvalLinks,0,'A request alone never creates enrollment authority');
  const card=owner.locator('[data-own-authorization]');
  const placement=await card.evaluate(n=>{const list=n.parentElement,last=[...list.querySelectorAll('.message')].at(-1);return {isLast:list.lastElementChild===n,afterMessages:!last||n.getBoundingClientRect().top>=last.getBoundingClientRect().bottom};});
  assert.ok(placement.isLast&&placement.afterMessages,JSON.stringify(placement));
  await card.locator('[data-reject]').click();
  await candidate.getByText('原设备已拒绝本次申请。',{exact:true}).waitFor();assert.equal(await candidate.evaluate(()=>app.session.vault.roomId),carrierRoom);
  await candidate.locator('[data-own-room-retry]').click();await owner.locator('[data-own-authorization]').waitFor();
  await owner.locator('[data-own-authorization] [data-approve]').click();await submitPassword(owner,'123456');
  await candidate.waitForFunction(id=>app.session?.vault.roomId===id&&document.querySelector('#message-input')?.disabled===false,targetRoom);
  assert.equal(approvalLinks,1,'Explicit approval creates one internal single-use admission');
  assert.equal(await candidate.getByText('synthetic message before admission',{exact:true}).count(),0,'New admission does not disclose pre-join history');
  await candidate.locator('#message-input').fill('synthetic message after admission');await candidate.locator('#composer').evaluate(f=>f.requestSubmit());await peer.getByText('synthetic message after admission',{exact:true}).waitFor();
  // Desktop layout assertions use actual product components in the same room.
  await candidate.locator('#open-chat-tools').click();
  const compositor=await candidate.locator('#composer').evaluate(n=>({color:getComputedStyle(n).backgroundColor,width:n.getBoundingClientRect().width,shell:n.closest('.chat-shell').clientWidth}));
  assert.notEqual(compositor.color,'rgba(0, 0, 0, 0)');assert.ok(Math.abs(compositor.width-compositor.shell)<1,JSON.stringify(compositor));await capture(candidate,'pc-tools');await candidate.keyboard.press('Escape');
  const more=candidate.locator('.message.outgoing .desktop-message-more').last();await candidate.locator('.message.outgoing').last().hover();
  const dots=await more.evaluate(n=>{const r=n.getBoundingClientRect(),s=n.querySelector('svg').getBoundingClientRect(),b=n.closest('.message').getBoundingClientRect();return {dx:(s.x+s.width/2)-(r.x+r.width/2),dy:(s.y+s.height/2)-(r.y+r.height/2),gap:b.left-r.right};});assert.ok(Math.abs(dots.dx)<1&&Math.abs(dots.dy)<1&&Math.abs(dots.gap-8)<1,JSON.stringify(dots));
  stage='PC settings geometry';await candidate.locator('#chat-settings').click();await candidate.locator('.desktop-settings-page').waitFor();
  const backCenter=await candidate.locator('.desktop-settings-page .page-back-button').evaluate(n=>{const b=n.getBoundingClientRect(),p=n.closest('.desktop-settings-page').getBoundingClientRect();return (b.x+b.width/2)-(p.x+p.width/2);});assert.ok(Math.abs(backCenter)<1);
  await capture(candidate,'pc-settings');
  const before=await candidate.locator('.desktop-settings-page').boundingBox();await candidate.locator('#room-lock-settings').click();
  const snapshot=await candidate.locator('.page-transition-outgoing .desktop-settings-page').evaluate(n=>n.getBoundingClientRect().toJSON());assert.ok(Math.abs(snapshot.x-before.x)<1&&Math.abs(snapshot.width-before.width)<1,JSON.stringify({before,snapshot}));
  await candidate.locator('#auto-lock-back').click();await candidate.locator('.desktop-settings-page').waitFor();
  await candidate.locator('#cover-practice-menu').click();await candidate.locator('.cover-settings-page').waitFor();await candidate.evaluate(()=>app.renderCoverPractice());
  for(const size of [{width:1920,height:1080},{width:1024,height:600},{width:1366,height:480}]){
    await candidate.setViewportSize(size);await candidate.waitForTimeout(350);
    const geometry=await candidate.evaluate(()=>{const n=document.querySelector('.cover-practice-page');return {document:document.documentElement.scrollWidth>innerWidth,page:n.scrollWidth>n.clientWidth||n.scrollHeight>n.clientHeight,rect:n.getBoundingClientRect().toJSON()};});assert.ok(!geometry.document&&!geometry.page,JSON.stringify(geometry));
  }
  if(process.env.QR_VISUAL_DIR){await mkdir(process.env.QR_VISUAL_DIR,{recursive:true});await candidate.screenshot({path:path.join(process.env.QR_VISUAL_DIR,'pc-cover.png')});}
  assert.deepEqual(errors,[]);
  console.log('PASS PC room admission: real three-browser MLS, rejection/retry, original-device approval, no old history, messaging, chrome, footer, stationary navigation, cover and more-button geometry');
} catch(error) {console.error('PC_ACCESS_STAGE',stage);for(let i=0;i<participants.length;i++)console.error('PAGE',i,await participants[i].locator('body').innerText().catch(()=>''));throw error;} finally {await browser?.close();await vite?.close();await service?.close();await rm(dataDir,{recursive:true,force:true});}
