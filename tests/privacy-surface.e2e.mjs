import assert from 'node:assert/strict';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
const fixture = await privacyFixture(); const { page, errors } = fixture;
const state = () => page.evaluate(() => ({ locked: window.fixture.app.privacyCovered, remaining: window.fixture.app.idleLease.remaining,
  prompt: !!document.querySelector('.idle-lock-prompt:not([hidden])'), obscured: document.documentElement.classList.contains('privacy-obscured') }));
try {
  for (const seconds of [30, 60, 120, 300]) {
    await page.evaluate(seconds => window.fixture.fresh(seconds), seconds);
    assert.equal((await state()).remaining, seconds * 1000);
    await page.clock.runFor(seconds * 1000 - 10001); assert.equal((await state()).prompt, false);
    await page.clock.runFor(101); assert.equal((await state()).prompt, true);
    const dimensions = await page.locator('.idle-lock-prompt').evaluate(button => ({ hit: button.getBoundingClientRect().height,
      visual: button.firstElementChild.getBoundingClientRect().height, action: button.querySelector('.idle-lock-extend').getBoundingClientRect().height,
      fill: button.querySelector('.idle-lock-fill').getBoundingClientRect().width, capsule: button.firstElementChild.clientWidth }));
    assert.equal(dimensions.hit, 44); assert.equal(dimensions.visual, 28); assert.equal(dimensions.action, 20);
    assert.ok(dimensions.fill > dimensions.capsule * .96);
    await page.clock.runFor(3000);
    await page.waitForTimeout(150); // CSS compositor time is independent of the mocked JS clocks.
    const ratio = await page.locator('.idle-lock-fill').evaluate(fill => fill.getBoundingClientRect().width / fill.parentElement.clientWidth);
    assert.ok(ratio > .65 && ratio < .73, `Entire capsule fill must shrink: ${ratio}`);
    const before = await page.locator('#message-list').boundingBox();
    await page.locator('.idle-lock-prompt').click();
    assert.equal((await state()).remaining, seconds * 1000); assert.equal((await state()).prompt, false);
    assert.deepEqual(await page.locator('#message-list').boundingBox(), before, 'Prompt must consume no chat layout space');
  }
  await page.evaluate(() => window.fixture.fresh());
  await page.locator('#message-input').fill('长消息草稿'); await page.locator('#message-input').focus();
  await page.clock.runFor(51_000); await page.locator('.idle-lock-prompt').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'message-input', 'Extension must preserve keyboard focus');
  await page.clock.runFor(51_000); await page.locator('#message-input').press('a');
  assert.equal((await state()).remaining, 60_000); assert.equal((await state()).prompt, false);
  const unchanged = await page.evaluate(() => {
    const { app, blur, focus } = window.fixture; const before = app.idleDeadline;
    blur(); focus(); document.dispatchEvent(new Event('input')); document.dispatchEvent(new Event('scroll'));
    app.renderMessages(); return { same: before === app.idleDeadline, covered: app.privacyCovered, obscured: document.documentElement.classList.contains('privacy-obscured') };
  });
  assert.deepEqual(unchanged, { same: true, covered: false, obscured: false });
  // Settings save / cancel / denied persistence; the warning remains fixed at 10 seconds.
  await page.evaluate(() => window.fixture.app.renderAutoLockSettings());
  await page.locator('[value="120"]').check(); await page.locator('#auto-lock-back').click(); await page.clock.runFor(400);
  assert.equal(await page.evaluate(() => localStorage.getItem('quiet-room:auto-lock-seconds')), '60');
  await page.evaluate(() => window.fixture.app.renderAutoLockSettings());
  await page.locator('[value="120"]').check(); await page.locator('#auto-lock-form button[type="submit"]').click(); await page.clock.runFor(400);
  assert.equal(await page.evaluate(() => localStorage.getItem('quiet-room:auto-lock-seconds')), '120');
  await page.evaluate(() => {
    window.fixture.app.renderAutoLockSettings(); window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'quiet-room:auto-lock-seconds') throw Error('denied'); return window.originalSetItem.call(this,key,value); };
  });
  await page.locator('[value="300"]').check(); await page.locator('#auto-lock-form button[type="submit"]').click();
  assert.equal(await page.locator('.form-error').textContent(), '未能保存，请重试');
  assert.equal(await page.evaluate(() => localStorage.getItem('quiet-room:auto-lock-seconds')), '120');
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; window.fixture.fresh(); });
  // An authenticated navigation still owns secrets between room runtimes.
  await page.evaluate(async () => { const {app}=window.fixture; await app.leaveSpace(); app.newSpaceCollectionCode='synthetic-code'; app.root.innerHTML='<section class="gateway" data-authenticated-page>创建空间</section>'; });
  await page.clock.runFor(51_000);
  assert.equal((await state()).prompt, true, 'Navigation without a room session must retain the global deadline');
  await page.clock.runFor(9000);
  assert.equal((await state()).locked, true);
  assert.equal(await page.evaluate(() => window.fixture.app.newSpaceCollectionCode), undefined);
  // Real cross-tab preference storage does not renew this tab or share unlock proof.
  await page.evaluate(() => window.fixture.fresh()); await page.clock.runFor(20_000);
  const sibling=await page.context().newPage(); await sibling.goto(page.url());
  const deadline=await page.evaluate(() => window.fixture.app.idleDeadline);
  await sibling.evaluate(() => localStorage.setItem('quiet-room:auto-lock-seconds','300'));
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.fixture.app.idleDeadline),deadline);
  await page.locator('#message-input').press('a'); assert.equal((await state()).remaining,300_000);
  await sibling.evaluate(() => localStorage.setItem('quiet-room:manual-lock',JSON.stringify({space:'other-vault',nonce:'1'})));
  await page.waitForTimeout(50); assert.equal((await state()).locked,false);
  const ownSpace=await page.evaluate(async () => { const {vaultSpaceId}=await import('/src/lib/vault.ts'); return vaultSpaceId(window.fixture.session.stored); });
  await sibling.evaluate(space => localStorage.setItem('quiet-room:manual-lock',JSON.stringify({space,nonce:'2'})),ownSpace);
  await page.waitForTimeout(50); assert.equal((await state()).locked,true); await sibling.close();
  await page.evaluate(() => window.fixture.fresh());
  // A keyboard-sized viewport keeps the capsule above the composer with no extra row.
  await page.setViewportSize({width:390,height:400}); await page.clock.runFor(51_000);
  const promptBox=await page.locator('.idle-lock-prompt').boundingBox(), composerBox=await page.locator('#composer').boundingBox();
  assert.ok(promptBox.y>=0 && promptBox.y+promptBox.height<=composerBox.y);
  await page.screenshot({path:'/private/tmp/quiet-room-idle-chat-small.png'});
  await page.setViewportSize({width:390,height:844}); await page.evaluate(() => {window.fixture.fresh();window.fixture.app.renderAutoLockSettings();});
  await page.clock.runFor(51_000); await page.screenshot({path:'/private/tmp/quiet-room-idle-settings.png'});
  assert.ok((await page.locator('.idle-lock-prompt').boundingBox()).y<844-44);
  await page.evaluate(() => window.fixture.fresh());
  // Modal ownership, accessible single action, no click-through or modal dismissal.
  await page.evaluate(async () => {
    const { mountDialog } = await import('/src/lib/dialog.ts');
    const modal = document.createElement('section'); modal.id = 'test-modal'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true');
    modal.style.cssText = 'position:fixed;inset:0;z-index:17000;background:var(--paper);';
    modal.innerHTML = '<input id="modal-input"><footer style="position:absolute;bottom:0"><button id="underlying">保存</button></footer>';
    document.body.append(modal); window.underlyingCount = 0; modal.querySelector('button').onclick = () => window.underlyingCount++;
    window.testDialog = mountDialog(modal, { isActive: () => true, initialFocus: modal.querySelector('input') });
  });
  await page.clock.runFor(51_000);
  assert.equal(await page.locator('#test-modal .idle-lock-prompt').count(), 1);
  await page.locator('.idle-lock-prompt').click();
  assert.equal(await page.evaluate(() => window.underlyingCount), 0);
  assert.equal(await page.locator('#test-modal').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'modal-input');
  await page.evaluate(() => window.testDialog.dispose());
  // A more restrictive recovery exposure cannot be renewed by typing / extension.
  await page.evaluate(() => {
    const { app, fresh } = window.fixture; fresh(300);
    const anchor = document.createElement('code'); anchor.id='exposure'; document.querySelector('#app').append(anchor);
    app.exposureAnchor=anchor; app.idleLease.limitExposure(60_000); app.scheduleIdleLock();
  });
  await page.clock.runFor(51_000);
  assert.equal(await page.locator('.idle-lock-prompt').getAttribute('aria-disabled'), 'true');
  assert.equal(await page.locator('.idle-lock-extend').isVisible(), false);
  await page.locator('#message-input').fill('仍在操作'); await page.clock.runFor(9000);
  assert.equal((await state()).locked, true);
  for (const reason of ['hidden', 'pagehide', 'freeze', 'bfcache', 'wall', 'monotonic']) {
    await page.evaluate(reason => {
      const { app, fresh, visibility, focus } = window.fixture; fresh();
      if (reason === 'hidden') visibility(true);
      else if (reason === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide'));
      else if (reason === 'freeze') document.dispatchEvent(new Event('freeze'));
      else if (reason === 'bfcache') window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
      else { if (reason === 'wall') app.idleDeadline=Date.now()-1; else app.idleMonotonicDeadline=performance.now()-1; app.resetIdleLock(); }
      visibility(false); focus();
    }, reason);
    assert.equal((await state()).locked, true, `${reason} must require new verification`);
    assert.equal(await page.locator('.chat-shell,.image-viewer,.idle-lock-prompt').count(), 0);
  }
  // A retained late action cannot unlock, including an already-mounted extension control.
  await page.evaluate(() => { const { app,fresh }=window.fixture; fresh(); app.idleDeadline=Date.now()+5000; app.idleMonotonicDeadline=performance.now()+5000; app.scheduleIdleLock(); window.lateExtend=app.idlePrompt.element; });
  await page.clock.runFor(5000); await page.evaluate(() => window.lateExtend.click());
  assert.equal((await state()).locked, true); assert.deepEqual(errors, []);
  console.log('Global idle E2E passed: all durations, fixed warning, whole capsule progress, zero layout cost, focus, settings failures, modal ownership, sensitive cap and hard lifecycle priority.');
} finally { await fixture.close(); }
