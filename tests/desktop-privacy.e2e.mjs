import assert from 'node:assert/strict';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
const fixture=await privacyFixture({viewport:{width:1280,height:800}});const {page,errors}=fixture;
try {
  assert.equal(await page.evaluate(()=>window.fixture.app.desktopBrowser),true);
  assert.equal(await page.evaluate(()=>window.fixture.app.idleLease.remaining),60_000);
  await page.evaluate(()=>{window.fixture.blur();window.fixture.focus();});
  assert.equal(await page.locator('.chat-shell').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('privacy-obscured')),false);
  await page.clock.runFor(60_000);
  assert.equal(await page.evaluate(()=>window.fixture.app.privacyCovered&&!window.fixture.app.session),true);
  // Every desktop entry goes to authentication; no retained-session restoration remains.
  await page.evaluate(()=>{window.fixture.app.renderUnlock=async()=>{document.querySelector('#app').innerHTML='<section data-auth-required>设备验证</section>';};});
  await page.keyboard.down('f');await page.clock.runFor(900);await page.keyboard.down('f');await page.clock.runFor(1099);
  assert.equal(await page.locator('[data-auth-required]').count(),0);
  await page.clock.runFor(1);await page.keyboard.up('f');
  await page.locator('[data-auth-required]').waitFor();
  for(const cancel of ['release','blur','hidden','manual','pointercancel','entry-epoch']){
    await page.evaluate(()=>{const {fresh,visibility}=window.fixture;fresh();visibility(true);visibility(false);});
    const box=await page.locator('.cover-trigger').boundingBox();assert.ok(box&&box.width>=80&&box.height>=80);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.clock.runFor(cancel==='release'?999:400);
    if(cancel==='release')await page.mouse.up();
    else if(cancel==='blur')await page.evaluate(()=>{window.fixture.blur();window.fixture.focus();});
    else if(cancel==='hidden')await page.evaluate(()=>{window.fixture.visibility(true);window.fixture.visibility(false);});
    else if(cancel==='manual')await page.evaluate(()=>window.fixture.app.lockNow());
    else if(cancel==='pointercancel')await page.locator('.cover-trigger').dispatchEvent('pointercancel',{pointerId:1});
    else await page.evaluate(()=>window.fixture.app.coverEntryEpoch++);
    await page.mouse.up();await page.clock.runFor(1100);
    assert.equal(await page.locator('[data-auth-required]').count(),0,`${cancel} must invalidate pending entry`);
    assert.equal(await page.evaluate(()=>window.fixture.app.privacyCovered&&!window.fixture.app.session),true);
  }
  await page.evaluate(()=>{window.fixture.fresh();window.fixture.app.lockNow();});
  const box=await page.locator('.cover-trigger').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.clock.runFor(1000);await page.mouse.up();await page.locator('[data-auth-required]').waitFor();
  assert.equal(await page.locator('.cover-activation-feedback,.cover-firework').count(),0);
  for(const cancel of ['release','blur','hidden','composition','modifier']){
    await page.evaluate(()=>{window.fixture.fresh();window.fixture.app.lockNow();});
    await page.keyboard.down('f');await page.clock.runFor(1000);
    if(cancel==='release')await page.keyboard.up('f');else if(cancel==='blur')await page.evaluate(()=>{window.fixture.blur();window.fixture.focus();});
    else if(cancel==='hidden')await page.evaluate(()=>{window.fixture.visibility(true);window.fixture.visibility(false);});
    else if(cancel==='composition')await page.evaluate(()=>document.dispatchEvent(new CompositionEvent('compositionstart')));else await page.keyboard.down('Shift');
    await page.clock.runFor(2500);await page.keyboard.up('f');if(cancel==='modifier')await page.keyboard.up('Shift');
    assert.equal(await page.locator('[data-auth-required]').count(),0,`${cancel} must cancel an F hold`);
  }
  await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',bubbles:true})));await page.clock.runFor(2100);
  assert.equal(await page.locator('[data-auth-required]').count(),0);
  // Incoming / connecting / status-only updates never become persistent use.
  await page.evaluate(()=>{const {app,fresh}=window.fixture;fresh();window.callState={phase:'incoming'};
    app.callView={update(){},destroy(){}};app.callController={get state(){return window.callState;},destroy(){}};
    app.updateCallView(window.callState);});
  await page.clock.runFor(30_000);assert.equal(await page.evaluate(()=>window.fixture.app.idleLease.paused),false);
  await page.evaluate(()=>{window.callState.phase='connected';window.fixture.app.updateCallView(window.callState);});
  assert.equal(await page.evaluate(()=>window.fixture.app.idleLease.paused),false,'A connected label without live media must not pause expiry');
  await page.evaluate(()=>{window.callState.localStream={getTracks:()=>[{readyState:'live',enabled:true}]};window.fixture.app.scheduleIdleLock();});
  assert.equal(await page.evaluate(()=>window.fixture.app.idleLease.paused),true);
  await page.clock.runFor(90_000);assert.equal(await page.evaluate(()=>window.fixture.app.privacyCovered),false);
  await page.evaluate(()=>{window.callState.phase='ended';window.fixture.app.scheduleIdleLock();});
  assert.equal(await page.evaluate(()=>window.fixture.app.idleLease.remaining),60_000);
  await page.evaluate(()=>window.fixture.visibility(true));assert.equal(await page.evaluate(()=>window.fixture.app.privacyCovered),true);
  assert.deepEqual(errors,[]);console.log('Desktop privacy E2E passed: unified idle policy, visible blur continuity, mandatory fresh authentication, corner/F hold scopes and cancellation, live-media-only persistent use and hard-leave priority.');
}finally{await fixture.close();}
