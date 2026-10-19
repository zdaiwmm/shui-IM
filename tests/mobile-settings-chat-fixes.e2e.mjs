import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
const fixture = await privacyFixture({ isMobile:true, hasTouch:true, deviceScaleFactor:3,
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1' });
const { page, errors } = fixture;
const evidence = process.env.QUIET_ROOM_UI_EVIDENCE;
const capture = async name => { if(evidence) { await mkdir(evidence,{recursive:true}); await page.screenshot({path:`${evidence}/${name}.png`}); } };
try {
  await page.evaluate(async()=>{
    const { app, session } = fixture;
    session.vault.personalBinding={identity:{id:'synthetic-ui-root'}};
    session.vault.personalGuide={mnemonicViewed:false};
    fixture.fresh(0);
    const {encryptImageFile}=await import('/src/lib/file-crypto.ts');
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=560;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#d4a5a5';ctx.fillRect(0,0,240,280);ctx.fillStyle='#607fa9';ctx.fillRect(0,280,240,280);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve));
    const file=new File([blob],'synthetic.png',{type:'image/png'});
    const manifest=await encryptImageFile(file,{includeDimensions:true,reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async()=>{},complete:async()=>{},savePlan:async()=>{}});
    app.cacheLocalImage(manifest,file);
    const own=session.vault.identity.publicBundle.deviceId, sentAt=new Date().toISOString();
    const records=Array.from({length:25},(_,i)=>({seq:i+1,clientMsgId:crypto.randomUUID(),senderId:own,payload:{v:1,kind:'text',text:`合成消息 ${i+1}`,sentAt},acceptedAt:sentAt,status:'stored'}));
    const source=records[0];
    records.push({seq:26,clientMsgId:crypto.randomUUID(),senderId:own,payload:{v:2,kind:'image',sentAt,image:manifest,replyTo:{clientMsgId:source.clientMsgId,serverSeq:source.seq,senderId:own,preview:'合成引用消息'}},acceptedAt:sentAt,status:'stored'});
    records.push({...records[1],seq:27,clientMsgId:crypto.randomUUID()});
    app.messages=new Map(records.map(message=>[message.seq,message]));app.renderMessages({scroll:'bottom'});
    window.syntheticRecords=records;
  });
  await page.clock.runFor(700);
  await page.waitForFunction(()=>document.querySelector('.image-preview')?.dataset.imageState==='loaded');
  const imageGeometry=await page.evaluate(()=>{
    const image=document.querySelector('.image-preview'),bubble=image.closest('.image-bubble'),row=bubble.closest('.message'),quote=bubble.querySelector('.message-reply-quote'),next=row.nextElementSibling;
    return {quoteGap:image.getBoundingClientRect().top-quote.getBoundingClientRect().bottom,
      bubbleContains:bubble.getBoundingClientRect().bottom>=image.getBoundingClientRect().bottom,
      rowContains:row.getBoundingClientRect().bottom>=image.getBoundingClientRect().bottom,
      nextGap:next.getBoundingClientRect().top-image.getBoundingClientRect().bottom,
      hidden:image.dataset.revealed,source:getComputedStyle(image,'::before').backgroundImage,opacity:getComputedStyle(image,'::before').opacity};
  });
  assert.ok(imageGeometry.quoteGap>=0&&imageGeometry.bubbleContains&&imageGeometry.rowContains&&imageGeometry.nextGap>=0,JSON.stringify(imageGeometry));
  assert.equal(imageGeometry.hidden,'false');assert.match(imageGeometry.source,/blob:/);assert.equal(imageGeometry.opacity,'1');
  await capture('image-reply-concealed');
  await page.evaluate(()=>{const image=document.querySelector('.image-preview');fixture.app.chatRevealedAssets.add(image.dataset.revealKey);fixture.app.updateChatImageVisibility(image);image.style.removeProperty('--chat-preview-source');fixture.app.concealChatImages();});
  assert.equal(await page.locator('.image-preview').evaluate(n=>getComputedStyle(n,'::before').opacity),'1');
  const gradient=await page.evaluate(()=>{
    const {app}=fixture,list=document.querySelector('#message-list');
    const bubble=list.querySelector('.outgoing .text-bubble');
    const before=bubble.style.getPropertyValue('--bubble-gradient-offset');
    app.chatViewportMotion.touchStart();app.chatViewportMotion.move();
    if(app.usesListScrolling)list.scrollTop=Math.max(0,list.scrollTop-50);else window.scrollBy(0,-50);
    app.scheduleChatScroll();return before;
  });
  await page.clock.runFor(16);
  assert.notEqual(await page.locator('.text-bubble').first().evaluate(n=>n.style.getPropertyValue('--bubble-gradient-offset')),gradient,'Gradient must change during the active scroll gesture');
  await page.evaluate(()=>fixture.app.chatViewportMotion.suspend());
  await page.evaluate(()=>fixture.app.mountPrivateSpaceDrawer(fixture.session,[],fixture.app.runtimeAbort.signal,'chat',0));
  for(const id of ['notification-settings','recover-other-space','passkey-management']) assert.equal(await page.locator(`#${id}`).count(),0);
  assert.equal(await page.locator('#manage-devices').textContent(),'设备管理');
  assert.equal(await page.locator('#cover-practice-menu .space-setting-label').textContent(),'入口遮蔽页');
  await page.locator('#presence-style-setting').click();
  assert.equal(await page.locator('.space-drawer .space-close').count(),0,'A child settings page has no redundant close action');
  for(const style of ['heart','capsule']) {
    await page.locator(`[data-style=${style}]`).click();
    assert.equal(await page.locator('.chamber-chat-header').getAttribute('data-presence-style'),style);
    assert.equal(await page.locator('.chamber-presence-capsule .presence-circuit').getAttribute('viewBox'),style==='heart'?'34 -5.52 32 32':'0 0 100 24');
    await page.clock.runFor(300);await capture(`presence-style-${style}`);
  }
  await page.locator('.space-back').click();
  await page.locator('#chamber-switch-space').click();
  assert.equal(await page.locator('#space-create').count(),1,'Switch-space retains creation');
  await page.evaluate(()=>{fixture.fresh(0);fixture.app.renderCoverSettings();});await page.clock.runFor(350);
  assert.equal(await page.getByRole('radio',{name:'遮蔽层，已选择'}).count(),1);
  for(const width of [320,390,768,1024])for(const mode of ['light','dark']) {
    await page.setViewportSize({width,height:520});await page.clock.runFor(500);
    await page.evaluate(async mode=>{const a=await import('/src/lib/appearance.ts');a.saveColorScheme(localStorage,mode);a.applyAppearance();},mode);
    const layout=await page.locator('.cover-settings-page').evaluate(n=>{const b=n.querySelector('#cover-settings-back').getBoundingClientRect();return {overflow:n.scrollWidth>n.clientWidth,back:b.height>=44&&b.bottom<=innerHeight,box:[b.x,b.y,b.width,b.height],height:innerHeight,root:document.querySelector('#app').getBoundingClientRect().height};});
    await capture(`cover-settings-${width}-${mode}`);assert.ok(!layout.overflow&&layout.back,JSON.stringify({width,mode,layout}));
    if(width===390)await capture(`cover-settings-${mode}`);
  }
  // A stored Chamber vault can use this page without touching old device-link APIs.
  let legacyRequests=0;
  await page.route('**/api/rooms/privacy-fixture/device-links',route=>{legacyRequests++;return route.fulfill({status:503,body:'{}'});});
  await page.route('**/api/rooms/privacy-fixture',async route=>route.fulfill({contentType:'application/json',body:await page.evaluate(()=>JSON.stringify({roomId:fixture.session.vault.roomId,members:fixture.session.vault.members,protocol:'legacy-v1'}))}));
  await page.evaluate(()=>{fixture.app.applyRoomStateQueued=async()=>{};return fixture.app.renderDeviceManager();});
  assert.equal(legacyRequests,0);assert.equal(await page.locator('.device-card').count(),1);
  assert.equal(await page.getByRole('button',{name:'添加设备',exact:true}).count(),0);
  assert.equal(await page.getByText('独立密钥 · 新设备只看新消息').count(),0);
  await capture('device-management');
  assert.deepEqual(errors,[]);
} finally { await fixture.close(); }
