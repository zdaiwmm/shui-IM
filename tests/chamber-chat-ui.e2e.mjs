import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { privacyFixture } from './helpers/privacy-fixture.mjs';

// Real components and styles with explicitly synthetic identity/viewport data.
// The cryptographic activation is covered separately by chamber-flow.
const fixture = await privacyFixture({isMobile:true,hasTouch:true,deviceScaleFactor:3});
const {page,errors} = fixture;
const evidence=process.env.QUIET_ROOM_UI_EVIDENCE;
const capture=async name=>{if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:`${evidence}/${name}.png`});}};
try {
  await page.evaluate(()=>{
    localStorage.setItem('quiet-room:presence-style','heart');
    const {session,app}=fixture;
    session.vault.personalBinding={identity:{id:'synthetic-ui-root'}};
    session.vault.members.push({deviceId:'synthetic-peer',role:'joiner',status:'active'});
    fixture.fresh(0);
    // Keep this keyboard case truly shorter than the open viewport. The
    // unrelated empty-chat illustration otherwise makes the timeline long.
    document.querySelector('#message-list .empty-conversation')?.remove();app.scrollChatToBottom();
    window.stableShell=document.querySelector('.chat-shell');window.stableGuide=document.querySelector('.chamber-privacy-guide');
    window.originalViewportHeight=visualViewport.height;
  });
  await page.clock.runFor(500);
  assert.equal(await page.locator('#message-input').evaluate(n=>n.getBoundingClientRect().height),44);
  assert.equal(await page.locator('.chamber-presence-capsule .presence-circuit').count(),1);
  // The Chamber capsule uses the same real connection/presence facts and
  // message motion controller as the existing split-heart presentation.
  const heart=page.locator('.chamber-presence-capsule .presence-circuit');
  await page.evaluate(()=>{fixture.app.connectionState='connected';fixture.app.rolePresence={creator:true,joiner:false};fixture.app.updatePeerStatus();});
  assert.equal(await heart.getAttribute('data-phase'),'offline');
  assert.deepEqual(await heart.evaluate(svg=>[...svg.querySelectorAll('.presence-half')].map(half=>getComputedStyle(half).opacity)),['0.35','1']);
  assert.equal(await heart.locator('.presence-base').evaluate(n=>getComputedStyle(n).opacity),'1');
  assert.equal(await heart.locator('.presence-heart').evaluate(n=>getComputedStyle(n).fill),await heart.evaluate(n=>{const test=document.createElement('span');test.style.color='var(--space-heart-red)';n.parentElement.append(test);const color=getComputedStyle(test).color;test.remove();return color;}));
  await page.evaluate(()=>{fixture.app.rolePresence={creator:true,joiner:true};fixture.app.updatePeerStatus();});
  assert.equal(await heart.getAttribute('data-phase'),'charging');
  await page.clock.runFor(4500);
  assert.equal(await heart.getAttribute('data-phase'),'online');
  await page.evaluate(()=>fixture.app.presenceCircuit.sent());await page.clock.runFor(32);
  assert.equal(await heart.getAttribute('data-phase'),'pulsing');
  assert.notEqual(await heart.locator('[data-half=right]').getAttribute('transform'),'translate(2 0)');
  await page.evaluate(()=>{fixture.app.connectionState='disconnected';fixture.app.rolePresence=null;fixture.app.updatePeerStatus();});
  assert.equal(await heart.getAttribute('data-phase'),'unknown');
  assert.equal(await heart.locator('[data-arc][d]').count(),0);
  const rails=await page.locator('#message-list').evaluate(list=>{const r=list.getBoundingClientRect(),s=getComputedStyle(list),c=list.querySelector('.chamber-privacy-guide').getBoundingClientRect();return {left:c.left-r.left-parseFloat(s.paddingLeft),right:r.right-parseFloat(s.paddingRight)-c.right};});
  assert.ok(Math.abs(rails.left)<1&&Math.abs(rails.right)<1,JSON.stringify(rails));
  assert.equal(await page.locator('#message-list > .chamber-privacy-guide').count(),1);
  const before=await page.locator('.chamber-privacy-guide').boundingBox();
  await page.locator('#message-input').focus();
  await page.evaluate(()=>{
    Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>480});
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.clock.runFor(800);
  const after=await page.locator('.chamber-privacy-guide').boundingBox();
  const keyboardGeometry=await page.evaluate(()=>({short:fixture.app.shortChatTimeline(),height:fixture.app.chatViewportHeight,composer:document.querySelector('#composer').offsetHeight,rows:[...document.querySelector('#message-list').children].map(n=>({kind:n.className,top:n.offsetTop,height:n.offsetHeight})),scroll:scrollY,list:fixture.app.usesListScrolling,pinned:fixture.app.chatPinnedToBottom}));
  assert.equal(keyboardGeometry.short,true,'The short-timeline case must fit the open viewport');
  assert.ok(Math.abs(after.y-before.y)<=1,`Short timeline remains top-aligned: ${JSON.stringify({before,after,keyboardGeometry})}`);
  const gap = await page.evaluate(()=>{const settings=document.querySelector('#chat-settings').getBoundingClientRect(),card=document.querySelector('.chamber-privacy-guide').getBoundingClientRect();return{above:settings.top,below:card.top-settings.bottom};});
  assert.ok(Math.abs(gap.above-gap.below)<=1,JSON.stringify(gap));
  assert.equal(await page.locator('.chamber-chat-header').evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.equal(await page.evaluate(()=>stableShell===document.querySelector('.chat-shell')&&stableGuide===document.querySelector('.chamber-privacy-guide')),true);
  await capture('joined-keyboard');
  await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));document.activeElement.blur();});
  await page.clock.runFor(800);
  for(const theme of ['blue','green','purple','apricot']) {
    await page.evaluate(async theme=>{const a=await import('/src/lib/appearance.ts');a.saveTheme(localStorage,theme);a.saveColorScheme(localStorage,'dark');a.applyAppearance();},theme);
    const colors=await page.evaluate(()=>({card:getComputedStyle(document.querySelector('.chamber-privacy-guide')).backgroundColor,paper:getComputedStyle(document.querySelector('.chat-shell')).backgroundColor}));
    assert.notEqual(colors.card,colors.paper,JSON.stringify({theme,colors}));
    await capture(`privacy-dark-${theme}`);
  }
  // Readiness is checked on entry and again on save, including a stale screen.
  await page.evaluate(()=>{
    const {session,app}=fixture;session.vault.role='joiner';session.vault.mls={phase:'awaiting-welcome'};
    app.mountPrivateSpaceDrawer(session,[],app.runtimeAbort.signal,'chat',0,'settings');
  });
  assert.equal(await page.locator('#presence-style-setting').isDisabled(),true);
  assert.match(await page.locator('#presence-style-setting').textContent(),/加入密室后可设置/);
  await page.evaluate(()=>{fixture.session.vault.mls.phase='active';});await page.clock.runFor(1000);
  assert.equal(await page.locator('#presence-style-setting').isEnabled(),true);
  await page.locator('#presence-style-setting').click();await page.clock.runFor(300);
  await page.evaluate(()=>{fixture.session.vault.mls.phase='awaiting-welcome';});
  const preference=await page.evaluate(()=>localStorage.getItem('quiet-room:presence-style'));
  await page.locator('[data-style="heart"]').click();
  assert.equal(await page.evaluate(()=>localStorage.getItem('quiet-room:presence-style')),preference);
  assert.match(await page.locator('#app-toast').textContent(),/加入密室后可设置/);
  await page.evaluate(()=>{fixture.session.vault.mls=undefined;fixture.fresh(0);fixture.app.renderAutoLockSettings();});
  assert.equal(await page.locator('#auto-lock-back').evaluate(node=>getComputedStyle(node).backgroundColor==='rgba(0, 0, 0, 0)'),false);
  await page.locator('[data-idle-toggle]').click();await page.locator('.auto-lock-duration').click();await page.clock.runFor(300);
  const sheet=await page.locator('.auto-lock-duration-panel').boundingBox();
  assert.ok(sheet.height>=844*.45&&sheet.height<=844*.65,JSON.stringify(sheet));
  await capture('wait-duration-half-sheet');
  await page.locator('.auto-lock-duration-sheet').press('Escape');await page.clock.runFor(300);
  await page.locator('.auto-lock-duration-sheet').waitFor({state:'detached'});
  assert.equal(await page.locator('.auto-lock-duration-sheet').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('auto-lock-duration')),true);
  await page.evaluate(()=>{fixture.fresh(0);fixture.app.renderCoverPractice();});await page.clock.runFor(300);
  const geometry=await page.evaluate(()=>{
    const note=document.querySelector('.cover-practice-notice').getBoundingClientRect(),hot=document.querySelector('.practice-hotspot').getBoundingClientRect();
    return{noteCenter:note.y+note.height/2,hotCenter:hot.y+hot.height/2,gap:hot.x-note.right};
  });
  assert.ok(Math.abs(geometry.noteCenter-geometry.hotCenter)<1&&geometry.gap>=40,JSON.stringify(geometry));
  await capture('cover-practice-alignment');
  await page.locator('.practice-hotspot').focus();await page.keyboard.down('Enter');await page.clock.runFor(1100);await page.keyboard.up('Enter');await page.clock.runFor(300);
  assert.equal(await page.locator('#skip-cover').evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
  await capture('cover-choice');
  for(const width of [390,1024,1440]) {
    await page.setViewportSize({width,height:844});
    await page.evaluate(()=>{fixture.session.vault.role='creator';fixture.fresh(0);});await page.clock.runFor(500);
    const header=await page.locator('.chamber-chat-header').evaluate(node=>{
      const capsule=node.querySelector('.chamber-presence-capsule').getBoundingClientRect(),settings=node.querySelector('#chat-settings').getBoundingClientRect();
      return{sameRow:Math.abs(capsule.y+capsule.height/2-settings.y-settings.height/2)<1,separated:capsule.right<=settings.left,settingsTarget:settings.width,sidebars:document.querySelectorAll('.desktop-sidebar,.desktop-sidebar-toggle').length};
    });
    assert.ok(header.sameRow&&header.separated&&header.settingsTarget>=44&&header.sidebars===0,JSON.stringify({width,header}));
    await capture(`chamber-header-${width}`);
  }
  // This component fixture has a deliberately non-UUID room and no valid
  // encrypted space directory. The real settings/list path is in chamber-flow.
  await page.evaluate(()=>fixture.app.mountPrivateSpaceDrawer(fixture.session,[],fixture.app.runtimeAbort.signal,'chat',0,'settings'));
  assert.equal(await page.locator('#chamber-switch-space').isVisible(),true);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(async()=>{
    fixture.fresh(0); fixture.app.renderPersonalMnemonicImport(undefined,undefined);
    (await import('/src/lib/form-input.ts')).mountFormInputs(document.querySelector('#app'));
  });
  const background = await page.locator('.chamber-identity-import').boundingBox();
  assert.equal(await page.locator('.page-back-footer [type=submit]').evaluate(button=>button.form===document.querySelector('.chamber-identity-import form')),true);
  const actions=await page.locator('.page-back-footer').evaluate(footer=>{const [a,b]=[...footer.querySelectorAll('button')].map(button=>button.getBoundingClientRect());return {gap:b.top-a.bottom,delta:Math.abs(a.width-b.width),heights:[a.height,b.height]};});
  assert.ok(Math.abs(actions.gap-8)<1&&actions.delta<1&&actions.heights.every(h=>h>=44),JSON.stringify(actions));
  await page.locator('[name=word0]').click(); await page.clock.runFor(32);
  await page.evaluate(()=>{window.stableEditor=document.querySelector('#form-input-draft');window.editorBlurs=0;stableEditor.addEventListener('blur',()=>editorBlurs++);});
  for (const height of [640,540,480]) {
    await page.evaluate(height=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>height});visualViewport.dispatchEvent(new Event('resize'));},height);
    await page.clock.runFor(32);
  }
  assert.ok(Math.abs((await page.locator('.form-input-panel').boundingBox()).y+(await page.locator('.form-input-panel').boundingBox()).height-480)<1);
  assert.deepEqual(await page.locator('.chamber-identity-import').boundingBox(),background);
  for(let index=0;index<12;index++) {
    assert.equal(await page.locator('#form-input-title').textContent(),`第${index+1}个助记词`);
    await page.locator('#form-input-draft').fill(`synthetic${index}`);
    if(index%2)await page.locator('#form-input-draft').press('Enter');else await page.locator('[data-form-input-done]').click();
    assert.equal(await page.locator(`[name=word${index}]`).inputValue(),`synthetic${index}`);
    if(index<11) {
      assert.equal(await page.evaluate(()=>document.activeElement===stableEditor&&document.querySelector('#form-input-draft')===stableEditor&&editorBlurs===0),true);
      assert.equal(await page.locator('.form-input-overlay').count(),1);
    }
  }
  assert.equal(await page.locator('.form-input-overlay').count(),0);
  await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});await page.clock.runFor(700);
  assert.equal(await page.locator('#personal-import-back').evaluate(node=>node.classList.contains('page-back-button')),true);
  await page.route('**/api/rooms/privacy-fixture',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({code:'UNAUTHORIZED',error:'Synthetic pending candidate'})}));
  await page.route('**/api/rooms/privacy-fixture/chamber-invitation',async route=>route.fulfill({contentType:'application/json',body:JSON.stringify({requestId:'synthetic-request',version:1,expiresAt:await page.evaluate(()=>fixture.session.vault.pendingChamberInvitation.expiresAt)})}));
  await page.evaluate(()=>{
    const {session,app}=fixture;session.vault.role='joiner';session.vault.pairingState='joining';session.vault.inviteToken='synthetic-token';session.vault.members[0].joinProof='synthetic-proof';
    session.vault.pendingChamberInvitation={requestId:'synthetic-request',secret:'synthetic-claim',version:1,expiresAt:new Date(Date.now()+30*60_000).toISOString()};
    fixture.fresh(0);app.renderPendingChamberJoin();
    window.codeSubmissions=[];app.completePendingJoin=async code=>{codeSubmissions.push(code);await new Promise(resolve=>window.releaseCode=resolve);throw new Error('Synthetic wrong code');};
  });await page.clock.runFor(100);
  const codePage=await page.locator('.chamber-join-shell').boundingBox();
  await page.locator('[data-code-digit="0"]').click();await page.clock.runFor(32);
  await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>480});visualViewport.dispatchEvent(new Event('resize'));});await page.clock.runFor(500);
  await page.locator('#form-input-draft').fill('1234');
  assert.deepEqual(await page.locator('.form-input-code-cells > span').allTextContents(),['1','2','3','4']);
  for(const theme of ['blue','green','purple','apricot'])for(const mode of ['light','dark']) {
    await page.evaluate(async({theme,mode})=>{const a=await import('/src/lib/appearance.ts');a.saveTheme(localStorage,theme);a.saveColorScheme(localStorage,mode);a.applyAppearance();},{theme,mode});
    const colors=await page.evaluate(()=>({cell:getComputedStyle(document.querySelector('.form-input-code-cells > span')).backgroundColor,panel:getComputedStyle(document.querySelector('.form-input-panel')).backgroundColor}));
    assert.notEqual(colors.cell,colors.panel,JSON.stringify({theme,mode,colors}));
    await capture(`code-keyboard-${mode}-${theme}`);
  }
  assert.deepEqual(await page.locator('.chamber-join-shell').boundingBox(),codePage);
  await page.locator('[data-form-input-done]').click();
  assert.equal(await page.locator('.chamber-code-card [type=submit]').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('.chamber-code-card [type=submit]').isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>codeSubmissions),['1234']);
  await page.locator('.chamber-code-card').evaluate(form=>form.requestSubmit());
  assert.deepEqual(await page.evaluate(()=>codeSubmissions),['1234']);
  assert.equal(await page.locator('.form-input-overlay').count(),0);
  await page.evaluate(()=>releaseCode());await page.clock.runFor(50);
  assert.equal(await page.locator('.chamber-code-card [type=submit]').isDisabled(),false);
  await page.evaluate(async()=>{(await import('/src/lib/form-input.ts')).cancelFormInput();});
  await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});await page.clock.runFor(700);
  // No-message cards must keep their actual scroll offset during timer/state
  // renders, even though they have no message-id anchor.
  await page.evaluate(()=>{
    fixture.session.vault.pairingState='ready';delete fixture.session.vault.pendingChamberInvitation;fixture.session.vault.role='creator';fixture.fresh(0); const guide=document.querySelector('.chamber-privacy-guide');guide.style.minHeight='1100px';
    window.scrollTo(0,120);fixture.app.chatScrollIntent='up';fixture.app.chatPinnedToBottom=false;
  });await page.clock.runFor(100);
  const readTop=await page.evaluate(()=>window.scrollY);
  await page.evaluate(()=>fixture.app.renderMessages('preserve'));await page.clock.runFor(100);
  assert.equal(await page.evaluate(()=>window.scrollY),readTop);
  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:844});
    for(const method of ['renderAppearanceSettings','renderReleaseHistory','renderBackupSettings']){
      await page.evaluate(method=>{fixture.session.vault.personalBinding=method==='renderBackupSettings'?undefined:{identity:{id:'synthetic-ui-root'}};fixture.fresh(0);fixture.app[method]();},method);await page.clock.runFor(100);
      assert.equal(await page.locator('.chamber-settings-page').count(),1,JSON.stringify({width,method,dom:await page.locator('#app').evaluate(n=>n.innerHTML.slice(0,400)),errors}));
      const layout=await page.locator('.chamber-settings-page').evaluate(p=>{const b=p.querySelector('.chamber-page-footer button').getBoundingClientRect(),f=p.querySelector('.chamber-page-footer').getBoundingClientRect();return {width:b.width,height:b.height,inside:b.bottom<=innerHeight+1,padding:b.left-f.left,overflow:document.documentElement.scrollWidth>innerWidth+1};});
      assert.ok(layout.width>0&&layout.height>=44&&layout.inside&&layout.padding===20&&!layout.overflow,JSON.stringify({width,method,layout}));
      await capture(`settings-${method}-${width}`);
    }
  }
  assert.deepEqual(errors,[]);
  console.log('Chamber chat UI: keyboard-following guidance, theme separation, readiness guard, half sheet and cover alignment passed (synthetic component evidence).');
} finally { await fixture.close(); }
