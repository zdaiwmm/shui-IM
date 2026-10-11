import assert from 'node:assert/strict';
import { privacyFixture } from './helpers/privacy-fixture.mjs';

const fixture = await privacyFixture();
const { page, errors } = fixture;
try {
  // Visual-viewport geometry is simulated here. Real Safari keyboard frames
  // remain a separate device check, including password manager presentation.
  for (const width of [320, 390]) for (const height of [270, 350]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async () => {
      window.fixture.fresh(0);
      const { requestPassword } = await import('/src/lib/password-dialog.ts');
      void requestPassword(document.querySelector('#app'), { title: '验证空间访问', context: '验证后继续本次导出操作。', spaceName: '两个人的空间', operation: '导出聊天备份', signal: window.fixture.app.runtimeAbort.signal, isActive: () => true, verify: async () => { throw Error('合成验证失败，请重新输入'); } }).catch(() => {});
    });
    await page.clock.runFor(300);
    await page.locator('[name="password"]').fill('synthetic password');
    await page.locator('.password-actions [type="submit"]').click();
    assert.match(await page.locator('#password-error').textContent(), /合成验证失败/);
    const geometry = await page.evaluate(() => ({
      actions: [...document.querySelectorAll('.password-actions button')].map(e => e.getBoundingClientRect().toJSON()),
      scrollable: document.querySelector('.password-page-content').scrollHeight > document.querySelector('.password-page-content').clientHeight,
      font: parseFloat(getComputedStyle(document.querySelector('[name="password"]')).fontSize),
    }));
    assert.ok(geometry.actions.every(e => e.y >= 0 && e.y + e.height <= height + 1 && e.height >= 44), `short password actions: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.scrollable, true); assert.equal(geometry.font, 16);
    await page.locator('[data-password-cancel]').click(); await page.clock.runFor(300);
    assert.equal(await page.locator('.password-sheet').count(), 0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.fixture.fresh(0)); await page.clock.runFor(300);
    for (const value of ['', '单行消息']) {
      await page.locator('#message-input').fill(value); await page.clock.runFor(300);
      const geometry = await page.locator('#message-input').evaluate(e => {
        const style = getComputedStyle(e), box = e.getBoundingClientRect(), field = e.closest('.composer-field').getBoundingClientRect();
        const lineCenter = box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
        return { lineCenter, fieldCenter: field.top + field.height / 2, height: box.height, line: parseFloat(style.lineHeight), placeholder: e.matches(':placeholder-shown') };
      });
      assert.ok(Math.abs(geometry.lineCenter - geometry.fieldCenter) <= .5, `${width}: empty and single-line editor share the vertical center ${JSON.stringify(geometry)}`);
      assert.equal(geometry.placeholder, !value); assert.equal(geometry.height, 44);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.fixture.fresh(0); window.fixture.app.showNotice('合成普通提示'); });
  await page.clock.runFor(2599); assert.equal(await page.locator('#notice').isVisible(), true);
  await page.clock.runFor(2); assert.equal(await page.locator('#notice').evaluate(e => e.classList.contains('is-leaving')), true);
  await page.clock.runFor(140); assert.equal(await page.locator('#notice').isVisible(), false);
  await page.evaluate(() => window.fixture.app.showNotice('合成错误提示', 'error'));
  await page.clock.runFor(2601); assert.equal(await page.locator('#notice').isVisible(), true);
  await page.clock.runFor(2540); assert.equal(await page.locator('#notice').isVisible(), false);

  await page.locator('#open-chat-tools').focus();
  await page.clock.runFor(399); assert.equal(await page.locator('[role="tooltip"]').count(), 0);
  await page.clock.runFor(2); assert.equal(await page.locator('[role="tooltip"]').count(), 1);
  assert.match(await page.locator('#open-chat-tools').getAttribute('aria-describedby'), /tooltip/);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('[role="tooltip"]').count(), 0);
  await page.evaluate(() => {
    const button = document.querySelector('#open-chat-tools'); button.blur();
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1 })); button.focus();
  });
  await page.clock.runFor(450); assert.equal(await page.locator('[role="tooltip"]').count(), 0, 'touch does not depend on hover help');
  await page.clock.runFor(600); await page.locator('#open-chat-tools').blur(); await page.locator('#open-chat-tools').focus();
  await page.clock.runFor(401); assert.equal(await page.locator('[role="tooltip"]').count(), 1);
  await page.evaluate(() => window.fixture.app.lockNow());
  assert.equal(await page.locator('[role="tooltip"]').count(), 0, 'privacy removes help immediately');

  await page.evaluate(() => {
    window.fixture.fresh(0); const input = document.querySelector('#message-input'); input.value = '保留输入草稿'; input.focus(); input.setSelectionRange(1, 3); window.p1Input = input;
    window.p1Scroll = document.querySelector('.message-list').scrollTop;
    localStorage.setItem('quiet-room:color-scheme', 'dark'); window.dispatchEvent(new StorageEvent('storage', { key: 'quiet-room:color-scheme' }));
  });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), 'dark');
  assert.deepEqual(await page.locator('#message-input').evaluate(e => ({ same: e === window.p1Input, focused: e === document.activeElement, value: e.value, start: e.selectionStart, end: e.selectionEnd, scroll: document.querySelector('.message-list').scrollTop === window.p1Scroll })), { same: true, focused: true, value: '保留输入草稿', start: 1, end: 3, scroll: true });
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  const colors = await page.locator('#message-input').evaluate(e => ({ ink: getComputedStyle(e).color, paper: getComputedStyle(e).backgroundColor }));
  assert.notEqual(colors.ink, colors.paper);
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
  await page.clock.resume();
  await page.evaluate(() => { localStorage.setItem('quiet-room:color-scheme','system'); window.dispatchEvent(new StorageEvent('storage',{key:'quiet-room:color-scheme'})); });
  for(let cycle=0;cycle<8;cycle++) {
    await page.emulateMedia({colorScheme:'light'});await page.waitForTimeout(60);
    await page.emulateMedia({colorScheme:'dark'});
    await page.evaluate(async()=>{(await import('/src/lib/appearance.ts')).applyAppearance();});
    await page.emulateMedia({colorScheme:'light'});
    await page.waitForFunction(()=>document.documentElement.dataset.colorScheme==='light',null,{timeout:1000});
  }
  assert.deepEqual(errors, []);
  console.log('P1 controls passed: short viewport password failure/cancel, exact toast timing, keyboard/touch/lock tooltips, preference changes preserve focused draft/selection/scroll, forced colors. Simulated viewport, not iPhone evidence.');
} finally { await fixture.close(); }
