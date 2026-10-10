import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
const fixture = await privacyFixture({ viewport: { width: 1440, height: 900 } });
const { page, errors } = fixture;
const evidence = process.env.QUIET_ROOM_UI_EVIDENCE;
const screenshot = async name => { if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, `${name}.png`) }); } };
try {
  await page.evaluate(() => { const { app } = window.fixture; localStorage.removeItem('quiet-room:auto-lock-seconds'); app.idleLease.clear(); app.resetIdleLock(); });
  assert.equal(await page.evaluate(() => window.fixture.app.idleLease.remaining), 30_000);
  await page.evaluate(() => window.fixture.app.renderAutoLockSettings());
  assert.deepEqual(await page.locator('.preference-choice span').allTextContents(), ['20 秒','30 秒','40 秒','50 秒','1 分钟','2 分钟','3 分钟','4 分钟','5 分钟','永不']);
  assert.equal(await page.locator('button[type="submit"]').count(), 0);
  await page.locator('[value="0"]').check();
  await page.clock.fastForward(3_600_000);
  assert.equal(await page.evaluate(() => window.fixture.app.privacyCovered), false);
  assert.equal(await page.locator('.idle-lock-prompt').count(), 0);
  await screenshot('auto-lock-desktop');
  // Never cannot extend freshly revealed recovery material.
  await page.evaluate(() => {
    const { app } = window.fixture; const code = document.createElement('p'); document.querySelector('#app').append(code);
    app.exposureAnchor = code; app.idleLease.limitExposure(60_000); app.scheduleIdleLock();
  });
  await page.clock.fastForward(60_000);
  assert.equal(await page.evaluate(() => window.fixture.app.privacyCovered && !window.fixture.app.desktopAccess.peek()), true);

  await page.evaluate(() => { window.fixture.fresh(); window.fixture.app.renderAppearanceSettings(); });
  const palettes = new Set();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const theme of ['blue', 'green', 'purple', 'apricot']) {
      await page.locator(`[name="appearance"][value="${theme}"]`).check();
      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const luminance = variable => {
          context.clearRect(0,0,1,1); context.fillStyle = style.getPropertyValue(variable); context.fillRect(0,0,1,1);
          const [r,g,b] = context.getImageData(0,0,1,1).data;
          return [r,g,b].map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
            .reduce((sum,value,index) => sum + value * [.2126,.7152,.0722][index],0);
        };
        const contrast = (a,b) => { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
        return { theme: document.documentElement.dataset.theme, accent: style.getPropertyValue('--accent'), paper: style.getPropertyValue('--paper'),
          body: contrast('--ink','--paper'), outgoing: contrast('--on-accent','--outgoing'), danger: style.getPropertyValue('--danger') };
      });
      assert.equal(colors.theme, theme);
      assert.ok(colors.body >= 4.5 && colors.outgoing >= 4.5, `${theme}/${scheme} must retain readable text: ${JSON.stringify(colors)}`);
      palettes.add(`${scheme}:${colors.accent}:${colors.paper}`);
      assert.ok(colors.danger.includes('28'), 'Error colors must retain their semantic role');
    }
    for (const size of [{width:390,height:844},{width:800,height:600},{width:1440,height:900}]) {
      await page.setViewportSize(size); await page.clock.runFor(400);
      const bounds = await page.locator('.appearance-page').evaluate(page => ({ width: page.clientWidth, scroll: page.scrollWidth,
        targets: [...page.querySelectorAll('.preference-choice')].map(node => node.getBoundingClientRect().height) }));
      assert.ok(bounds.scroll <= bounds.width + 1 && bounds.targets.every(height => height >= 44));
      await screenshot(`appearance-${scheme}-${size.width}`);
    }
  }
  assert.equal(palettes.size, 8);
  await page.evaluate(() => { window.themeSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key,value) { if(key==='quiet-room:appearance')throw Error('denied'); return window.themeSetItem.call(this,key,value); }; });
  await page.locator('[name="appearance"][value="green"]').click();
  assert.equal(await page.locator('[name="appearance"][value="apricot"]').isChecked(), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'apricot');
  assert.match(await page.locator('.form-error').textContent(), /已保留原配色/);
  await page.evaluate(() => { Storage.prototype.setItem = window.themeSetItem; });
  const sibling = await page.context().newPage(); await sibling.goto(page.url());
  assert.equal(await sibling.evaluate(async () => { const {mountAppearance}=await import('/src/lib/appearance.ts'); mountAppearance(); return document.documentElement.dataset.theme; }), 'apricot');
  await sibling.evaluate(() => localStorage.setItem('quiet-room:appearance','green'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'green');
  await sibling.close();

  await page.evaluate(() => { window.fixture.focus(); window.fixture.app.renderAppAccess(); });
  await page.locator('.app-access-steps').waitFor();
  for (const outcome of ['dismissed','accepted']) {
    await page.evaluate(outcome => { const event = new Event('beforeinstallprompt', {cancelable:true});
      event.prompt=async()=>({outcome}); event.userChoice=Promise.resolve({outcome}); window.dispatchEvent(event); }, outcome);
    await page.locator('#install-app').click();
    await page.getByText(outcome==='dismissed'?'已取消添加，可从浏览器安装入口重试。':'请完成浏览器安装，之后从应用图标打开。',{exact:true}).waitFor();
  }
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  assert.equal(await page.locator('a[href="web+quietroom:open"]').count(), 1);
  await screenshot('app-access-installed');
  await page.evaluate(() => { const native=window.matchMedia; window.matchMedia=query=>query.includes('display-mode: standalone') ? {matches:true,addEventListener(){},removeEventListener(){}} : native(query); window.fixture.app.renderAppAccess(); });
  await page.getByText('你已在 Quiet Room 应用中。',{exact:true}).waitFor();
  assert.equal(await page.locator('#install-app,a[href="web+quietroom:open"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Settings/appearance E2E passed: 30s default, ten immediate choices, never + sensitive cap, four readable light/dark palettes, responsive geometry, failed-write rollback, persisted/cross-tab theme, install/cancel/installed/standalone states. OS install/launch remain device checks.');
} finally { await fixture.close(); }
