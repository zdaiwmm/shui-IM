import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { verifyVoiceFlow } from './voice-flow.e2e.mjs';
import { verifyCallFlow } from './call-flow.e2e.mjs';

const visualQaDirectory = process.argv[2];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertStablePage(page, label) {
  // Measure the arriving page, including its opacity animation, rather than
  // retaining the outgoing DOM during the navigation's short fade-out.
  await page.waitForFunction(() => document.querySelector('#app')?.dataset.pageTransition !== 'leaving');
  const samples = await page.locator('#app > section').evaluate(async (section) => {
    const values = [];
    const chat = section.classList.contains('chat-shell');
    const anchor = chat ? [...section.querySelectorAll('.message')].find(row => row.getBoundingClientRect().bottom > (visualViewport?.offsetTop ?? 0))?.dataset.clientMsgId : null;
    const start = performance.now();
    do {
      // Document height may change as offscreen media decodes. Measure the
      // fixed controls and the visible reading anchor, not the moving document.
      const bounds = (chat ? section.querySelector('.chat-header') : section).getBoundingClientRect();
      const sample = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      if (chat) {
        const composer = section.querySelector('#composer').getBoundingClientRect();
        sample.composerY = composer.y; sample.composerHeight = composer.height;
        if (anchor) sample.anchorY = section.querySelector(`[data-client-msg-id="${CSS.escape(anchor)}"]`).getBoundingClientRect().top;
      }
      values.push(sample);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    } while (performance.now() - start < 580);
    return values;
  });
  for (const axis of Object.keys(samples[0])) {
    const values = samples.map((sample) => sample[axis]);
    invariant(Math.max(...values) - Math.min(...values) < (axis === 'anchorY' ? 3 : 1), `${label} shifted on ${axis} during entry: ${JSON.stringify(samples)}`);
  }
}

async function assertCredentialLayout(page, buttonSelector) {
  const layout = await page.locator(buttonSelector).evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const error = document.querySelector('.form-error');
    const errorRect = error?.getBoundingClientRect();
    const intro = document.querySelector('.credential-only-step .field-hint')
      ?? document.querySelector('.gateway-heading > p:last-child');
    const introRect = intro?.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      horizontalOverflow: rect.left < 0 || rect.right > innerWidth,
      hintGap: introRect ? rect.top - introRect.bottom : null,
      errorGap: error?.textContent?.trim() && errorRect ? Math.max(errorRect.top - rect.bottom, rect.top - errorRect.bottom) : null,
    };
  });
  invariant(layout.height >= 44 && layout.width >= 180 && !layout.horizontalOverflow, `Passkey button is clipped or undersized: ${JSON.stringify(layout)}`);
  invariant(layout.hintGap === null || layout.hintGap >= 12, `Passkey hint overlaps the button: ${JSON.stringify(layout)}`);
  invariant(layout.errorGap === null || layout.errorGap >= 8, `Passkey error overlaps the button: ${JSON.stringify(layout)}`);
}

async function beginSyntheticFilePicker(input) {
  await input.evaluate((element) => {
    element.addEventListener('click', (event) => event.preventDefault(), { capture: true, once: true });
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function blurOutsidePage(page) {
  await page.evaluate(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    try {
      window.dispatchEvent(new Event('blur'));
      await new Promise((resolve) => setTimeout(resolve, 320));
    } finally {
      if (descriptor) Object.defineProperty(document, 'hasFocus', descriptor);
      else delete document.hasFocus;
    }
  });
  await page.locator('.cover-trigger').waitFor();
}

async function holdCover(page) {
  const box = await page.locator('.cover-trigger').boundingBox();
  invariant(box, 'Privacy-curtain trigger is missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1100);
  await page.mouse.up();
  // Pointer entry includes the deliberate 180 ms completion ring. Wait for
  // the cover to be replaced before measuring the arrived page.
  await page.locator('.cover-trigger').waitFor({ state: 'detached' });
}

async function setPasskey(page) {
  await page.locator('[data-device-verify]').click();
}

async function unlock(page, exerciseError = false) {
  if (exerciseError) {
    await page.evaluate(() => {
      const get = navigator.credentials.get.bind(navigator.credentials);
      let rejectOnce = true;
      Object.defineProperty(navigator.credentials, 'get', {
        configurable: true,
        value: (options) => {
          if (rejectOnce) {
            rejectOnce = false;
            return Promise.reject(new DOMException('simulated cancellation', 'NotAllowedError'));
          }
          return get(options);
        },
      });
    });
  }
  await holdCover(page);
  if (exerciseError) {
    await page.locator('.form-error:not(:empty)').waitFor();
    await assertCredentialLayout(page, '#passkey-unlock');
    if (visualQaDirectory) await page.screenshot({ path: path.join(visualQaDirectory, 'unlock-error-mobile.png') });
    await page.locator('#passkey-unlock').click();
  }
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
      ? { headless: true, executablePath: process.env.CHROME_PATH, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
      : process.env.CI
        ? { headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
        : { headless: true, channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  );

  const creatorContext = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const joinerContext = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 }, hasTouch: true });
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();
  await Promise.all([enableDeviceVault(creator), enableDeviceVault(joiner, true)]);

  await creator.goto(baseUrl);
  await holdCover(creator);
  await assertStablePage(creator, 'Welcome page');
  await creator.locator('#create-room').click();
  await assertStablePage(creator, 'Passkey setup page');
  await assertCredentialLayout(creator, '[data-device-verify]');
  if (visualQaDirectory) {
    await mkdir(visualQaDirectory, { recursive: true });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'passkey-mobile.png') });
    await creator.setViewportSize({ width: 320, height: 720 });
    await assertCredentialLayout(creator, '[data-device-verify]');
    await creator.screenshot({ path: path.join(visualQaDirectory, 'passkey-small-mobile.png') });
    await creator.setViewportSize({ width: 1280, height: 900 });
    await assertCredentialLayout(creator, '[data-device-verify]');
    await creator.screenshot({ path: path.join(visualQaDirectory, 'passkey-desktop.png') });
    await creator.setViewportSize({ width: 390, height: 844 });
  }
  invariant(await creator.locator('.gesture-pad').count() === 0, 'A new vault still asks for a gesture');
  await creator.evaluate(() => {
    const originalCreate = navigator.credentials.create.bind(navigator.credentials);
    let failOnce = true;
    Object.defineProperty(navigator.credentials, 'create', {
      configurable: true,
      value: async (options) => {
        window.dispatchEvent(new Event('blur'));
        try {
          if (failOnce) {
            failOnce = false;
            throw new DOMException('simulated cancellation', 'NotAllowedError');
          }
          return await originalCreate(options);
        } finally { window.dispatchEvent(new Event('focus')); }
      },
    });
  });
  await creator.locator('[data-device-verify]').click();
  await creator.locator('.form-error:not(:empty)').waitFor();
  await assertCredentialLayout(creator, '[data-device-verify]');
  invariant(await creator.locator('.cover-trigger').count() === 0, 'Passkey prompt blur unexpectedly activated the privacy curtain');
  await creator.locator('[data-device-verify]').click();
  await creator.locator('.pairing-screen').waitFor({ timeout: 15_000 }).catch(async (error) => {
    const visibleError = await creator.locator('.form-error').textContent().catch(() => '');
    throw new Error(`Creator setup did not finish: ${visibleError || await creator.locator('body').innerText()}`, { cause: error });
  });
  const invite = await creator.locator('#invite-url').inputValue();
  await assertStablePage(creator, 'Pairing page');

  await joiner.goto(invite);
  await holdCover(joiner);
  await setPasskey(joiner);
  await Promise.all([
    creator.locator('.chat-shell').waitFor({ timeout: 15_000 }),
    joiner.locator('.chat-shell').waitFor({ timeout: 15_000 }),
  ]).catch(async (error) => {
    throw new Error(`Pairing did not finish. Creator: ${await creator.locator('body').innerText()} Joiner: ${await joiner.locator('body').innerText()}`, { cause: error });
  });
  const joinerUsesSyncablePasskey = await joiner.evaluate(async () => {
    const { readStoredVault } = await import('/src/lib/vault.ts');
    const stored = await readStoredVault();
    return stored?.v === 3 && stored.platform.backupEligible;
  });
  invariant(joinerUsesSyncablePasskey === true, 'A Chrome-style syncable passkey was not accepted');
  invariant(await creator.locator('#open-gallery').count() === 1, 'Creator cannot see the gallery entry');
  invariant(await joiner.locator('#open-gallery').count() === 0, 'Invited member can see the creator-only gallery entry');
  invariant(await creator.locator('#gallery-count').count() === 0, 'Gallery entry still renders a numeric badge');
  invariant(await creator.locator('#emoji-button, .emoji-picker, [data-expression-tab], .favorite-expression').count() === 0, 'Removed expression or favorites controls are still available');
  await assertStablePage(creator, 'Chat page');
  await Promise.all([
    creator.locator('#self-presence strong').filter({ hasText: /^在线$/ }).waitFor({ timeout: 5000 }),
    creator.locator('.peer-status').filter({ hasText: /^在线$/ }).waitFor({ timeout: 5000 }),
    joiner.locator('#self-presence strong').filter({ hasText: /^在线$/ }).waitFor({ timeout: 5000 }),
    joiner.locator('.peer-status').filter({ hasText: /^在线$/ }).waitFor({ timeout: 5000 }),
  ]);
  const presenceLayout = await creator.evaluate(() => {
    const header = document.querySelector('.chat-header').getBoundingClientRect();
    const self = document.querySelector('#self-presence').getBoundingClientRect();
    const peer = document.querySelector('#peer-presence').getBoundingClientRect();
    const summary = document.querySelector('.peer-summary').getBoundingClientRect();
    const safe = document.querySelector('#open-gallery').getBoundingClientRect();
    const more = document.querySelector('.more-menu > summary').getBoundingClientRect();
    return { selfRight: self.right, peerLeft: peer.left, peerCenter: (summary.left + summary.right) / 2, headerCenter: (header.left + header.right) / 2,
      summaryHeight: summary.height, actionHeight: safe.height, actionGap: more.left - safe.right, statusGap: safe.left - summary.right };
  });
  invariant(presenceLayout.selfRight <= presenceLayout.peerLeft + 1, `Self presence is not on the left: ${JSON.stringify(presenceLayout)}`);
  invariant(Math.abs(presenceLayout.peerCenter - presenceLayout.headerCenter) <= 3, `Combined presence is not centered: ${JSON.stringify(presenceLayout)}`);
  invariant(Math.abs(presenceLayout.summaryHeight - presenceLayout.actionHeight) < 1 && presenceLayout.actionGap >= 8 && presenceLayout.statusGap >= 6,
    `Header status crowds the actions or has a different height: ${JSON.stringify(presenceLayout)}`);
  invariant(await creator.locator('#dismiss-recovery svg').evaluate((icon) => getComputedStyle(icon).stroke !== 'none'), 'Pinned recovery reminder close icon is invisible');
  if (visualQaDirectory) await creator.screenshot({ path: path.join(visualQaDirectory, 'recovery-pinned-mobile.png') });
  await creator.locator('#dismiss-recovery').click();
  await creator.locator('.recovery-reminder').waitFor({ state: 'detached' });
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
    const viewport = window.visualViewport;
    const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 40 });
    Object.defineProperty(viewport, 'height', { configurable: true, value: 460 });
    try {
      viewport.dispatchEvent(new Event('resize'));
      await settle();
      const composer = document.querySelector('.composer')?.getBoundingClientRect();
      const input = document.querySelector('#message-input')?.getBoundingClientRect();
      return { composerBottom: composer?.bottom, inputBottom: input?.bottom, composerHeight: composer?.height };
    } finally {
      delete viewport.offsetTop; delete viewport.height;
      viewport.dispatchEvent(new Event('resize'));
      await settle();
    }
  });
  invariant(
    Math.abs((keyboardViewportLayout.composerBottom ?? 0) - 500) < 1
      && (keyboardViewportLayout.inputBottom ?? 501) <= 500
      && (keyboardViewportLayout.composerHeight ?? 0) >= 44,
    `Composer did not follow the simulated iOS keyboard viewport: ${JSON.stringify(keyboardViewportLayout)}`,
  );
  await creator.locator('.more-menu summary').click();
  await creator.locator('.message-list').click({ position: { x: 8, y: 8 } });
  await creator.waitForTimeout(280);
  invariant(!await creator.locator('.more-menu').evaluate((menu) => menu.hasAttribute('open')), 'Safety menu did not dismiss after an outside click');

  const startedAt = Date.now();
  await creator.locator('#message-input').fill('browser-e2e-live');
  await creator.locator('.send-button').click();
  invariant(await creator.evaluate(() => document.activeElement?.id === 'message-input'), 'Send button dismissed the composer keyboard focus');
  await joiner.getByText('browser-e2e-live', { exact: true }).waitFor({ timeout: 3000 });
  await creator.locator('.message.outgoing.is-delivered').filter({ hasText: 'browser-e2e-live' }).waitFor({ timeout: 3000 });
  const deliveryMs = Date.now() - startedAt;
  invariant(deliveryMs < 3000, 'Local real-time delivery exceeded the acceptance budget');

  const replySourceId = await joiner.locator('.message.incoming').filter({ hasText: 'browser-e2e-live' }).getAttribute('data-client-msg-id');
  const replySource = joiner.locator(`.message.incoming[data-client-msg-id="${replySourceId}"]`);
  const messageSelection = await replySource.evaluate((article) => ({
    userSelect: getComputedStyle(article).userSelect,
    callout: getComputedStyle(article).getPropertyValue('-webkit-touch-callout'),
  }));
  invariant(messageSelection.userSelect === 'none', 'Message text still allows the native long-press selection gesture');
  await replySource.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, clientX: 40, clientY: 180 });
  await joiner.waitForTimeout(220);
  invariant(await joiner.locator('.message-actions').count() === 0, 'Message actions opened before the long-press threshold');
  await joiner.waitForTimeout(320);
  invariant(await joiner.locator('.message-reaction-picker button[data-reaction]').count() === 6, 'Long press did not expose the six quick message reactions');
  invariant(await joiner.locator('.message-action-list [data-message-action]').count() === 3, 'Incoming text action menu is missing copy, select, or reply');
  const actionGeometry = await joiner.locator('.message-action-list, .message-reaction-picker').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }));
  invariant(actionGeometry.every(rect => rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= rect.viewportWidth && rect.bottom <= rect.viewportHeight), `Long-press actions extend outside the mobile viewport: ${JSON.stringify(actionGeometry)}`);
  await joiner.getByRole('menuitem', { name: '选择文字', exact: true }).click();
  const copyText = replySource.locator('textarea.message-text.message-text-selection[aria-label="选择消息文字"]');
  await copyText.waitFor();
  invariant(await joiner.locator('.message-copy-sheet, .message-actions').count() === 0, 'Selecting message text opened a popup instead of using its original bubble');
  invariant(await copyText.inputValue() === 'browser-e2e-live', 'Inline selection did not expose the correct message');
  invariant(await copyText.evaluate(textarea => textarea.readOnly && textarea.inputMode === 'none' && document.activeElement === textarea && textarea.selectionStart === 0 && textarea.selectionEnd === textarea.value.length), 'Inline message text was not immediately ready for native selection');
  await copyText.evaluate((textarea) => {
    textarea.focus();
    textarea.setSelectionRange(8, 11);
  });
  await joiner.waitForTimeout(60);
  invariant(await copyText.evaluate(textarea => textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)) === 'e2e', 'Native selection did not retain exactly the highlighted range');
  await joiner.keyboard.press('Escape');
  await copyText.waitFor({ state: 'detached' });
  invariant(await replySource.locator('p.message-text').textContent() === 'browser-e2e-live', 'Closing native selection changed the message text');

  const creatorSource = creator.locator('.message.outgoing').filter({ hasText: 'browser-e2e-live' });
  const initialMessageCounts = await Promise.all([creator, joiner].map(page => page.locator('.message').count()));
  const openReactionMenu = async () => {
    await joiner.locator('.message-actions').waitFor({ state: 'detached' });
    await replySource.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, clientX: 40, clientY: 180 });
    await joiner.locator('.message-reaction-picker').waitFor();
  };
  await openReactionMenu();
  await joiner.locator('.message-reaction-picker [data-reaction="❤️"]').click();
  await Promise.all([creatorSource, replySource].map(source => source.locator('.message-reaction').filter({ hasText: '❤️' }).waitFor({ timeout: 5000 })));
  invariant(await creatorSource.locator('.message-reaction').getAttribute('data-own') === 'false', 'Received reaction was attributed to the wrong participant');
  invariant(await replySource.locator('.message-reaction').getAttribute('data-own') === 'true', 'Local reaction was attributed to the wrong participant');
  await replySource.locator('.message-reaction').click();
  const selectedHeart = joiner.locator('.message-reaction-picker [data-reaction="❤️"]');
  invariant(await selectedHeart.getAttribute('aria-pressed') === 'true' && (await selectedHeart.getAttribute('aria-label')).includes('取消'), 'Existing reaction is not exposed as a cancellation action');
  await selectedHeart.click();
  await Promise.all([creatorSource, replySource].map(source => source.locator('.message-reaction').waitFor({ state: 'detached', timeout: 5000 })));
  await openReactionMenu();
  await joiner.locator('.message-reaction-picker [data-reaction="👍"]').click();
  await Promise.all([creatorSource, replySource].map(source => source.locator('.message-reaction').filter({ hasText: '👍' }).waitFor({ timeout: 5000 })));
  const finalMessageCounts = await Promise.all([creator, joiner].map(page => page.locator('.message').count()));
  invariant(JSON.stringify(finalMessageCounts) === JSON.stringify(initialMessageCounts), 'Reaction events appeared as extra chat messages');

  await replySource.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, clientX: 40, clientY: 180 });
  await joiner.waitForTimeout(520);
  await joiner.getByRole('menuitem', { name: '回复' }).click();
  await joiner.locator('#reply-draft').waitFor({ state: 'visible' });
  await joiner.locator('#message-input').fill('browser-e2e-reply');
  await joiner.locator('#composer').evaluate((form) => form.requestSubmit());
  const receivedReply = creator.locator('.message.incoming').filter({ hasText: 'browser-e2e-reply' });
  await receivedReply.waitFor({ timeout: 5000 });
  invariant(await receivedReply.locator('.message-reply-quote').textContent().then((value) => value?.includes('browser-e2e-live')), 'Encrypted reply did not retain its local quote');
  await Promise.all([creator, joiner].map((page, side) => page.evaluate((side) => {
    const input = document.querySelector('#message-input');
    const form = document.querySelector('#composer');
    for (let index = 0; index < 10; index++) {
      input.value = `browser-e2e-concurrent-${side}-${index}`;
      form.requestSubmit();
    }
  }, side)));
  for (const page of [creator, joiner]) {
    for (let side = 0; side < 2; side++) for (let index = 0; index < 10; index++) {
      await page.getByText(`browser-e2e-concurrent-${side}-${index}`, { exact: true }).waitFor({ timeout: 10_000 });
    }
    invariant(await page.locator('.fatal-screen').count() === 0, 'Concurrent send/receive lost an MLS ratchet');
  }

  await creator.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await creator.locator('.cover-trigger').waitFor();
  invariant(await creator.getByText('browser-e2e-live', { exact: true }).count() === 0, 'Blur left plaintext visible');
  await creator.waitForTimeout(200);
  invariant(await creator.locator('.cover-trigger').count() === 1, 'Focus restored the session without authentication');
  await unlock(creator, true);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });
  invariant(await creator.locator('.recovery-reminder').count() === 0, 'Dismissed recovery reminder returned after unlocking');
  await creatorSource.locator('.message-reaction').filter({ hasText: '👍' }).waitFor({ timeout: 5000 });
  invariant(await creatorSource.locator('.message-reaction').count() === 1, 'Restoring the encrypted session lost, duplicated, or resurrected a removed reaction');

  await creator.locator('#message-input').fill('browser-e2e-outbox');
  await creator.locator('#composer').evaluate((form) => form.requestSubmit());
  await blurOutsidePage(creator);
  await unlock(creator);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });
  await joiner.getByText('browser-e2e-outbox', { exact: true }).waitFor({ timeout: 5000 });
  invariant(await joiner.getByText('browser-e2e-outbox', { exact: true }).count() === 1, 'Outbox replay duplicated a message');

  await verifyVoiceFlow({ creator, joiner, unlock, visualQaDirectory });
  await verifyCallFlow({ creator, joiner, unlock, visualQaDirectory });

  const image = {
    name: 'picker.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#0a84ff"/><circle cx="160" cy="120" r="54" fill="#ffffff"/></svg>'),
  };
  // Exercise a paste payload through real MLS encryption, blob storage and
  // peer decryption. The existing draft must survive an image-only send.
  const pastedIndex = await joiner.locator('.message.incoming .image-preview').count();
  await creator.locator('#message-input').fill('图片粘贴时保留的草稿');
  await creator.locator('#message-input').evaluate((input, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'clipboard-original.svg', { type: 'image/svg+xml' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...image.buffer]);
  const pastedImage = joiner.locator('.message.incoming .image-preview').nth(pastedIndex).locator('img');
  await pastedImage.waitFor({ timeout: 10_000 });
  const pastedBytes = await pastedImage.evaluate(async img => [...new Uint8Array(await (await fetch(img.src)).arrayBuffer())]);
  invariant(Buffer.from(pastedBytes).equals(image.buffer), 'Clipboard image changed during encryption, transfer or decryption');
  invariant(await creator.locator('#message-input').inputValue() === '图片粘贴时保留的草稿', 'Image paste erased an unsent text draft');
  await creator.locator('#message-input').fill('');
  await creator.bringToFront();
  await creator.locator('#message-input').focus();
  await creator.locator('#image-input').evaluate((element) => {
    element.addEventListener('click', (event) => event.preventDefault(), { capture: true, once: true });
  });
  await creator.locator('#open-image-picker').click();
  invariant(await creator.evaluate(() => document.activeElement?.id === 'message-input'), 'Gallery button dismissed the composer keyboard focus');
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  invariant(await creator.locator('.chat-shell').count() === 1 && !await creator.evaluate(() => document.documentElement.classList.contains('privacy-obscured')), 'Owned foreground picker blur covered the conversation');
  await creator.evaluate(() => window.dispatchEvent(new Event('focus')));
  const retainedFocusImageIndex = await creator.locator('.message.outgoing .image-preview').count();
  await creator.locator('#image-input').setInputFiles({ ...image, name: 'keyboard-retained.svg' });
  await creator.locator('.message.outgoing .image-preview').nth(retainedFocusImageIndex).locator('img').waitFor({ timeout: 10_000 });
  invariant(await creator.evaluate(() => document.activeElement?.id === 'message-input'), 'Selecting an image dismissed the composer keyboard focus');
  await creator.locator('.message-list').click({ position: { x: 8, y: 8 } });
  invariant(await creator.evaluate(() => document.activeElement?.id !== 'message-input'), 'Tapping outside the composer did not dismiss keyboard focus');
  invariant(await creator.locator('#emoji-button, .emoji-picker, [data-expression-tab], .favorite-expression').count() === 0, 'Removed expression controls reappeared after unlocking');
  const detachedInput = await creator.locator('#image-input').elementHandle();
  invariant(detachedInput, 'Image input is missing');
  const directImageCreatorIndex = await creator.locator('.message.outgoing .image-preview').count();
  const directImageJoinerIndex = await joiner.locator('.message.incoming .image-preview').count();
  await beginSyntheticFilePicker(detachedInput);
  await creator.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
  });
  await creator.locator('.cover-trigger').waitFor();
  invariant(await creator.locator('.chat-shell').count() === 0, 'A second browser departure during image selection left the chat exposed');
  await detachedInput.setInputFiles(image);
  await creator.evaluate(() => window.dispatchEvent(new Event('focus')));
  await creator.waitForTimeout(100);
  invariant(await creator.locator('.cover-trigger').count() === 1, 'Selecting an image reopened chat before authentication');
  invariant(await joiner.locator('.message.incoming .image-preview').count() === directImageJoinerIndex, 'A pending image was sent before authentication');
  await unlock(creator);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });
  await Promise.all([
    creator.locator('.message.outgoing .image-preview').nth(directImageCreatorIndex).locator('img').waitFor({ timeout: 10_000 }),
    joiner.locator('.message.incoming .image-preview').nth(directImageJoinerIndex).locator('img').waitFor({ timeout: 10_000 }),
  ]);
  const directImagePreview = creator.locator('.message.outgoing .image-preview').nth(directImageCreatorIndex);
  invariant(await directImagePreview.getAttribute('data-revealed') === 'false', 'A newly sent chat photo is visible before its first tap');
  await directImagePreview.click();
  invariant(await directImagePreview.getAttribute('data-revealed') === 'true', 'The first chat photo tap did not reveal its thumbnail');
  invariant(await creator.locator('.image-viewer').count() === 0, 'The first chat photo tap opened the viewer');
  await directImagePreview.click();
  await creator.locator('.image-viewer.is-visible .viewer-stage img').waitFor({ timeout: 10_000 });
  await creator.locator('.viewer-stage img').evaluate(async (image) => {
    await Promise.all(image.getAnimations().map((animation) => animation.finished));
  });
  const viewerLayout = await creator.locator('.viewer-stage').evaluate((stage) => {
    const rect = stage.getBoundingClientRect();
    const image = stage.querySelector('img');
    const imageRect = image.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, imageWidth: imageRect.width, imageHeight: imageRect.height, fit: getComputedStyle(image).objectFit, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  invariant(viewerLayout.x === 0 && viewerLayout.y === 0 && Math.abs(viewerLayout.width - viewerLayout.viewportWidth) <= 1 && Math.abs(viewerLayout.height - viewerLayout.viewportHeight) <= 1, `Photo stage does not fill the screen: ${JSON.stringify(viewerLayout)}`);
  invariant(viewerLayout.fit === 'contain' && Math.abs(viewerLayout.imageWidth - viewerLayout.width) <= 1 && Math.abs(viewerLayout.imageHeight - viewerLayout.height) <= 1, `Photo does not fit the full-screen stage: ${JSON.stringify(viewerLayout)}`);
  if (visualQaDirectory) await creator.screenshot({ path: path.join(visualQaDirectory, 'viewer-mobile.png') });
  const dragStage = creator.locator('.viewer-stage');
  await dragStage.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 4, button: 0, clientX: 195, clientY: 350 });
  await dragStage.dispatchEvent('pointermove', { pointerType: 'touch', isPrimary: true, pointerId: 4, clientX: 210, clientY: 500 });
  const dragState = await creator.locator('.image-viewer').evaluate((viewer) => ({ dragging: viewer.classList.contains('is-dragging'), transform: viewer.querySelector('.viewer-stage img').style.transform }));
  invariant(dragState.dragging && dragState.transform.includes('translate3d') && !dragState.transform.includes('scale('), `Photo did not follow the dismiss drag at a stable size: ${JSON.stringify(dragState)}`);
  await dragStage.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, pointerId: 4, button: 0, clientX: 210, clientY: 500 });
  await creator.locator('.image-viewer').waitFor({ state: 'detached' });
  invariant(await directImagePreview.getAttribute('data-revealed') === 'false', 'Dismissing the photo with a downward drag left its chat thumbnail revealed');

  const albumCreatorMessagesBefore = await creator.locator('.message.outgoing').count();
  const albumJoinerMessagesBefore = await joiner.locator('.message.incoming').count();
  await creator.locator('#image-input').setInputFiles([
    { ...image, name: 'album-one.svg' },
    { ...image, name: 'album-two.svg' },
    { ...image, name: 'album-three.svg' },
  ]);
  const creatorAlbum = creator.locator('.message.outgoing .image-album').last();
  const joinerAlbum = joiner.locator('.message.incoming .image-album').last();
  await Promise.all([
    creatorAlbum.locator('.album-cell[data-image-state="loaded"]').nth(2).waitFor({ state: 'attached', timeout: 15_000 }),
    joinerAlbum.locator('.album-cell[data-image-state="loaded"]').nth(2).waitFor({ state: 'attached', timeout: 15_000 }),
  ]);
  const albumLayout = await creatorAlbum.locator('.album-cell').evaluateAll((cells) => cells.map((cell) => {
    const bounds = cell.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, display: getComputedStyle(cell).display };
  }));
  invariant(albumLayout.every(({ width, height, display }) => width > 0 && height > 0 && display !== 'none'), `Album cells are not all visible: ${JSON.stringify(albumLayout)}`);
  invariant(await creator.locator('.message.outgoing').count() === albumCreatorMessagesBefore + 1, 'Multi-image selection was split into more than one outgoing message');
  invariant(await joiner.locator('.message.incoming').count() === albumJoinerMessagesBefore + 1, 'Multi-image selection was split for the receiver');
  invariant(await creatorAlbum.locator('.album-cell').count() === 3, 'Three selected images did not render as one three-cell album');
  invariant(await creatorAlbum.locator('.album-cell').evaluateAll(cells => cells.every(cell => cell.dataset.revealed === 'false')), 'A new chat album contains a revealed thumbnail');
  await creatorAlbum.locator('.album-cell').nth(1).click();
  invariant(await creator.locator('.image-viewer').count() === 0, 'The first album cell tap opened the viewer');
  await creatorAlbum.locator('.album-cell').nth(1).click();
  await creator.locator('[data-viewer-counter]').getByText('2 / 3', { exact: true }).waitFor();
  const viewerStage = creator.locator('.viewer-stage');
  await viewerStage.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, button: 0, clientX: 300, clientY: 400 });
  await viewerStage.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 400 });
  await creator.locator('[data-viewer-counter]').getByText('3 / 3', { exact: true }).waitFor();
  await creator.locator('[data-viewer-close]').click();
  await creator.locator('.image-viewer').waitFor({ state: 'detached' });

  const largeSelection = Array.from({ length: 12 }, (_, index) => ({ ...image, name: `large-selection-${index + 1}.svg` }));
  const largeCreatorMessagesBefore = await creator.locator('.message.outgoing').count();
  const largeJoinerMessagesBefore = await joiner.locator('.message.incoming').count();
  await creator.locator('#image-input').setInputFiles(largeSelection);
  for (const [page, direction, previousCount] of [
    [creator, 'outgoing', largeCreatorMessagesBefore],
    [joiner, 'incoming', largeJoinerMessagesBefore],
  ]) {
    await page.waitForFunction(({ direction, previousCount }) =>
      document.querySelectorAll(`.message.${direction}`).length === previousCount + 2,
    { direction, previousCount }, { timeout: 15_000 });
    const sentNames = [];
    for (const [offset, count] of [9, 3].entries()) {
      const batch = page.locator(`.message.${direction}`).nth(previousCount + offset);
      await batch.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await batch.locator('.album-cell[data-image-state="loaded"]').nth(count - 1).waitFor({ state: 'attached', timeout: 15_000 });
      sentNames.push(...await batch.locator('.album-cell img').evaluateAll(images => images.map(image => image.alt)));
    }
    invariant(JSON.stringify(sentNames) === JSON.stringify(largeSelection.map(file => file.name)), `More than nine selected images were lost or reordered: ${JSON.stringify(sentNames)}`);
    const batchSizes = await page.locator(`.message.${direction}`).evaluateAll((messages, previousCount) =>
      messages.slice(previousCount).map((message) => message.querySelectorAll('.album-cell').length), previousCount);
    invariant(JSON.stringify(batchSizes) === JSON.stringify([9, 3]), `Twelve selected images were not sent in supported album batches: ${JSON.stringify(batchSizes)}`);
  }

  const imageCount = await joiner.locator('.message.incoming .image-preview').count();
  const creatorChatImageCount = await creator.locator('.message.outgoing .image-preview').count();
  const chatAnchorBeforeGallery = await creator.locator('#message-list').evaluate((list) => {
    // This is a deliberate history-reading gesture, not a native focus scroll
    // racing the just-completed send. Cancel bottom follow before positioning.
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
    window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 160);
    const listTop = window.visualViewport?.offsetTop ?? 0;
    const visible = [...list.querySelectorAll('.message[data-client-msg-id]')]
      .find((message) => message.getBoundingClientRect().bottom > listTop);
    return {
      id: visible?.getAttribute('data-client-msg-id') ?? '',
      offset: visible ? visible.getBoundingClientRect().top - listTop : 0,
    };
  });
  await creator.locator('#open-gallery').click();
  await creator.locator('.gallery-shell').waitFor();
  await assertStablePage(creator, 'Gallery page');
  invariant(await creator.locator('#gallery-tab-images').getAttribute('aria-selected') === 'true', 'Gallery does not default to its images tab');
  invariant(await creator.locator('.gallery-file:visible').count() === 0, 'Gallery files are visible in the default images tab');
  await joiner.locator('#peer-presence[data-state="offline"]').waitFor({ timeout: 5000 });
  invariant(/刚刚|前/.test(await joiner.locator('.peer-status').textContent()), 'Offline peer does not show time since last online');
  const galleryInput = await creator.locator('#gallery-image-input').elementHandle();
  invariant(galleryInput, 'Gallery upload input is missing');
  invariant(await galleryInput.evaluate((input) => input.multiple), 'Gallery upload does not permit multiple selection');
  await beginSyntheticFilePicker(galleryInput);
  await creator.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
  });
  await creator.locator('.cover-trigger').waitFor();
  invariant(await creator.locator('.gallery-shell').count() === 0, 'A second browser departure during gallery selection left private photos exposed');
  let galleryUploadRequests = 0;
  await creator.route('**/chunks/**', async (route) => {
    if (route.request().method() === 'PUT') galleryUploadRequests++;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue().catch(() => undefined);
  });
  await galleryInput.setInputFiles([
    { ...image, name: 'gallery-only.svg' },
    { ...image, name: 'gallery-second.svg' },
  ]);
  await creator.evaluate(() => window.dispatchEvent(new Event('focus')));
  await creator.waitForTimeout(100);
  invariant(await creator.locator('.cover-trigger').count() === 1, 'Gallery selection reopened private photos before authentication');
  invariant(galleryUploadRequests === 0, 'Gallery images uploaded before authentication');
  await unlock(creator);
  await creator.locator('.gallery-shell').waitFor({ timeout: 15_000 });
  await creator.locator('.gallery-upload-progress').waitFor({ state: 'visible' });
  invariant(await creator.locator('.cover-trigger').count() === 0, 'Gallery upload activated the privacy curtain');
  const galleryOnlyTile = creator.locator('.gallery-tile').filter({ has: creator.locator('img[alt="gallery-only.svg"]') });
  await galleryOnlyTile.waitFor({ timeout: 10_000 });
  await galleryOnlyTile.locator('img').waitFor({ timeout: 10_000 });
  await creator.locator('.gallery-tile img[alt="gallery-second.svg"]').waitFor({ timeout: 10_000 });
  invariant(await galleryOnlyTile.getAttribute('data-thumbnail-state') === 'loaded', 'Visible gallery thumbnail did not decrypt and render');
  invariant(await galleryOnlyTile.getAttribute('data-revealed') === 'false', 'A new safe upload is visible before an explicit reveal');
  await galleryOnlyTile.click();
  invariant(await creator.locator('.image-viewer').count() === 0, 'The first safe tile tap opened the viewer before revealing its thumbnail');
  await galleryOnlyTile.click();
  await creator.locator('.image-viewer.is-visible .viewer-stage img').waitFor({ timeout: 10_000 });
  await creator.locator('[data-viewer-close]').click();
  await creator.locator('.image-viewer').waitFor({ state: 'detached' });
  await creator.locator('.gallery-tile img').first().waitFor({ timeout: 10_000 });
  await creator.waitForTimeout(420);
  await creator.unroute('**/chunks/**');
  if (visualQaDirectory) {
    await mkdir(visualQaDirectory, { recursive: true });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'gallery-mobile.png') });
    await creator.setViewportSize({ width: 1280, height: 900 });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'gallery-desktop.png') });
    await creator.setViewportSize({ width: 390, height: 844 });
  }
  await creator.locator('#gallery-back').click();
  await creator.locator('.chat-shell').waitFor();
  await assertStablePage(creator, 'Chat return');
  await joiner.locator('.peer-status').filter({ hasText: /^在线$/ }).waitFor({ timeout: 5000 });
  await creator.waitForTimeout(420);
  const chatAnchorAfterGallery = await creator.locator('#message-list').evaluate((list) => {
    const listTop = window.visualViewport?.offsetTop ?? 0;
    const visible = [...list.querySelectorAll('.message[data-client-msg-id]')]
      .find((message) => message.getBoundingClientRect().bottom > listTop);
    return {
      id: visible?.getAttribute('data-client-msg-id') ?? '',
      offset: visible ? visible.getBoundingClientRect().top - listTop : 0,
    };
  });
  invariant(
    chatAnchorAfterGallery.id === chatAnchorBeforeGallery.id && Math.abs(chatAnchorAfterGallery.offset - chatAnchorBeforeGallery.offset) <= 3,
    `Returning from the gallery lost the previous chat position: ${JSON.stringify({ chatAnchorBeforeGallery, chatAnchorAfterGallery })}`,
  );
  if (visualQaDirectory) {
    await creator.screenshot({ path: path.join(visualQaDirectory, 'chat-mobile.png') });
    await creator.setViewportSize({ width: 1280, height: 900 });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'chat-desktop.png') });
    await creator.setViewportSize({ width: 320, height: 720 });
    await creator.screenshot({ path: path.join(visualQaDirectory, 'chat-small-mobile.png') });
    invariant(await creator.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Chat overflows a 320px screen');
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
  await creator.locator('#message-list').evaluate((list) => { window.scrollTo(0, 0); });
  await creator.locator('#message-input').fill(`browser-e2e-scroll-bottom\n${'Latest message must remain visible after an acknowledgement.\n'.repeat(8)}`);
  await creator.locator('#composer').evaluate((form) => form.requestSubmit());
  await joiner.getByText(/browser-e2e-scroll-bottom/).waitFor({ timeout: 5000 });
  await creator.waitForFunction(() => {
    const list = document.querySelector('#message-list');
    return list && document.documentElement.scrollHeight - window.scrollY - window.innerHeight <= 2;
  }, null, { timeout: 5000 });
  await creator.waitForTimeout(250);
  invariant(await creator.locator('#message-list').evaluate((list) => document.documentElement.scrollHeight - window.scrollY - window.innerHeight <= 2), 'An ACK or late image render pulled the sender away from the latest message');
  await creator.locator('.more-menu summary').click();
  await creator.locator('#manage-devices').click();
  await creator.locator('.device-shell').waitFor();
  await assertStablePage(creator, 'Device management');
  if (visualQaDirectory) await creator.screenshot({ path: path.join(visualQaDirectory, 'devices-mobile.png') });
  await creator.locator('#device-back').click();
  await creator.locator('.chat-shell').waitFor();
  await assertStablePage(creator, 'Chat return from devices');

  const cancelledInput = await creator.locator('#image-input').elementHandle();
  await beginSyntheticFilePicker(cancelledInput);
  await cancelledInput.evaluate((input) => input.dispatchEvent(new Event('cancel')));
  await blurOutsidePage(creator);
  await creator.locator('.cover-trigger').waitFor();
  await unlock(creator);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });

  const discardedInput = await creator.locator('#image-input').elementHandle();
  await beginSyntheticFilePicker(discardedInput);
  await creator.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await creator.locator('.cover-trigger').waitFor();
  await unlock(creator);
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
  await blurOutsidePage(creator);
  await creator.locator('.cover-trigger').waitFor();
  await creator.unroute('**/chunks/**');
  await unlock(creator);
  await creator.locator('.chat-shell').waitFor({ timeout: 15_000 });
  await creator.locator('.upload-reminder').waitFor({ timeout: 5000 });
  await creator.locator('#image-input').setInputFiles(resumableImage);
  await joiner.locator('.message.incoming .image-preview').nth(imageCount).waitFor({ timeout: 15_000 });

  // Files use the same real MLS, authenticated blob storage and peer download
  // path as images, while gallery-only files remain absent from both chats.
  const documentFile = {
    name: '双端原文验证.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nQuiet Room encrypted file transfer\n%%EOF\n'),
  };
  invariant(!await creator.locator('#image-input').getAttribute('accept'), 'Chat file picker still filters out documents');
  await creator.waitForFunction(() => !document.querySelector('#image-input')?.disabled);
  await creator.locator('#image-input').setInputFiles(documentFile);
  const peerDocument = joiner.locator('.message.incoming .file-attachment').filter({ hasText: documentFile.name });
  await peerDocument.waitFor({ timeout: 15_000 });
  await creator.locator('.message.outgoing.is-delivered').filter({ hasText: documentFile.name }).waitFor({ timeout: 15_000 });
  invariant(await peerDocument.locator('.file-attachment-meta').textContent(), 'Received document has no file metadata');
  const peerFileDownloadPromise = joiner.waitForEvent('download');
  await peerDocument.click();
  const peerFileDownload = await peerFileDownloadPromise;
  invariant(peerFileDownload.suggestedFilename() === documentFile.name, 'Peer download changed the original filename');
  const peerFileStream = await peerFileDownload.createReadStream();
  invariant(peerFileStream, 'Peer document download has no readable stream');
  const peerFileParts = [];
  for await (const chunk of peerFileStream) peerFileParts.push(chunk);
  invariant(Buffer.concat(peerFileParts).equals(documentFile.buffer), 'Document bytes changed during encryption, transfer or peer decryption');

  const creatorFileCount = await creator.locator('.message .file-attachment').count();
  const peerFileCount = await joiner.locator('.message .file-attachment').count();
  await creator.locator('#open-gallery').click();
  await creator.locator('.gallery-shell').waitFor();
  invariant(await creator.locator('#gallery-tab-images').getAttribute('aria-selected') === 'true', 'Reopening the gallery does not select images');
  invariant(!await creator.locator('#gallery-image-input').getAttribute('accept'), 'Gallery picker still filters out documents');
  await creator.locator('#gallery-image-input').setInputFiles({ ...documentFile, name: '仅相册保存.pdf' });
  await creator.locator('.gallery-file').filter({ hasText: '仅相册保存.pdf' }).waitFor({ timeout: 15_000 });
  invariant(await creator.locator('#gallery-tab-files').getAttribute('aria-selected') === 'true', 'Document upload did not reveal its file result');
  invariant(await creator.locator('.gallery-tile:visible').count() === 0, 'The files tab contains image tiles');
  await creator.locator('#gallery-tab-images').click();
  await creator.locator('.gallery-tile').first().waitFor();
  invariant(await creator.locator('.gallery-file:visible').count() === 0, 'Switching to images left files visible');
  await creator.locator('#gallery-tab-files').click();
  await creator.locator('.gallery-file').filter({ hasText: '仅相册保存.pdf' }).waitFor();
  await creator.waitForFunction(() => !document.querySelector('#gallery-back')?.disabled);
  await creator.locator('#gallery-back').click();
  await creator.locator('.chat-shell').waitFor();
  await creator.locator('#open-gallery').click();
  await creator.locator('.gallery-shell').waitFor();
  invariant(await creator.locator('#gallery-tab-images').getAttribute('aria-selected') === 'true', 'Returning from files to chat then reopening the gallery did not reset to images');
  invariant(await creator.locator('.gallery-file:visible').count() === 0, 'Reopened images tab retained visible files');
  await creator.locator('#gallery-back').click();
  await creator.locator('.chat-shell').waitFor();
  await creator.locator('#message-input').fill('browser-e2e-after-gallery-file');
  await creator.locator('#composer').evaluate(form => form.requestSubmit());
  // The subsequent delivered message is an ordering barrier: the peer has
  // processed the preceding encrypted gallery event before this assertion.
  await joiner.getByText('browser-e2e-after-gallery-file', { exact: true }).waitFor({ timeout: 15_000 });
  invariant(await creator.locator('.message .file-attachment').count() === creatorFileCount, 'Gallery document leaked into creator chat');
  invariant(await joiner.locator('.message .file-attachment').count() === peerFileCount, 'Gallery document leaked into peer chat');
  invariant(await creator.locator('.message').filter({ hasText: '仅相册保存.pdf' }).count() === 0, 'Creator chat exposes the private gallery filename');
  invariant(await joiner.locator('.message').filter({ hasText: '仅相册保存.pdf' }).count() === 0, 'Peer chat exposes the private gallery filename');

  await creator.locator('.more-menu summary').click();
  await creator.locator('#backup-settings').click();
  await creator.locator('#backup-retry').click();
  await creator.waitForFunction(() => document.querySelector('#backup-status')?.textContent?.startsWith('上次备份：'));
  invariant(await creator.locator('#export-recovery').count() === 0, 'Manual recovery export remains exposed');
  await creator.locator('#view-local-recovery').click();
  invariant(await creator.locator('.local-recovery-code').count() === 0, 'Recovery code appeared without fresh passkey verification');
  await creator.locator('#verify-recovery-passkey').click();
  await creator.locator('.local-recovery-code').waitFor();
  const recoveryCode = await creator.locator('.local-recovery-code').textContent();
  invariant(recoveryCode?.startsWith('QR3-'), 'Local recovery code was not displayed after verification');
  const codeIsEncrypted = await creator.evaluate(async code => {
    const { readStoredVault } = await import('/src/lib/vault.ts');
    return !JSON.stringify(await readStoredVault()).includes(code);
  }, recoveryCode);
  invariant(codeIsEncrypted, 'Local durable vault leaked the recovery code');
  if (visualQaDirectory) await creator.screenshot({ path: path.join(visualQaDirectory, 'recovery-code-mobile.png') });
  await creator.locator('#hide-local-recovery').click();
  await creator.locator('#backup-back').click();
  await creator.locator('.chat-shell').waitFor();
  const sourceIdentity = await creator.evaluate(async () => {
    const { unlockVault } = await import('/src/lib/vault.ts');
    return (await unlockVault()).vault.identity.publicBundle.deviceId;
  });
  // The backup is now deliberately older than both sender and receiver state.
  await creator.locator('#message-input').fill('browser-e2e-source-after-checkpoint');
  await creator.locator('#composer').evaluate((form) => form.requestSubmit());
  await joiner.getByText('browser-e2e-source-after-checkpoint', { exact: true }).waitFor({ timeout: 5000 });
  await joiner.locator('#message-input').fill('browser-e2e-peer-after-checkpoint');
  await joiner.locator('#composer').evaluate((form) => form.requestSubmit());
  await creator.getByText('browser-e2e-peer-after-checkpoint', { exact: true }).waitFor({ timeout: 5000 });
  await blurOutsidePage(creator);
  await creator.locator('.cover-trigger').waitFor();
  await blurOutsidePage(joiner);
  await joiner.locator('.cover-trigger').waitFor();
  const recoveryContext = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const recovery = await recoveryContext.newPage();
  await enableDeviceVault(recovery);
  await recovery.goto(baseUrl);
  await holdCover(recovery);
  await recovery.locator('#restore-cloud').click();
  await recovery.locator('#cloud-recovery-form input[name="code"]').fill(recoveryCode);
  await recovery.locator('#cloud-recovery-form').evaluate((form) => form.requestSubmit());
  await recovery.evaluate(() => {
    const create = navigator.credentials.create.bind(navigator.credentials);
    Object.defineProperty(navigator.credentials, 'create', { configurable: true, value: async (options) => {
      window.dispatchEvent(new Event('blur'));
      try { return await create(options); }
      finally { window.dispatchEvent(new Event('focus')); }
    } });
  });
  await setPasskey(recovery);
  await recovery.getByRole('heading', { name: '等待安全恢复' }).waitFor({ timeout: 15_000 });
  invariant(await recovery.locator('#composer').count() === 0, 'An old sender checkpoint became writable before fresh membership authorization');
  await unlock(joiner);
  await joiner.locator('.chat-shell').waitFor({ timeout: 15_000 });
  await recovery.locator('#confirm-new-recovery').waitFor({ timeout: 20_000 }).catch(async error => {
    throw new Error(`Recovery rotation did not finish: ${await recovery.locator('body').innerText()}`, { cause: error });
  });
  const newRecoveryCode = await recovery.locator('.local-recovery-code').textContent();
  invariant(newRecoveryCode?.startsWith('QR3-') && newRecoveryCode !== recoveryCode, 'Recovery did not rotate its code');
  const oldCodeRetired = await recovery.evaluate(async code => {
    const { fetchRecoveryBundle } = await import('/src/lib/cloud-backup.ts');
    try { await fetchRecoveryBundle(code, new AbortController().signal); return false; } catch { return true; }
  }, recoveryCode);
  invariant(oldCodeRetired, 'Old recovery code still retrieves the online backup');
  await recovery.locator('#confirm-new-recovery').click();
  await recovery.locator('.chat-shell').waitFor({ timeout: 15_000 }).catch(async (error) => {
    throw new Error(`Recovery did not reopen: ${await recovery.locator('body').innerText()}`, { cause: error });
  });
  invariant(await recovery.locator('.fatal-screen').count() === 0, 'MLS recovery replayed an unavailable sender ratchet');
  const restoredIdentity = await recovery.evaluate(async () => {
    const { unlockVault } = await import('/src/lib/vault.ts');
    const { vault } = await unlockVault();
    return { id: vault.identity.publicBundle.deviceId, pending: Boolean(vault.pendingRecovery), exportedAt: vault.recoveryExportedAt, boundary: vault.historyUnavailableBeforeSeq };
  });
  invariant(restoredIdentity.id !== sourceIdentity && !restoredIdentity.pending, 'Recovery reused the checkpoint identity or did not finish replacement');
  invariant(restoredIdentity.boundary > 0 && !restoredIdentity.exportedAt, 'Fresh recovery failed to establish a history boundary and require a new backup');
  invariant(await recovery.getByText('browser-e2e-source-after-checkpoint', { exact: true }).count() === 0, 'Recovery claimed unavailable old local history');
  await Promise.all([
    recovery.locator('.peer-summary[data-connection-state="ready"]').waitFor({ timeout: 15_000 }),
    recovery.locator('#self-presence[data-state="online"]').waitFor({ timeout: 15_000 }),
    recovery.locator('#peer-presence[data-state="online"]').waitFor({ timeout: 15_000 }),
  ]);
  await joiner.locator('#message-input').fill('browser-e2e-after-recovery');
  await joiner.locator('#composer').evaluate((form) => form.requestSubmit());
  await recovery.getByText('browser-e2e-after-recovery', { exact: true }).waitFor({ timeout: 5000 });
  await recovery.locator('#message-input').fill('browser-e2e-fresh-identity-send');
  await recovery.locator('#composer').evaluate((form) => form.requestSubmit());
  await joiner.getByText('browser-e2e-fresh-identity-send', { exact: true }).waitFor({ timeout: 5000 });

  await recovery.locator('.more-menu summary').click();
  await recovery.locator('#backup-settings').click();
  await recovery.locator('[data-restore="gallery"]').click();
  await recovery.locator('#history-restore-form input').fill(newRecoveryCode);
  await recovery.locator('#history-restore-form form').evaluate(form => form.requestSubmit());
  await recovery.waitForFunction(() => document.querySelector('#history-restore-form [role=status]')?.textContent?.startsWith('恢复完成'));
  const galleryIsolation = await recovery.evaluate(async () => {
    const v = await import('/src/lib/vault.ts'); const session = await v.unlockVault();
    return { chat: (await v.loadHistory(session)).some(m => m.payload.text === 'browser-e2e-after-gallery-file'),
      gallery: (await v.loadMediaHistoryPage(session)).messages.length };
  });
  invariant(!galleryIsolation.chat && galleryIsolation.gallery > 0, 'Gallery-only recovery exposed old chat or failed to restore media');
  await recovery.locator('[data-restore="chat"]').click();
  await recovery.locator('#history-restore-form input').fill(recoveryCode);
  await recovery.locator('#history-restore-form form').evaluate(form => form.requestSubmit());
  await recovery.getByText(/^请使用本设备当前的恢复码/).waitFor();
  await recovery.locator('#history-restore-form input').fill(newRecoveryCode);
  await recovery.locator('#history-restore-form form').evaluate(form => form.requestSubmit());
  await recovery.waitForFunction(() => document.querySelector('#history-restore-form [role=status]')?.textContent?.startsWith('恢复完成'));
  await recovery.locator('#backup-back').click();
  await recovery.getByText('browser-e2e-after-gallery-file', { exact: true }).waitFor();

  const legacyContext = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
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
  await legacy.evaluate(() => {
    const create = navigator.credentials.create.bind(navigator.credentials);
    Object.defineProperty(navigator.credentials, 'create', { configurable: true, value: async (options) => {
      window.dispatchEvent(new Event('blur'));
      try { return await create(options); }
      finally { window.dispatchEvent(new Event('focus')); }
    } });
  });
  await setPasskey(legacy);
  await legacy.locator('.pairing-screen').waitFor({ timeout: 15_000 });
  await blurOutsidePage(legacy);
  await unlock(legacy);
  await legacy.locator('.pairing-screen').waitFor({ timeout: 15_000 });
  const migratedLocalData = await legacy.evaluate(async () => {
    const vaultModule = await import('/src/lib/vault.ts');
    const stored = await vaultModule.readStoredVault();
    const session = await vaultModule.unlockVault();
    return {
      unlockMethod: stored?.unlockMethod,
      history: (await vaultModule.loadHistory(session)).map((message) => message.payload.text),
      outbox: (await vaultModule.loadOutbox(session)).map((item) => item.payload.text),
    };
  });
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
      headerOffset: header ? Math.abs(header.top - (visualViewport?.offsetTop ?? 0)) : Number.POSITIVE_INFINITY,
      composerOffset: composer ? Math.abs(composer.bottom - ((visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight))) : Number.POSITIVE_INFINITY,
      documentOverflow: getComputedStyle(document.documentElement).overflowY,
      messageOverflow: messageList ? getComputedStyle(messageList).overflowY : 'missing',
      headerBackground: header ? getComputedStyle(document.querySelector('.chat-header')).backgroundColor : 'missing',
      composerBackground: composer ? getComputedStyle(document.querySelector('.composer')).backgroundColor : 'missing',
      headerGradient: getComputedStyle(document.querySelector('.chat-header'), '::before').backgroundImage,
      composerGradient: getComputedStyle(document.querySelector('.composer'), '::before').backgroundImage,
      messageRegion: messageList ? { top: messageList.getBoundingClientRect().top, bottom: messageList.getBoundingClientRect().bottom } : null,
      shellRegion: shell ? { top: shell.top, bottom: shell.bottom } : null,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
      faintTextContrast: contrast(rgb('--ink-faint'), rgb('--paper-pure')),
      strongLineContrast: contrast(rgb('--line-strong'), rgb('--paper-pure')),
      undersized: [...document.querySelectorAll('button, summary, .image-picker, .gallery-upload-button')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${[...element.classList].map((name) => `.${name}`).join('')}`,
            width: rect.width,
            height: rect.height,
            interactive: style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number.parseFloat(style.opacity) > 0
              && style.pointerEvents !== 'none',
          };
        })
        .filter((item) => item.interactive && item.width > 0 && item.height > 0 && (item.width < 44 || item.height < 44)),
    };
  });
  invariant(!accessibility.overflow, 'Mobile layout has horizontal overflow');
  invariant(accessibility.documentOverflow === 'auto', 'The document cannot scroll behind Safari chrome');
  invariant(accessibility.outline !== 'none', 'Composer focus is not visible');
  invariant(accessibility.outlineColor === 'rgba(0, 0, 0, 0)', `Composer textarea retained a colored focus outline: ${accessibility.outlineColor}`);
  invariant(accessibility.composerFieldOutline === 'none', 'Composer field retained the second focus outline');
  invariant(accessibility.headerOffset < 1 && accessibility.composerOffset < 1, 'Chat header or composer is not fixed to the visual viewport');
  invariant(accessibility.messageOverflow === 'visible', 'Messages are clipped in a nested scroll region');
  invariant(accessibility.headerBackground === 'rgba(0, 0, 0, 0)', `Chat header is not transparent: ${accessibility.headerBackground}`);
  invariant(accessibility.composerBackground === 'rgba(0, 0, 0, 0)', `Composer bar is not transparent: ${accessibility.composerBackground}`);
  invariant(accessibility.headerGradient.includes('linear-gradient') && accessibility.composerGradient.includes('linear-gradient'), `Chat bars do not have translucent gradient masks: ${JSON.stringify(accessibility)}`);
  invariant(accessibility.messageRegion && accessibility.shellRegion && Math.abs(accessibility.messageRegion.top - accessibility.shellRegion.top) <= 1 && Math.abs(accessibility.messageRegion.bottom - accessibility.shellRegion.bottom) <= 1, 'Messages do not scroll underneath the top and bottom bars');
  invariant(accessibility.viewport.includes('user-scalable=no') && accessibility.viewport.includes('maximum-scale=1'), 'Browser zoom is not disabled');
  invariant(await creator.evaluate(() => !document.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))), 'Browser double-click zoom event was not prevented');
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
