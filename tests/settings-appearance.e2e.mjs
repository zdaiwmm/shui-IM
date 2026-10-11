import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
const fixture = await privacyFixture({ viewport: { width: 1440, height: 900 } });
const { page, errors } = fixture;
// Chromium queues media-query changes on a real rendering turn. Deliver that
// turn before advancing the paused fixture clock; the assertions remain exact.
const systemAppearance = async colorScheme => {
  await page.emulateMedia({ colorScheme }); await page.waitForTimeout(40); await page.clock.runFor(80);
};
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
  assert.equal(await page.locator('[name="color-scheme"][value="system"]').isChecked(), true, 'Old installs default to system');
  await page.locator('[name="color-scheme"][value="light"]').check();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), 'light');
  const manualLight = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--space-heart-red')]);
  await systemAppearance('dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), 'light', 'Manual light overrides OS dark');
  assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--space-heart-red')]), manualLight, 'Manual scheme owns loaded colors, including space status');
  await page.locator('[name="color-scheme"][value="dark"]').check();
  const manualDark = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--space-heart-red')]);
  await systemAppearance('light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), 'dark', 'Manual dark overrides OS light');
  assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--space-heart-red')]), manualDark);
  await page.evaluate(() => { window.schemeSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key,value) { if(key==='quiet-room:color-scheme')throw Error('denied'); return window.schemeSetItem.call(this,key,value); }; });
  await page.locator('[name="color-scheme"][value="light"]').click();
  assert.equal(await page.locator('[name="color-scheme"][value="dark"]').isChecked(), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), 'dark');
  assert.match(await page.locator('.form-error').textContent(), /已保留原明暗模式/);
  await page.evaluate(() => { Storage.prototype.setItem = window.schemeSetItem; });
  await page.locator('[name="color-scheme"][value="system"]').check();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), 'light');
  await systemAppearance('dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), 'dark', 'System follows OS again');
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
  assert.equal(await page.locator('[name="appearance"][value="green"]').isChecked(), true, 'Open preferences sync across tabs');
  await sibling.evaluate(() => localStorage.setItem('quiet-room:color-scheme','light'));
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === 'light');
  assert.equal(await page.locator('[name="color-scheme"][value="light"]').isChecked(), true);
  await sibling.evaluate(() => localStorage.setItem('quiet-room:color-scheme','invalid'));
  await page.waitForFunction(() => document.documentElement.dataset.colorSchemePreference === 'system');
  assert.equal(await page.locator('[name="color-scheme"][value="system"]').isChecked(), true);
  await sibling.evaluate(() => localStorage.removeItem('quiet-room:color-scheme'));
  await sibling.close();

  // Confirmed P1: actual product components, including a browser-height keyboard
  // viewport, must keep the source readable and all message actions reachable.
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 695 });
    await page.evaluate(() => {
      const { app, session, fresh } = window.fixture; fresh(0);
      document.documentElement.dataset.theme = 'blue';
      app.messages = new Map(Array.from({ length: 18 }, (_, index) => {
        const seq = index + 1;
        return [seq, { seq, clientMsgId: `visual-${seq}`, senderId: index % 3 === 0 ? 'visual-peer' : session.vault.identity.publicBundle.deviceId,
          payload: { v: 1, kind: 'text', text: index === 17 ? '明天见，记得带上相机。' : `周末散步 · 合成消息 ${seq}`, sentAt: '2026-10-10T02:00:00Z' }, status: 'delivered' }];
      }));
      app.renderMessages({ scroll: 'bottom' });
    });
    await page.clock.runFor(500);
    const normal = await page.locator('.chat-header').boundingBox();
    assert.ok(normal.height <= 49, `${scheme}: normal header must be compact`);
    await screenshot(`p1-chat-${scheme}`);
    await page.evaluate(() => {
      const app = window.fixture.app;
      const message = app.messages.get(18);
      const article = document.querySelector('[data-client-msg-id="visual-18"]');
      app.openMessageActions(article, message);
    });
    await page.clock.runFor(300);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.message-action-list')).transform === 'none');
    assert.deepEqual(await page.locator('.message-action-list > button').evaluateAll(nodes => nodes.map(node => node.dataset.messageAction)), ['reply', 'info', 'copy', 'delete', 'select']);
    const menu = await page.locator('.message-action-list').evaluate(node => ({ filter: getComputedStyle(node).backdropFilter,
      background: getComputedStyle(node).backgroundColor, targets: [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) }));
    assert.equal(menu.filter, 'none');
    assert.ok(menu.targets.every(height => height >= 44), JSON.stringify(menu));
    assert.equal(await page.locator('.message-reaction-picker button').count(), 6);
    await screenshot(`p1-long-press-${scheme}`);
    await page.evaluate(() => window.fixture.app.closeMessageActions(false, false));
    await page.setViewportSize({ width: 320, height: 270 });
    await page.clock.runFor(500);
    const compact = await page.evaluate(() => {
      // This is the CSS keyboard state at a 270px browser viewport. The actual
      // detector, caret pan and opening/closing frames run in list-viewport E2E.
      document.documentElement.dataset.keyboardOpen = 'true';
      const header = document.querySelector('.chat-header').getBoundingClientRect();
      const composer = document.querySelector('.composer').getBoundingClientRect();
      const style = getComputedStyle(document.querySelector('#message-input'));
      return { header: header.height, visibleChat: composer.top - header.bottom,
        max: parseFloat(style.maxHeight), font: parseFloat(style.fontSize) };
    });
    assert.ok(compact.header <= 41);
    assert.equal(compact.max, 88); assert.ok(compact.font >= 16);
    assert.ok(compact.visibleChat >= 170, `short browser viewport must retain >=170px of conversation, got ${compact.visibleChat}`);
    await screenshot(`p1-keyboard-${scheme}`);
    await page.evaluate(() => {
      delete document.documentElement.dataset.keyboardOpen;
      window.fixture.app.syncChatLayout();
      window.fixture.app.scrollChatToBottom();
    });
    await page.clock.runFor(500);
    await page.evaluate(() => {
      const app = window.fixture.app;
      app.openMessageActions(document.querySelector('[data-client-msg-id="visual-18"]'), app.messages.get(18));
    });
    await page.clock.runFor(300);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.message-action-list')).transform === 'none');
    const placements = await page.evaluate(() => ['.message-reaction-picker', '.message-action-preview', '.message-action-list'].map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    }));
    for (const rect of placements) assert.ok(rect.top >= -1 && rect.bottom <= 271 && rect.left >= -1 && rect.right <= 321, JSON.stringify(placements));
    assert.ok(placements[0].bottom <= placements[1].top && placements[1].bottom <= placements[2].top);
    await page.evaluate(() => { window.fixture.app.closeMessageActions(false, false); delete document.documentElement.dataset.keyboardOpen; });
  }

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
