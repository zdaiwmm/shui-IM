import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { startServer } from '../server/index.mjs';

const gestureA = [0, 1, 4, 7, 8, 5];
const gestureB = [2, 1, 4, 7, 6, 3];
const visualQaDirectory = process.argv[2];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function beginSyntheticFilePicker(input) {
  await input.evaluate((element) => {
    element.addEventListener('click', (event) => event.preventDefault(), { capture: true, once: true });
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function holdCover(page) {
  const box = await page.locator('.cover-trigger').boundingBox();
  invariant(box, 'Privacy-curtain trigger is missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1100);
  await page.mouse.up();
}

async function pointCenters(page, pattern) {
  const centers = [];
  for (const point of pattern) {
    const box = await page.locator(`.gesture-point[data-point="${point}"]`).boundingBox();
    invariant(box, `Gesture point ${point} is missing`);
    centers.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  return centers;
}

async function drawMouse(page, pattern) {
  const points = await pointCenters(page, pattern);
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 3 });
  await page.mouse.up();
}

async function drawTouch(page, pattern) {
  const points = await pointCenters(page, pattern);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...points[0], id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  });
  for (const point of points.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...point, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function setGesture(page, pattern, touch = false) {
  const draw = touch ? drawTouch : drawMouse;
  await draw(page, pattern);
  await draw(page, pattern);
  await page.locator('[data-device-verify]').click();
}

async function unlock(page, pattern) {
  await holdCover(page);
  await page.locator('.gesture-pad').waitFor();
  await drawMouse(page, pattern);
}

async function enableDeviceVault(page, backupEligible = false) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
      defaultBackupEligibility: backupEligible,
      defaultBackupState: backupEligible,
    },
  });
}

const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-browser-'));
const backend = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
const vite = await createViteServer({
  configFile: false,
  root: path.resolve(import.meta.dirname, '..'),
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 0,
    proxy: {
      '/api': `http://127.0.0.1:${backend.port}`,
      '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true },
    },
  },
});

let browser;
try {
  await vite.listen();
  const address = vite.httpServer.address();
  invariant(address && typeof address === 'object', 'Vite did not bind a test port');
  const baseUrl = `http://localhost:${address.port}/`;
  browser = await chromium.launch(
    process.env.CHROME_PATH
      ? { headless: true, executablePath: process.env.CHROME_PATH }
      : process.env.CI
        ? { headless: true }
        : { headless: true, channel: 'chrome' },
  );

  const creatorContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const joinerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();
  await Promise.all([enableDeviceVault(creator), enableDeviceVault(joiner, true)]);

  await creator.goto(baseUrl);
  await holdCover(creator);
  await creator.locator('#create-room').click();
  const setupLayout = await creator.evaluate(() => {
    const gateway = document.querySelector('.gateway-gesture');
    if (!gateway) return null;
    const visibleChildren = [...gateway.children]
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.height > 0);
    const contentTop = Math.min(...visibleChildren.map((rect) => rect.top));
    const contentBottom = Math.max(...visibleChildren.map((rect) => rect.bottom));
    const pad = gateway.querySelector('.gesture-pad')?.getBoundingClientRect();
    const liveSegment = gateway.querySelector('.gesture-trace line');
    return {
      pageOverflow: document.documentElement.scrollHeight > innerHeight,
      contentOverflow: contentTop < 0 || contentBottom > innerHeight,
      balanceDelta: Math.abs(contentTop - (innerHeight - contentBottom)),
      horizontalCenterDelta: pad ? Math.abs((pad.left + pad.right) / 2 - innerWidth / 2) : Number.POSITIVE_INFINITY,
      liveSegmentHidden: liveSegment?.getAttribute('visibility') === 'hidden',
    };
  });
  invariant(setupLayout && !setupLayout.pageOverflow && !setupLayout.contentOverflow, 'Gesture setup does not fit in one mobile viewport');
  invariant(setupLayout.balanceDelta < 32, 'Gesture setup is not vertically centered');
  invariant(setupLayout.horizontalCenterDelta < 1, 'Gesture pad is not horizontally centered');
  invariant(setupLayout.liveSegmentHidden, 'Gesture trace rendered a stray point before interaction');
  invariant(await creator.locator('.gesture-actions').count() === 0, 'Gesture screen still shows redundant clear/complete actions');
  await creator.evaluate(() => {
    const originalCreate = navigator.credentials.create.bind(navigator.credentials);
    let failOnce = true;
    Object.defineProperty(navigator.credentials, 'create', {
      configurable: true,
      value: (options) => {
        window.dispatchEvent(new Event('blur'));
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new DOMException('simulated cancellation', 'NotAllowedError'));
        }
        return originalCreate(options);
      },
    });
  });
  await drawMouse(creator, gestureA);
  await drawMouse(creator, gestureA);
  await creator.locator('[data-device-verify]').click();
  await creator.getByText('操作未完成，可以直接重试。', { exact: true }).waitFor();
  invariant(await creator.locator('.cover-trigger').count() === 0, 'Passkey prompt blur unexpectedly activated the privacy curtain');
  invariant(await creator.locator('.gesture-host').isHidden(), 'A cancelled passkey prompt forced the gesture to be redrawn');
  await creator.locator('[data-device-verify]').click();
  await creator.locator('.pairing-screen').waitFor({ timeout: 15_000 }).catch(async (error) => {
    const visibleError = await creator.locator('.form-error').textContent().catch(() => '');
    throw new Error(`Creator setup did not finish: ${visibleError || await creator.locator('body').innerText()}`, { cause: error });
  });
  const invite = await creator.locator('#invite-url').inputValue();

  await joiner.goto(invite);
  await holdCover(joiner);
  await setGesture(joiner, gestureB);
  await Promise.all([
    creator.locator('.chat-shell').waitFor({ timeout: 15_000 }),
    joiner.locator('.chat-shell').waitFor({ timeout: 15_000 }),
  ]).catch(async (error) => {
    throw new Error(`Pairing did not finish. Creator: ${await creator.locator('body').innerText()} Joiner: ${await joiner.locator('body').innerText()}`, { cause: error });
  });
  const joinerUsesSyncablePasskey = await joiner.evaluate(async () => {
    const { readStoredVault } = await import('/src/lib/vault.ts');
    const stored = await readStoredVault();
    return stored?.v === 2 && stored.platform.backupEligible;
  });
  invariant(joinerUsesSyncablePasskey === true, 'A Chrome-style syncable passkey was not accepted');
  invariant(await creator.locator('#open-gallery').count() === 1, 'Creator cannot see the gallery entry');
  invariant(await joiner.locator('#open-gallery').count() === 0, 'Invited member can see the creator-only gallery entry');
  invariant(await creator.locator('#gallery-count').count() === 0, 'Gallery entry still renders a numeric badge');
  await creator.waitForTimeout(280);
  const composerLayout = await creator.evaluate(() => {
    const composer = document.querySelector('.composer')?.getBoundingClientRect();
    const input = document.querySelector('#message-input')?.getBoundingClientRect();
    return {
      composerVisible: Boolean(composer && composer.height >= 44 && composer.bottom <= innerHeight + 1),
      inputVisible: Boolean(input && input.width > 0 && input.height >= 42 && input.bottom <= innerHeight + 1),
      composer: composer ? { top: composer.top, bottom: composer.bottom, width: composer.width, height: composer.height } : null,
      input: input ? { top: input.top, bottom: input.bottom, width: input.width, height: input.height } : null,
      innerHeight,
      chromeColor: document.querySelector('#system-chrome-color')?.getAttribute('content'),
    };
  });
  invariant(composerLayout.composerVisible && composerLayout.inputVisible, `Bottom chat composer is clipped or missing: ${JSON.stringify(composerLayout)}`);
  invariant(Boolean(composerLayout.chromeColor), 'System browser chrome color is not synchronized');
  const keyboardViewportLayout = await creator.evaluate(async () => {
    document.documentElement.style.setProperty('--app-top', '40px');
    document.documentElement.style.setProperty('--app-height', '460px');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const app = document.querySelector('#app')?.getBoundingClientRect();
    const composer = document.querySelector('.composer')?.getBoundingClientRect();
    const input = document.querySelector('#message-input')?.getBoundingClientRect();
    const result = {
      appBottom: app?.bottom,
      composerBottom: composer?.bottom,
      inputBottom: input?.bottom,
      composerHeight: composer?.height,
    };
    document.documentElement.style.setProperty('--app-top', '0px');
    document.documentElement.style.setProperty('--app-height', `${innerHeight}px`);
    return result;
  });
  invariant(
    Math.abs((keyboardViewportLayout.composerBottom ?? 0) - 500) < 1
      && (keyboardViewportLayout.inputBottom ?? 501) <= 500
      && (keyboardViewportLayout.composerHeight ?? 0) >= 44,
    `Composer did not follow the simulated iOS keyboard viewport: ${JSON.stringify(keyboardViewportLayout)}`,
  );
  await creator.locator('.more-menu summary').click();
  await creator.locator('.message-list').click({ position: { x: 8, y: 8 } });
  await creator.waitForTimeout(180);
  invariant(!await creator.locator('.more-menu').evaluate((menu) => menu.hasAttribute('open')), 'Safety menu did not dismiss after an outside click');

  const startedAt = Date.now();
  await creator.locator('#message-input').fill('browser-e2e-live');
  await creator.locator('.send-button').click();
  invariant(await creator.evaluate(() => document.activeElement?.id === 'message-input'), 'Send button dismissed the composer keyboard focus');
  await joiner.getByText('browser-e2e-live', { exact: true }).waitFor({ timeout: 3000 });
  await creator.getByText(/对端已安全接收/).waitFor({ timeout: 3000 });
  const deliveryMs = Date.now() - startedAt;
  invariant(deliveryMs < 3000, 'Local real-time delivery exceeded the acceptance budget');

  await creator.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  await creator.locator('.cover-trigger').waitFor();
  invariant(await creator.getByText('browser-e2e-live', { exact: true }).count() === 0, 'Blur left plaintext visible');
  await creator.waitForTimeout(200);
  invariant(await creator.locator('.cover-trigger').count() === 1, 'Focus restored the session without authentication');
  await holdCover(creator);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await drawMouse(creator, [0, 1, 2, 5]);
    await creator.getByText('请重新绘制手势。', { exact: true }).waitFor({ timeout: 10_000 });
  }
  await drawMouse(creator, gestureA);
  await creator.getByText(/尝试次数过多/).waitFor({ timeout: 3000 });
  await creator.waitForTimeout(1100);
  await drawMouse(creator, gestureA);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });

  await creator.locator('#message-input').fill('browser-e2e-outbox');
  await creator.locator('#composer').evaluate((form) => form.requestSubmit());
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  await unlock(creator, gestureA);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });
  await joiner.getByText('browser-e2e-outbox', { exact: true }).waitFor({ timeout: 5000 });
  invariant(await joiner.getByText('browser-e2e-outbox', { exact: true }).count() === 1, 'Outbox replay duplicated a message');

  const image = {
    name: 'picker.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#0a84ff"/><circle cx="160" cy="120" r="54" fill="#ffffff"/></svg>'),
  };
  await creator.locator('#message-input').focus();
  await creator.locator('#image-input').evaluate((element) => {
    element.addEventListener('click', (event) => event.preventDefault(), { capture: true, once: true });
  });
  await creator.locator('#open-image-picker').click();
  invariant(await creator.evaluate(() => document.activeElement?.id === 'message-input'), 'Gallery button dismissed the composer keyboard focus');
  const retainedFocusImageIndex = await creator.locator('.message.outgoing .image-preview').count();
  await creator.locator('#image-input').setInputFiles({ ...image, name: 'keyboard-retained.svg' });
  await creator.locator('.message.outgoing .image-preview').nth(retainedFocusImageIndex).waitFor({ timeout: 10_000 });
  invariant(await creator.evaluate(() => document.activeElement?.id === 'message-input'), 'Selecting an image dismissed the composer keyboard focus');
  await creator.locator('#emoji-button').click();
  await creator.locator('.emoji-picker.is-visible').waitFor();
  await creator.waitForTimeout(240);
  if (visualQaDirectory) await creator.screenshot({ path: path.join(visualQaDirectory, 'emoji-mobile.png') });
  await creator.locator('[data-emoji]').first().click();
  invariant(await creator.locator('#message-input').inputValue() === '😄', 'Emoji picker did not insert the selected emoji');
  invariant(await creator.evaluate(() => document.activeElement?.id === 'message-input'), 'Emoji selection dismissed the composer keyboard focus');
  await creator.locator('#message-input').fill('');
  await creator.locator('#emoji-button').click();
  const detachedInput = await creator.locator('#image-input').elementHandle();
  invariant(detachedInput, 'Image input is missing');
  const directImageCreatorIndex = await creator.locator('.message.outgoing .image-preview').count();
  const directImageJoinerIndex = await joiner.locator('.message.incoming .image-preview').count();
  await beginSyntheticFilePicker(detachedInput);
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  invariant(await creator.locator('.chat-shell').count() === 1, 'Image picker blur unexpectedly activated the privacy curtain');
  invariant(await creator.locator('.cover-trigger').count() === 0, 'Image picker blur covered the chat');
  await detachedInput.setInputFiles(image);
  await Promise.all([
    creator.locator('.message.outgoing .image-preview').nth(directImageCreatorIndex).waitFor({ timeout: 10_000 }),
    joiner.locator('.message.incoming .image-preview').nth(directImageJoinerIndex).waitFor({ timeout: 10_000 }),
  ]);

  const imageCount = await joiner.locator('.message.incoming .image-preview').count();
  const creatorChatImageCount = await creator.locator('.message.outgoing .image-preview').count();
  await creator.locator('#open-gallery').click();
  await creator.locator('.gallery-shell').waitFor();
  const galleryInput = await creator.locator('#gallery-image-input').elementHandle();
  invariant(galleryInput, 'Gallery upload input is missing');
  await beginSyntheticFilePicker(galleryInput);
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  invariant(await creator.locator('.gallery-shell').count() === 1, 'Gallery image picker blur unexpectedly activated the privacy curtain');
  await creator.route('**/chunks/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue().catch(() => undefined);
  });
  await galleryInput.setInputFiles({ ...image, name: 'gallery-only.svg' });
  await creator.locator('.gallery-upload-progress').waitFor({ state: 'visible' });
  invariant(await creator.locator('.cover-trigger').count() === 0, 'Gallery upload activated the privacy curtain');
  const galleryOnlyTile = creator.locator('button[aria-label="查看原图 gallery-only.svg"]');
  await galleryOnlyTile.waitFor({ timeout: 10_000 });
  await galleryOnlyTile.locator('img').waitFor({ timeout: 10_000 });
  invariant(await galleryOnlyTile.getAttribute('data-thumbnail-state') === 'loaded', 'Visible gallery thumbnail did not decrypt and render');
  await galleryOnlyTile.click();
  await creator.locator('.detail-stage img').waitFor({ timeout: 10_000 });
  await creator.locator('#detail-back').click();
  await creator.locator('.gallery-shell').waitFor();
  await creator.locator('.gallery-tile img').first().waitFor({ timeout: 10_000 });
  await creator.waitForTimeout(280);
  await creator.unroute('**/chunks/**');
  if (visualQaDirectory) {
    await mkdir(visualQaDirectory, { recursive: true });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'gallery-mobile.png') });
    await creator.setViewportSize({ width: 1200, height: 900 });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'gallery-desktop.png') });
    await creator.setViewportSize({ width: 390, height: 844 });
  }
  await creator.locator('#gallery-back').click();
  await creator.locator('.chat-shell').waitFor();
  await creator.waitForTimeout(280);
  if (visualQaDirectory) {
    await creator.screenshot({ path: path.join(visualQaDirectory, 'chat-mobile.png') });
    await creator.setViewportSize({ width: 1200, height: 900 });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'chat-desktop.png') });
    await creator.setViewportSize({ width: 390, height: 844 });
  }
  invariant(
    await creator.locator('.message.outgoing .image-preview').count() === creatorChatImageCount,
    'A gallery-only upload leaked into the creator chat stream',
  );
  await joiner.waitForTimeout(500);
  invariant(
    await joiner.locator('.message.incoming .image-preview').count() === imageCount,
    'A gallery-only upload leaked into the invited member chat stream',
  );

  const cancelledInput = await creator.locator('#image-input').elementHandle();
  await beginSyntheticFilePicker(cancelledInput);
  await cancelledInput.evaluate((input) => input.dispatchEvent(new Event('cancel')));
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  await creator.locator('.cover-trigger').waitFor();
  await unlock(creator, gestureA);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });

  const discardedInput = await creator.locator('#image-input').elementHandle();
  await beginSyntheticFilePicker(discardedInput);
  await creator.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await creator.locator('.cover-trigger').waitFor();
  await unlock(creator, gestureA);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });
  await creator.waitForTimeout(800);
  invariant(await joiner.locator('.message.incoming .image-preview').count() === imageCount, 'pagehide bypassed the privacy curtain exception');

  const resumableImage = { name: 'resume.png', mimeType: 'image/png', buffer: Buffer.alloc(2_300_000, 73) };
  await creator.route('**/chunks/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue().catch(() => undefined);
  });
  await creator.locator('#image-input').setInputFiles(resumableImage);
  await creator.waitForTimeout(80);
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  await creator.locator('.cover-trigger').waitFor();
  await creator.unroute('**/chunks/**');
  await unlock(creator, gestureA);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });
  await creator.locator('.upload-reminder').waitFor({ timeout: 5000 });
  await creator.locator('#image-input').setInputFiles(resumableImage);
  await joiner.locator('.message.incoming .image-preview').nth(imageCount).waitFor({ timeout: 15_000 });

  await creator.locator('.more-menu summary').click();
  const recoveryUrlBeforeDownload = creator.url();
  const recoveryDownloadPromise = creator.waitForEvent('download');
  await creator.locator('#export-recovery').click();
  const recoveryPath = await (await recoveryDownloadPromise).path();
  invariant(recoveryPath, 'Recovery package download did not produce a file');
  invariant(creator.url() === recoveryUrlBeforeDownload, 'Recovery download navigated away from the app');
  const recoveryCode = await creator.locator('.recovery-code-panel code').textContent();
  invariant(recoveryCode?.startsWith('QR2-'), 'Recovery code was not shown separately from the package');
  await creator.locator('[data-close-code]').click();
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  await creator.locator('.cover-trigger').waitFor();
  const recoveryContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const recovery = await recoveryContext.newPage();
  await enableDeviceVault(recovery);
  await recovery.goto(baseUrl);
  await holdCover(recovery);
  await recovery.locator('#recovery-file').setInputFiles(recoveryPath);
  await recovery.locator('textarea[name="recovery-code"]').fill(recoveryCode);
  await recovery.locator('#recovery-code-form').evaluate((form) => form.requestSubmit());
  await recovery.locator('.gesture-pad').waitFor();
  await setGesture(recovery, gestureA);
  await recovery.locator('.chat-shell').waitFor({ timeout: 15_000 }).catch(async (error) => {
    throw new Error(`Recovery did not reopen: ${await recovery.locator('body').innerText()}`, { cause: error });
  });
  invariant(await recovery.locator('.fatal-screen').count() === 0, 'MLS recovery replayed an unavailable sender ratchet');
  await recovery.locator('#peer-status[data-state="connected"]').waitFor({ timeout: 15_000 });
  await joiner.locator('#message-input').fill('browser-e2e-after-recovery');
  await joiner.locator('#composer').evaluate((form) => form.requestSubmit());
  await recovery.getByText('browser-e2e-after-recovery', { exact: true }).waitFor({ timeout: 5000 });

  const legacyContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const legacy = await legacyContext.newPage();
  await enableDeviceVault(legacy);
  await legacy.goto(baseUrl);
  await legacy.evaluate(async () => {
    const cryptoModule = await import('/src/lib/crypto.ts');
    const apiModule = await import('/src/lib/api.ts');
    const base64Module = await import('/src/lib/base64.ts');
    const vaultModule = await import('/src/lib/vault.ts');
    const identity = await cryptoModule.generateIdentity();
    const legacyPublicBundle = {
      deviceId: identity.publicBundle.deviceId,
      encryptionKey: identity.publicBundle.encryptionKey,
      signingKey: identity.publicBundle.signingKey,
    };
    identity.publicBundle = legacyPublicBundle;
    identity.mlsPrivatePackage = undefined;
    const accessToken = base64Module.randomBase64Url(32);
    const pairingSecret = base64Module.randomBase64Url(32);
    const room = await apiModule.createRoom(legacyPublicBundle, accessToken);
    if (room.protocol !== 'legacy-v1') throw new Error('Legacy migration fixture did not create a legacy room');
    const session = await vaultModule.createVault({
      v: 1,
      roomId: room.roomId,
      accessToken,
      role: 'creator',
      pairingSecret,
      creatorFingerprint: await cryptoModule.bundleFingerprint(legacyPublicBundle),
      identity,
      members: [{ ...identity.publicBundle, role: 'creator', joinProof: null, createdAt: room.createdAt }],
      lastSeq: 0,
      createdAt: room.createdAt,
    }, 'legacy-password-for-migration', 'password');
    await vaultModule.saveHistoryMessage(session, {
      seq: 1,
      clientMsgId: crypto.randomUUID(),
      senderId: identity.publicBundle.deviceId,
      payload: { v: 1, kind: 'text', text: 'legacy-local-history', sentAt: new Date().toISOString() },
      acceptedAt: new Date().toISOString(),
      status: 'stored',
    });
    await vaultModule.saveOutboxItem(session, {
      clientMsgId: crypto.randomUUID(),
      payload: { v: 1, kind: 'text', text: 'legacy-local-outbox', sentAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
    });
  });
  await legacy.reload();
  await holdCover(legacy);
  await legacy.locator('input[name="password"]').fill('legacy-password-for-migration');
  await legacy.locator('#unlock-form').evaluate((form) => form.requestSubmit());
  await legacy.getByText('绑定这台设备').waitFor({ timeout: 15_000 });
  await setGesture(legacy, gestureA);
  await legacy.locator('.pairing-screen').waitFor({ timeout: 15_000 });
  await legacy.evaluate(() => window.dispatchEvent(new Event('blur')));
  await unlock(legacy, gestureA);
  await legacy.locator('.pairing-screen').waitFor({ timeout: 15_000 });
  const migratedLocalData = await legacy.evaluate(async (pattern) => {
    const gestureModule = await import('/src/lib/gesture.ts');
    const vaultModule = await import('/src/lib/vault.ts');
    const stored = await vaultModule.readStoredVault();
    const session = await vaultModule.unlockVault(gestureModule.gestureSecret(pattern));
    return {
      unlockMethod: stored?.unlockMethod,
      history: (await vaultModule.loadHistory(session)).map((message) => message.payload.text),
      outbox: (await vaultModule.loadOutbox(session)).map((item) => item.payload.text),
    };
  }, gestureA);
  invariant(migratedLocalData.unlockMethod === 'platform', 'Legacy vault did not persist the passkey method');
  invariant(migratedLocalData.history.includes('legacy-local-history'), 'Legacy history was not re-encrypted during migration');
  invariant(migratedLocalData.outbox.includes('legacy-local-outbox'), 'Legacy outbox was not re-encrypted during migration');

  const accessibility = await recovery.evaluate(() => {
    const textarea = document.querySelector('#message-input');
    textarea?.focus();
    const shell = document.querySelector('.chat-shell')?.getBoundingClientRect();
    const header = document.querySelector('.chat-header')?.getBoundingClientRect();
    const composer = document.querySelector('.composer')?.getBoundingClientRect();
    const messageList = document.querySelector('.message-list');
    const composerField = document.querySelector('.composer-field');
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    const rootStyle = getComputedStyle(document.documentElement);
    const rgb = (property) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = rootStyle.getPropertyValue(property);
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const luminance = (color) => color
      .map((value) => value / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (left, right) => {
      const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      verticalOverflow: document.documentElement.scrollHeight > innerHeight,
      outline: textarea ? getComputedStyle(textarea).outlineStyle : 'missing',
      outlineColor: textarea ? getComputedStyle(textarea).outlineColor : 'missing',
      composerFieldOutline: composerField ? getComputedStyle(composerField).outlineStyle : 'missing',
      headerOffset: shell && header ? Math.abs(header.top - shell.top) : Number.POSITIVE_INFINITY,
      composerOffset: shell && composer ? Math.abs(composer.bottom - shell.bottom) : Number.POSITIVE_INFINITY,
      messageOverflow: messageList ? getComputedStyle(messageList).overflowY : 'missing',
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
      faintTextContrast: contrast(rgb('--ink-faint'), rgb('--paper-pure')),
      strongLineContrast: contrast(rgb('--line-strong'), rgb('--paper-pure')),
      undersized: [...document.querySelectorAll('button, summary, .image-picker, .gallery-upload-button')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${[...element.classList].map((name) => `.${name}`).join('')}`,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter((item) => item.width > 0 && item.height > 0 && (item.width < 44 || item.height < 44)),
    };
  });
  invariant(!accessibility.overflow, 'Mobile layout has horizontal overflow');
  invariant(!accessibility.verticalOverflow, 'The document scrolls instead of the message region');
  invariant(accessibility.outline !== 'none', 'Composer focus is not visible');
  invariant(accessibility.outlineColor === 'rgba(0, 0, 0, 0)', `Composer textarea retained a colored focus outline: ${accessibility.outlineColor}`);
  invariant(accessibility.composerFieldOutline === 'none', 'Composer field retained the second focus outline');
  invariant(accessibility.headerOffset < 1 && accessibility.composerOffset < 1, 'Chat header or composer is not fixed to the shell');
  invariant(accessibility.messageOverflow === 'auto', 'Messages are not the dedicated vertical scroll region');
  invariant(accessibility.viewport.includes('user-scalable=no') && accessibility.viewport.includes('maximum-scale=1'), 'Browser zoom is not disabled');
  invariant(accessibility.faintTextContrast >= 4.5, `Faint text contrast is ${accessibility.faintTextContrast}`);
  invariant(accessibility.strongLineContrast >= 3, `Control boundary contrast is ${accessibility.strongLineContrast}`);
  invariant(accessibility.undersized.length === 0, `A visible control is smaller than 44 by 44 CSS pixels: ${JSON.stringify(accessibility.undersized)}`);

  await Promise.all([creatorContext.close(), joinerContext.close(), recoveryContext.close(), legacyContext.close()]);
  process.stdout.write(`Browser E2E passed; local signed delivery ${deliveryMs} ms.\n`);
} finally {
  await browser?.close();
  await vite.close();
  await backend.close();
  await rm(dataDir, { recursive: true, force: true });
}
