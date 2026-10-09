import assert from 'node:assert/strict';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
const fixture = await privacyFixture(); const {page, errors} = fixture;
try {
  for (const kind of ['picker','microphone','camera']) {
    assert.equal(await page.evaluate(async kind => {
      const {app,fresh,blur,focus}=window.fixture; fresh();
      app.beginNativeHandoff(kind,30_000); const epoch=app.runtimeEpoch;
      blur(); blur(); const intact=!app.privacyCovered&&!document.documentElement.classList.contains('privacy-obscured');
      focus(); const invalid=await app.finishNativeHandoff(kind);
      return intact&&!invalid&&app.runtimeEpoch===epoch&&!app.nativeHandoff;
    },kind),true,`${kind} visible focus transfer must preserve the runtime`);
    assert.equal(await page.evaluate(async kind => {
      const {app,fresh,blur,focus}=window.fixture; fresh(); app.beginNativeHandoff(kind,30_000); blur();
      const owner=app.nativeHandoff; owner.deadline=performance.now()-1;
      app.expireNativeHandoff(owner); focus();
      return !app.privacyCovered&&!!app.session&&!app.nativeHandoff;
    },kind),true,`${kind} timeout must cancel only the operation`);
  }
  for (const outcome of ['success','failure','overlap','stale','timeout']) {
    assert.equal(await page.evaluate(async outcome => {
      const {app,fresh,blur,focus}=window.fixture; fresh(); let complete;
      const first=app.withSystemSurface(()=>new Promise((resolve,reject)=>{complete=outcome==='failure'?reject:resolve;}));
      const caught=first.then(()=>false,()=>true), owner=app.systemSurfaceHandoff; blur(); blur();
      let second;
      if(outcome==='overlap'){focus();second=app.withSystemSurface(()=>new Promise(resolve=>window.finishSecond=resolve));}
      if(outcome==='stale'){app.lockNow();fresh();}
      if(outcome==='timeout'){owner.wallDeadline=Date.now()-1;app.expireSystemSurfaceHandoff(owner);}
      complete(outcome==='failure'?new Error('cancelled'):'done'); const rejected=await caught;
      if(second){if(app.systemSurfaceTokens.size!==1)return false;window.finishSecond();await second;}
      focus(); return !app.privacyCovered&&!!app.session&&!app.systemSurfaceHandoff&&app.systemSurfaceTokens.size===0
        &&rejected===['failure','stale','timeout'].includes(outcome)&&!document.documentElement.classList.contains('privacy-obscured');
    },outcome),true,`System ${outcome} must preserve operation ownership without a competing lock timer`);
  }
  // Result before focus remains operation-bound; a late result is rejected without relocking a new runtime.
  await page.evaluate(() => { const {app,fresh,blur}=window.fixture;fresh();app.setMediaPermission('camera',true);blur();window.permission=app.setMediaPermission('camera',false); });
  await page.evaluate(() => window.fixture.focus());
  assert.equal(await page.evaluate(()=>window.permission),false);
  await page.evaluate(() => { const {app,fresh,blur}=window.fixture;fresh();app.setMediaPermission('microphone',true);blur();window.permission=app.setMediaPermission('microphone',false); });
  await page.clock.runFor(251);
  assert.equal(await page.evaluate(()=>window.permission),true);
  assert.equal(await page.evaluate(()=>window.fixture.app.privacyCovered),false);
  for(const reason of ['hidden','pagehide','freeze','idle']) {
    await page.evaluate(reason=>{const {app,fresh,blur,visibility}=window.fixture;fresh();app.setMediaPermission('camera',true);blur();
      if(reason==='hidden')visibility(true);else if(reason==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide'));
      else if(reason==='freeze')document.dispatchEvent(new Event('freeze'));else {app.idleDeadline=Date.now()-1;app.expireIdleSession();}
      window.permission=app.setMediaPermission('camera',false);visibility(false);
    },reason);
    assert.equal(await page.evaluate(()=>window.permission),true);
    assert.equal(await page.evaluate(()=>window.fixture.app.privacyCovered&&!window.fixture.app.session),true);
  }
  // The unverified gateway retains its existing bounded native ceremony, including focus-before/after settlement.
  const gateway=()=>page.evaluate(()=>{const {app,fresh}=window.fixture;fresh();app.session=null;app.idleLease.clear();document.querySelector('#app').innerHTML='<section class="gateway"></section>';});
  await gateway();
  await page.evaluate(()=>{const {app,blur,visibility}=window.fixture;window.verification=app.withDeviceVerification(()=>new Promise(resolve=>window.resolveVerification=resolve));visibility(true);blur();});
  assert.equal(await page.evaluate(()=>window.fixture.app.deviceVerificationActive&&!window.fixture.app.privacyCovered),true);
  await page.evaluate(()=>{window.fixture.visibility(false);window.fixture.focus();window.resolveVerification('verified');});
  assert.equal(await page.evaluate(()=>window.verification),'verified');
  await gateway();
  await page.evaluate(()=>{const {app,blur}=window.fixture;window.verification=app.withDeviceVerification(()=>new Promise(resolve=>window.resolveVerification=resolve));window.verification.catch(()=>{});blur();window.resolveVerification('verified');});
  await page.evaluate(()=>window.fixture.focus()); assert.equal(await page.evaluate(()=>window.verification),'verified');
  await gateway();
  await page.evaluate(()=>{const {app,blur}=window.fixture;window.verification=app.withDeviceVerification(()=>new Promise(resolve=>window.resolveVerification=resolve));window.verification.catch(()=>{});blur();window.resolveVerification('late');});
  await page.clock.runFor(1501);
  assert.equal(await page.evaluate(()=>window.verification.then(()=>false,()=>true)),true);
  assert.equal(await page.evaluate(()=>window.fixture.app.privacyCovered),false,'Visible focus timeout must leave an unverified retryable gateway');
  for(const reason of ['pagehide','freeze','manual']){
    await gateway();await page.evaluate(reason=>{const {app}=window.fixture;window.verification=app.withDeviceVerification(()=>new Promise(resolve=>window.resolveVerification=resolve));window.verification.catch(()=>{});
      if(reason==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide'));else if(reason==='freeze')document.dispatchEvent(new Event('freeze'));else app.lockNow();window.resolveVerification('stale');},reason);
    assert.equal(await page.evaluate(()=>window.verification.then(()=>false,()=>true)),true);
  }
  assert.deepEqual(errors,[]);console.log('System surfaces E2E passed: visible native tools, operation-only timeout, overlap/stale ownership, late permission rejection, hard lifecycle and bounded gateway verification.');
} finally {await fixture.close();}
