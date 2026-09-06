import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { transform } from 'esbuild';

const { code: source } = await transform(await readFile(new URL('../scripts/cover-entry-probe.js', import.meta.url), 'utf8'), {
  minify: true, charset: 'utf8', target: 'safari17', supported: { 'template-literal': false },
});
const engine = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch(engine === chromium && !process.env.CI ? { channel: 'chrome' } : {});
try {
  const page = await browser.newPage();
  let network = 0;
  await page.route('**/*', route => { network++; return route.fulfill({
    contentType: 'text/html', body: '<html><body class="cover-mode"><div id="app"><button class="cover-trigger">hold</button></div></body></html>',
  }); });
  await page.goto('http://localhost/');
  await page.evaluate(() => { window.alerts = []; window.alert = text => window.alerts.push(text); });
  await page.evaluate(source);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.dispatchEvent('.cover-trigger', 'pointerdown', { pointerId: 1 });
  await page.evaluate(() => document.querySelector('.cover-trigger').classList.add('is-holding'));
  await page.dispatchEvent('.cover-trigger', 'pointercancel', { pointerId: 1 });
  await page.evaluate(() => document.querySelector('.cover-trigger').classList.remove('is-holding'));
  await page.evaluate(() => {
    document.body.className = 'app-mode';
    // Must detect even a gateway which is replaced in the very same task.
    document.querySelector('#app').innerHTML = '<section class="gateway"><button id="passkey-unlock" disabled>SECRET_SENTINEL</button></section>';
    document.querySelector('#app').innerHTML = '<button class="cover-trigger">hold</button>';
    document.body.className = 'cover-mode';
  });
  await page.evaluate(source);
  const report = await page.evaluate(() => window.alerts.at(-1));
  assert.match(report, /pointerdown/);
  assert.match(report, /visibilitychange/);
  assert.match(report, /pointercancel/);
  assert.match(report, /gateway-added/);
  assert.doesNotMatch(report, /SECRET_SENTINEL/);
  assert.equal(await page.evaluate(() => '__quietRoomCoverEntryProbe' in window), false);
  const reportCount = await page.evaluate(() => window.alerts.length);
  await page.dispatchEvent('.cover-trigger', 'pointerdown', { pointerId: 2 });
  assert.equal(await page.evaluate(() => window.alerts.length), reportCount);
  assert.equal(network, 1, 'The probe must not make network requests');
  console.log(`${engine.name()}: event timing, transient gateway, no DOM text/network, and cleanup passed`);
} finally { await browser.close(); }
