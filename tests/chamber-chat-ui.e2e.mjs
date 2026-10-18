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
    const {session,app}=fixture;
    session.vault.personalBinding={identity:{id:'synthetic-ui-root'}};
    session.vault.members.push({deviceId:'synthetic-peer',role:'joiner',status:'active'});
    fixture.fresh(0);
    window.stableShell=document.querySelector('.chat-shell');window.stableGuide=document.querySelector('.chamber-privacy-guide');
    window.originalViewportHeight=visualViewport.height;
  });
  await page.clock.runFor(500);
  assert.equal(await page.locator('#message-list > .chamber-privacy-guide').count(),1);
  const before=await page.locator('.chamber-privacy-guide').boundingBox();
  await page.locator('#message-input').focus();
  await page.evaluate(()=>{
    Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>480});
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.clock.runFor(800);
  const after=await page.locator('.chamber-privacy-guide').boundingBox();
  assert.ok(after.y < before.y-100,`Guidance must follow keyboard/list: ${JSON.stringify({before,after})}`);
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
  assert.match(await page.locator('.space-drawer .form-error').textContent(),/加入密室后可设置/);
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
  assert.deepEqual(errors,[]);
  console.log('Chamber chat UI: keyboard-following guidance, theme separation, readiness guard, half sheet and cover alignment passed (synthetic component evidence).');
} finally { await fixture.close(); }
