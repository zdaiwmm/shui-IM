import assert from 'node:assert/strict';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
import { submitPassword } from './helpers/password.mjs';
import { readFile } from 'node:fs/promises';

const fixture = await privacyFixture();
const { page, browser, errors } = fixture;
async function open(options = {}) {
  await page.evaluate(async options => {
    window.fixture.fresh(0);
    const { requestPassword } = await import('/src/lib/password-dialog.ts');
    window.numericProof = null; window.numericCalls = 0;
    window.numericAbort = new AbortController();
    void requestPassword(document.querySelector('#app'), {
      create: options.create, presentation: 'page', passwordFormat: 'numeric-6',
      title: '空间密码', context: '合成数字密码验收', spaceName: '合成空间',
      signal: window.numericAbort.signal, isActive: () => true, forgot: () => { window.numericForgot = true; },
      retryAfterMs: options.waitFailure ? async () => { throw Error('Synthetic retry state unavailable'); }
        : options.wait ? async () => Math.max(0, window.numericWaitUntil - Date.now()) : undefined,
      verify: async secret => {
        window.numericCalls++;
        if (options.pending) await new Promise(resolve => { window.numericRelease = resolve; });
        if (secret !== '012345' || options.fail) throw Error('密码错误，请重试');
        return true;
      },
    }).then(() => { window.numericProof = 'verified'; }, () => { window.numericProof = 'cancelled'; });
  }, options);
  await page.clock.runFor(500); await page.locator('.numeric-password-page').waitFor();
}
const digit = async value => { for (const number of value) await page.locator(`[data-digit="${number}"]`).click(); };
try {
  await open({ create: true });
  assert.equal(await page.locator('.numeric-password-page input').count(), 0);
  assert.equal(await page.locator('[data-digit]').count(), 10);
  await digit('01234'); assert.equal(await page.locator('.numeric-password-dots .filled').count(), 5);
  assert.equal(await page.evaluate(() => numericCalls), 0);
  await digit('5'); assert.equal(await page.locator('h2').last().textContent(), '再次输入密码');
  await digit('012346'); assert.match(await page.locator('.numeric-password-page .form-error').textContent(), /不一致/);
  assert.equal(await page.locator('.numeric-password-dots .filled').count(), 0);
  assert.equal(await page.evaluate(() => numericCalls), 0);
  await submitPassword(page, '012345'); await page.waitForFunction(() => numericProof === 'verified');
  await page.clock.runFor(500); assert.equal(await page.locator('.numeric-password-page').count(), 0);

  await open(); await page.locator('.numeric-password-page').press('a');
  await page.locator('.numeric-password-page').press('0'); await digit('1');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  assert.equal(await page.locator('.numeric-password-dots .filled').count(), 1);
  await page.locator('.numeric-password-page').press('Backspace');
  assert.equal(await page.locator('.numeric-password-dots .filled').count(), 0);
  await digit('654321'); await page.waitForFunction(() => document.querySelector('.numeric-password-page .form-error')?.textContent);
  assert.equal(await page.locator('.numeric-password-dots .filled').count(), 0);
  assert.equal(await page.locator('.numeric-password-form').getAttribute('aria-busy'), 'false');
  await submitPassword(page, '012345'); await page.waitForFunction(() => numericProof === 'verified');

  await open({ pending: true }); await digit('012345');
  assert.equal(await page.evaluate(() => numericCalls), 1);
  assert.equal(await page.locator('[data-digit="1"]').isDisabled(), true);
  await page.locator('.numeric-password-page').press('Escape'); await page.clock.runFor(500);
  await page.evaluate(() => numericRelease()); await page.clock.runFor(500);
  assert.equal(await page.evaluate(() => numericProof), 'cancelled');
  assert.equal(await page.locator('.numeric-password-page').count(), 0);

  await page.evaluate(() => { window.numericWaitUntil = Date.now() + 3000; });
  await open({ wait: true });
  assert.equal(await page.locator('[data-digit="1"]').isDisabled(), true);
  await page.locator('.numeric-password-page').press('1');
  assert.equal(await page.locator('.numeric-password-dots .filled').count(), 0);
  await page.clock.runFor(3100); assert.equal(await page.locator('[data-digit="1"]').isEnabled(), true);
  await digit('012'); await page.evaluate(() => fixture.visibility(true)); await page.clock.runFor(500);
  assert.equal(await page.evaluate(() => numericProof), 'cancelled');
  assert.equal(await page.locator('.numeric-password-page').count(), 0);

  await open({ waitFailure: true });
  const unavailable = await page.locator('.numeric-password-description').textContent();
  assert.match(unavailable, /无法读取重试状态/);
  await page.locator('.numeric-password-page').press('Backspace');
  await page.locator('.numeric-password-page').press('1');
  assert.equal(await page.locator('.numeric-password-description').textContent(), unavailable);
  assert.equal(await page.locator('[data-digit="1"]').isDisabled(), true);
  assert.equal(await page.evaluate(() => numericCalls), 0);
  await page.locator('.numeric-password-page').press('Escape'); await page.clock.runFor(500);

  await open(); await page.getByRole('button', { name: '忘记密码？', exact: true }).click();
  assert.equal(await page.evaluate(() => numericForgot), true);
  assert.equal(await page.evaluate(() => numericProof), 'cancelled');

  for (const [width, height] of [[320,568],[390,844],[430,932],[1024,768]]) {
    await page.setViewportSize({ width, height });
    for (const colorScheme of ['light','dark']) {
      await page.emulateMedia({ colorScheme }); await open();
      const geometry = await page.evaluate(() => {
        const keys = [...document.querySelectorAll('[data-digit]')].map(key => key.getBoundingClientRect());
        const keypad = document.querySelector('.numeric-password-keypad').getBoundingClientRect();
        const dots = document.querySelector('.numeric-password-dots').getBoundingClientRect();
        const actions = document.querySelector('.numeric-password-actions').getBoundingClientRect();
        return { minTarget: Math.min(...keys.map(key => key.width)), dotsAbove: dots.bottom < keypad.top,
          actionsBelow: actions.top >= keypad.bottom, overflow: document.documentElement.scrollWidth > innerWidth,
          center: keys.at(-1).x + keys.at(-1).width / 2, width: document.querySelector('.numeric-password-page').clientWidth };
      });
      assert.ok(geometry.minTarget >= 44); assert.ok(geometry.dotsAbove && geometry.actionsBelow, JSON.stringify(geometry));
      assert.equal(geometry.overflow, false); assert.ok(Math.abs(geometry.center - geometry.width / 2) < 1);
      await page.locator('.numeric-password-page').press('Escape'); await page.clock.runFor(500);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 }); await open();
  // Capture before opening another page: ordinary visibility cleanup remains enabled.
  const actual = await page.locator('.numeric-password-key').evaluateAll(keys => keys.map(key => key.getBoundingClientRect().toJSON()));
  const reference = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const prototype = await readFile(new URL('../docs/requirements/2026-10-15-iphone-numeric-passcode/prototype/screen.html', import.meta.url), 'utf8');
  // privacyFixture uses Vite custom appType, so supply only the reference HTML;
  // its real saved stylesheet/script still come from the same Vite origin.
  await reference.route('**/prototype/screen.html?mode=unlock', route => route.fulfill({ contentType: 'text/html', body: prototype }));
  await reference.goto(new URL('/docs/requirements/2026-10-15-iphone-numeric-passcode/prototype/screen.html?mode=unlock', page.url()).href);
  await reference.locator('.key').first().waitFor();
  const expected = await reference.locator('.key').evaluateAll(keys => keys.map(key => key.getBoundingClientRect().toJSON()));
  for (let i=0;i<10;i++) for (const property of ['x','y','width','height']) assert.ok(Math.abs(actual[i][property]-expected[i][property])<2, `V1 key ${i} ${property}: ${actual[i][property]} vs ${expected[i][property]}`);
  await reference.close();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await open();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '忘记密码？', exact: true }).click();
  assert.equal(await page.evaluate(() => numericProof), 'cancelled');
  assert.deepEqual(errors, []);
  console.log('PASS numeric setup/confirmation, exact V1 key geometry, keyboard, retry, cancellation, stale proof, privacy and responsive accessibility');
} finally { await fixture.close(); }
