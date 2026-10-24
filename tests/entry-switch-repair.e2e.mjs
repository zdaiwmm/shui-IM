import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
import { submitPassword } from './helpers/password.mjs';

const fixture = await privacyFixture({ hasTouch: true });
const { page, errors } = fixture;
try {
  await page.clock.resume();
  await page.evaluate(async () => {
    const { app, session } = fixture;
    const vault = await import('/src/lib/vault.ts');
    const keys = await import('/src/lib/browser-room-key.ts');
    const archive = await import('/src/lib/room-archive-crypto.ts');
    const protection = await import('/src/lib/password-protection.ts');
    app.lockNow();
    const make = async name => {
      await vault.selectLocalSpace(crypto.randomUUID());
      return vault.createVault({ ...session.vault, roomId: crypto.randomUUID(), createdAt: new Date().toISOString(), pairingState: 'ready',
        roomArchiveV2: { key: archive.newArchiveKey() } }, '', 'platform', await keys.automaticRoomCredential());
    };
    const first = await make('first'), second = await make('second');
    await keys.protectBrowserRoomKey(await protection.deriveNumericPasswordCredential('012345'));
    app.connectSocket = async () => {};
    app.startAutomaticBackup = () => {};
    app.startBrowserAccessServices = async () => {};
    app.unreadCounter.ensureConfigured = async () => false;
    const openSession = app.openSession.bind(app);
    app.openSession = async () => { throw Error('Synthetic encrypted history read failure'); };
    keys.clearBrowserRoomKey();
    window.entryRepair = { vault, keys, first, second, openSession, requireKey: app.requireBrowserRoomKey.bind(app),
      before: JSON.stringify(await vault.readStoredRoom(second.stored.spaceId)) };
    await app.renderGateway({ trustedCoverActivation: true, autoUnlock: false });
  });
  await submitPassword(page, '012345');
  await page.locator('[data-retry-room-open]').waitFor();
  assert.equal(await page.locator('.numeric-password-page').count(), 0, 'A failed post-proof open must release the busy keypad');
  assert.match(await page.locator('[data-room-open-error]').innerText(), /Synthetic encrypted history/);
  assert.equal(await page.evaluate(async () => JSON.stringify(await entryRepair.vault.readStoredRoom(entryRepair.second.stored.spaceId)) === entryRepair.before), true, 'Opening failure preserves the encrypted vault');
  await page.evaluate(() => { fixture.app.openSession = entryRepair.openSession; });
  await page.locator('[data-retry-room-open]').click();
  await submitPassword(page, '012345');
  await page.locator('#message-input').waitFor();
  assert.equal(await page.evaluate(() => fixture.app.session.vault.roomId), await page.evaluate(() => entryRepair.second.vault.roomId));

  // Lock while a correct proof is returning, enter again, then release the old
  // result. Its retained password page must neither inert nor replace the cover.
  await page.evaluate(async () => {
    const app = fixture.app;
    window.delayNextKey = true;
    app.requireBrowserRoomKey = async signal => {
      const key = await entryRepair.requireKey(signal);
      if (window.delayNextKey) {
        window.delayNextKey = false; window.keyStalled = true;
        await new Promise(resolve => { window.releaseOldKey = resolve; });
      }
      return key;
    };
    app.lockNow(); await app.renderGateway({ trustedCoverActivation: true, autoUnlock: false });
  });
  await submitPassword(page, '012345');
  await page.waitForFunction(() => window.keyStalled);
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => { fixture.app.lockNow(); fixture.focus(); });
    const trigger = page.locator('.cover-trigger');
    const bounds = await trigger.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.waitForTimeout(1100); await page.mouse.up();
    await page.locator('.numeric-password-page').waitFor();
  }
  await page.evaluate(() => releaseOldKey());
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#message-input').count(), 0, 'A pre-lock result cannot open chat over its successor');
  await submitPassword(page, '012345'); await page.locator('#message-input').waitFor();

  // Also stop a proof inside actual decryption, before browser-room-key can
  // publish its in-memory authority. Lock must invalidate that late result.
  await page.evaluate(async () => {
    const app = fixture.app;
    app.requireBrowserRoomKey = entryRepair.requireKey;
    app.lockNow();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let once = true;
    window.originalDecrypt = decrypt;
    crypto.subtle.decrypt = async (...args) => {
      const result = await decrypt(...args);
      if (once) { once = false; window.decryptStalled = true; await new Promise(resolve => { window.releaseDecrypt = resolve; }); }
      return result;
    };
    await app.renderGateway({ trustedCoverActivation: true, autoUnlock: false });
  });
  await submitPassword(page, '012345'); await page.waitForFunction(() => window.decryptStalled);
  await page.evaluate(() => { fixture.app.lockNow(); releaseDecrypt(); });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => entryRepair.keys.browserRoomKey()), null, 'Crypto finishing after lock cannot repopulate the browser-room key');
  await page.evaluate(async () => { crypto.subtle.decrypt = originalDecrypt; await fixture.app.renderGateway({ trustedCoverActivation: true, autoUnlock: false }); });
  await submitPassword(page, '012345'); await page.locator('#message-input').waitFor();

  // Hold the old room's final write while a later selection arrives. The later
  // destination wins and reads its exact durable slot, even with a pending slot.
  await page.evaluate(async () => {
    const app = fixture.app;
    app.requireBrowserRoomKey = entryRepair.requireKey;
    entryRepair.leave = app.leaveSpace.bind(app);
    entryRepair.open = app.openSession;
    window.openedRooms = [];
    app.openSession = async () => {
      openedRooms.push(app.session.vault.roomId);
      document.querySelector('#app').innerHTML = '<main data-switch-complete></main>';
    };
    window.delayNextLeave = true;
    app.leaveSpace = async (...args) => {
      if (window.delayNextLeave) {
        window.delayNextLeave = false; window.leaveStalled = true;
        await new Promise(resolve => { window.releaseLeave = resolve; });
      }
      return entryRepair.leave(...args);
    };
    const first = entryRepair.first;
    window.oldSwitch = app.switchPrivateSpace({ roomId: first.vault.roomId, localId: first.stored.spaceId });
  });
  await page.waitForFunction(() => window.leaveStalled);
  await page.evaluate(() => {
    const second = entryRepair.second;
    window.latestSwitch = fixture.app.switchPrivateSpace({ roomId: second.vault.roomId, localId: second.stored.spaceId });
    releaseLeave();
  });
  await page.waitForFunction(() => openedRooms.length > 0);
  assert.deepEqual(await page.evaluate(() => openedRooms), [await page.evaluate(() => entryRepair.second.vault.roomId)], 'Only the last selected room may open');
  for (let round = 0; round < 4; round++) {
    await page.evaluate(async round => {
      const target = round % 2 ? entryRepair.second : entryRepair.first;
      await fixture.app.switchPrivateSpace({ roomId: target.vault.roomId, localId: target.stored.spaceId });
    }, round);
    await page.waitForFunction(round => fixture.app.session?.vault.roomId === (round % 2 ? entryRepair.second : entryRepair.first).vault.roomId, round);
    assert.equal(await page.locator('.numeric-password-page, #passkey-unlock, [data-code-expired]').count(), 0);
  }

  // Real card builders and the production cascade under every existing palette.
  await page.evaluate(() => { fixture.app.leaveSpace = entryRepair.leave; });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const theme of ['blue', 'green', 'purple', 'apricot']) {
      await page.evaluate(async ({ scheme, theme }) => {
        document.documentElement.dataset.colorScheme = scheme; document.documentElement.dataset.theme = theme;
        const root = document.querySelector('#app');
        root.innerHTML = '<section class="room-creation-page is-ready"><span class="room-creation-check"><svg viewBox="0 0 24 24"><path d="m4 12 5 5 11-11" stroke="currentColor"/></svg></span></section><section class="is-settings-subpage"><header class="space-drawer-header"><h2>在线状态样式</h2></header><button aria-checked="true"><i class="space-radio"><svg/></i></button></section><section class="device-management-page"><div class="device-section"></div></section>';
        const host = root.querySelector('.device-section');
        for (let i = 0; i < 3; i++) {
          const card = fixture.app.deviceCard({ ...fixture.session.vault.members[0], deviceId: `card-${i}`, deviceName: i ? '合成设备'.repeat(8) : 'iPhone', createdAt: new Date().toISOString() }, i === 0);
          card.classList.add('device-list-row'); card.insertAdjacentHTML('beforeend', '<span class="device-chevron">›</span>'); host.append(card);
        }
      }, { scheme, theme });
      const styles = await page.evaluate(() => {
        const token = value => { const probe = document.createElement('i'); probe.style.color = `var(${value})`; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; };
        const ink = token('--action-ink');
        return { check: getComputedStyle(document.querySelector('.room-creation-check')).color === ink,
          radio: getComputedStyle(document.querySelector('.space-radio')).color === ink,
          title: getComputedStyle(document.querySelector('.space-drawer-header h2')).color === token('--ink'),
          rows: [...document.querySelectorAll('.device-card')].every(card => {
            const [icon, copy, arrow] = card.children, a = icon.getBoundingClientRect(), b = copy.getBoundingClientRect(), c = arrow.getBoundingClientRect(), r = card.getBoundingClientRect();
            return a.right <= b.left && b.right <= c.left + 1 && c.right <= r.right && getComputedStyle(card).boxSizing === 'border-box';
          }) };
      });
      assert.deepEqual(styles, { check: true, radio: true, title: true, rows: true }, `${scheme}/${theme}`);
    }
  }
  for (const width of [320, 390, 1350]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => {
      fixture.app.renderJoiningChat('正在连接已有设备，请保持原浏览器联网并解锁。');
      document.querySelector('.room-connection-content').insertAdjacentHTML('beforeend', '<button class="secondary-button">立即检查</button><button class="text-button">锁定</button>');
    });
    assert.equal(await page.locator('[data-joining-card]').evaluate(card => {
      const r = card.getBoundingClientRect(), content = card.firstElementChild;
      return r.width <= 420 && r.left >= 0 && r.right <= innerWidth && getComputedStyle(content, '::before').content === 'none';
    }), true, `Connection card fits ${width}px without a side stripe`);
    if (process.argv[2]) {
      await mkdir(process.argv[2], { recursive: true });
      await page.screenshot({ path: `${process.argv[2]}/connection-card-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Entry repair passed: post-proof failure/retry, repeated cover holds, late-proof rejection, exact queued room switches, themed checks/heading/device rows and bounded connection cards.');
} finally { await fixture.close(); }
