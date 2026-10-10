import assert from 'node:assert/strict';
import { privacyFixture } from './helpers/privacy-fixture.mjs';

const fixture = await privacyFixture({ hasTouch: true });
const { page, errors } = fixture;
const locked = () => page.evaluate(() => window.fixture.app.privacyCovered);
const fresh = () => page.evaluate(() => window.fixture.fresh());
const chatPoint = async () => {
  const box = await page.locator('#message-list').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const tap = async point => { await page.mouse.click(point.x, point.y); };
const double = async point => { await tap(point); await page.clock.runFor(80); await tap(point); };
try {
  await fresh();
  const blank = await chatPoint();
  await tap(blank); assert.equal(await locked(), false, 'One blank tap must not lock');
  await page.clock.runFor(80); await tap(blank);
  assert.equal(await locked(), true, 'Two blank clicks must hard-lock');
  assert.equal(await page.locator('.chat-shell,.idle-lock-prompt').count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.app.session), null);
  const broadcast = await page.evaluate(() => JSON.parse(localStorage.getItem('quiet-room:manual-lock')));
  assert.ok(broadcast.space && broadcast.nonce, 'The gesture must use the existing same-vault invalidation');

  await fresh();
  await page.touchscreen.tap(blank.x, blank.y); await page.clock.runFor(80);
  await page.touchscreen.tap(blank.x, blank.y);
  assert.equal(await locked(), true, 'Touch must work without browser dblclick');

  await fresh();
  await page.evaluate(() => window.fixture.app.renderAutoLockSettings());
  assert.equal(await page.getByText('立即锁定', { exact: true }).count(), 0);
  await double({ x: 380, y: 750 });
  assert.equal(await locked(), true, 'Settings blank space must also lock');

  // Keep explicit content/controls outside the blank-space gesture.
  await fresh();
  await page.evaluate(() => {
    const probe = document.createElement('section'); probe.id = 'content-probe';
    probe.style.cssText = 'position:fixed;inset:100px 20px auto;z-index:50;background:var(--paper);padding:12px';
    probe.innerHTML = '<p id="probe-text">页面文字</p><div class="message-bubble" id="probe-bubble">消息</div><button id="probe-button">按钮</button><input id="probe-input"><img id="probe-image" alt="图片" width="30" height="30"><video id="probe-video" width="60" height="30"></video><div class="viewer-stage" id="probe-stage" style="height:30px"></div>';
    document.querySelector('#app').append(probe);
  });
  for (const id of ['probe-text', 'probe-bubble', 'probe-button', 'probe-input', 'probe-image', 'probe-video', 'probe-stage']) {
    const box = await page.locator(`#${id}`).boundingBox();
    await double({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    assert.equal(await locked(), false, `${id} must retain its own interaction`);
  }
  await page.evaluate(() => document.querySelector('#content-probe').remove());

  for (const interruption of ['slow', 'far', 'hold', 'drag', 'scroll', 'wheel', 'cancel', 'multitouch', 'blur', 'generation', 'replace']) {
    await fresh(); const point = await chatPoint(); await tap(point);
    if (interruption === 'slow') await page.clock.runFor(351);
    else if (interruption === 'far') point.x += 40;
    else if (interruption === 'hold') {
      await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.clock.runFor(301); await page.mouse.up();
      assert.equal(await locked(), false, 'A long press must not complete a pair'); continue;
    } else if (interruption === 'drag') {
      await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 20, point.y);
      await page.mouse.move(point.x, point.y); await page.mouse.up();
      assert.equal(await locked(), false, 'Dragging back to the origin must not count as a tap'); continue;
    } else if (interruption === 'scroll') await page.locator('#message-list').dispatchEvent('scroll');
    else if (interruption === 'wheel') await page.mouse.wheel(0, 5);
    else if (interruption === 'cancel') await page.locator('#message-list').dispatchEvent('pointercancel');
    else if (interruption === 'multitouch') await page.locator('#message-list').dispatchEvent('pointerdown', { isPrimary: false, pointerId: 2 });
    else if (interruption === 'blur') await page.evaluate(() => { window.fixture.blur(); window.fixture.focus(); });
    else if (interruption === 'generation') await page.evaluate(() => window.fixture.app.runtimeEpoch++);
    else if (interruption === 'replace') await page.evaluate(() => window.fixture.app.renderChat());
    await tap(point); assert.equal(await locked(), false, `${interruption} must cancel the pair`);
  }
  await fresh();
  await page.evaluate(() => {
    const list = document.querySelector('#message-list');
    for (let i = 0; i < 2; i++) for (const type of ['pointerdown', 'pointerup']) {
      list.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'touch' }));
    }
  });
  assert.equal(await locked(), false, 'Programmatic taps are not user gestures');

  // Body-mounted dialogs participate, and the completion never clicks the cover.
  await page.evaluate(async () => {
    const { mountDialog } = await import('/src/lib/dialog.ts');
    const modal = document.createElement('section'); modal.id = 'blank-modal'; modal.setAttribute('role', 'dialog');
    modal.style.cssText = 'position:fixed;inset:0;z-index:17000;background:var(--paper)';
    document.body.append(modal);
    window.blankModal = mountDialog(modal, { isActive: () => !window.fixture.app.privacyCovered });
    window.coverClicks = 0;
    document.querySelector('#app').addEventListener('click', () => window.coverClicks++);
  });
  await double({ x: 190, y: 400 });
  assert.equal(await locked(), true); assert.equal(await page.evaluate(() => window.coverClicks), 0);
  await page.evaluate(() => window.blankModal.dispose());

  // A first tap cannot survive lock/unlock even if a new page reuses the coordinates.
  await fresh(); await tap(await chatPoint()); await fresh(); await tap(await chatPoint());
  assert.equal(await locked(), false);
  await fresh();
  await page.evaluate(() => { window.fixture.app.idleDeadline = Date.now() - 1; });
  await tap(await chatPoint()); assert.equal(await locked(), true, 'Gesture processing cannot renew an expired lease');
  assert.deepEqual(errors, []);
  console.log('Blank double-lock passed: trusted mouse/touch, settings/dialogs, full lock/broadcast, excluded content, interrupted pairs, stale runtime and no click-through.');
} finally { await fixture.close(); }
