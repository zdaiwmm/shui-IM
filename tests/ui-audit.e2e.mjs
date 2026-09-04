import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { startServer } from '../server/index.mjs';

const visualQaDirectory = path.resolve(process.argv[2] ?? 'audit/2026-09-04-ui/screenshots');
const evidence = [];
const auditDirectory = path.dirname(visualQaDirectory);
await mkdir(visualQaDirectory, { recursive: true });

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertStablePage(page, label) {
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
      errorGap: error?.textContent?.trim() && errorRect ? errorRect.top - rect.bottom : null,
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

async function holdCover(page) {
  const box = await page.locator('.cover-trigger').boundingBox();
  invariant(box, 'Privacy-curtain trigger is missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1100);
  await page.mouse.up();
}

async function setPasskey(page) {
  await page.locator('[data-device-verify]').click();
}

async function unlock(page, exerciseError = false) {
  await holdCover(page);
  await assertCredentialLayout(page, '#passkey-unlock');
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
    await page.locator('#passkey-unlock').click();
    await page.locator('.form-error:not(:empty)').waitFor();
    await assertCredentialLayout(page, '#passkey-unlock');
    if (visualQaDirectory) await page.screenshot({ path: path.join(visualQaDirectory, 'unlock-error-mobile.png') });
  }
  await page.locator('#passkey-unlock').click();
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
const buildDirectory = path.join(dataDir, 'built-ui');
await build({
  configFile: false,
  root: path.resolve(import.meta.dirname, '..'),
  logLevel: 'error',
  build: { outDir: buildDirectory, target: 'es2022' },
});
const vite = await preview({
  configFile: false,
  root: path.resolve(import.meta.dirname, '..'),
  logLevel: 'error',
  build: { outDir: buildDirectory },
  preview: {
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
  const joinerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();
  await Promise.all([enableDeviceVault(creator), enableDeviceVault(joiner, true)]);
  const variants = {
    mobile: { width: 390, height: 844, scheme: 'light', font: '' },
    small: { width: 320, height: 720, scheme: 'light', font: '' },
    desktop: { width: 1280, height: 900, scheme: 'light', font: '' },
    landscape: { width: 844, height: 390, scheme: 'light', font: '' },
    dark: { width: 390, height: 844, scheme: 'dark', font: '' },
    large: { width: 320, height: 720, scheme: 'light', font: '20px' },
  };
  let step = 0;
  const auditPageErrors = [];
  creator.on('pageerror', error => auditPageErrors.push(error.message));
  await creator.addInitScript(() => {
    window.__auditAnimations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      window.__auditAnimations.push({ target: this.className, keyframes, options, at: performance.now() });
      return animate.call(this, keyframes, options);
    };
  });
  async function variant(name) {
    const value = variants[name];
    await creator.emulateMedia({ colorScheme: value.scheme, reducedMotion: 'no-preference' });
    await creator.setViewportSize({ width: value.width, height: value.height });
    await creator.evaluate(font => document.documentElement.style.fontSize = font, value.font);
    await creator.waitForTimeout(120);
  }
  async function capture(name, settings = ['mobile'], prepare) {
    if (process.argv.includes('--privacy-repro')) return;
    for (const setting of settings) {
      await variant(setting);
      if (prepare) await prepare(setting);
      const filename = `${String(++step).padStart(2, '0')}-${name}-${setting}.png`;
      const result = await creator.evaluate(() => {
        const box = element => {
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
        };
        const selector = element => `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}${typeof element.className === 'string' ? '.' + element.className.trim().replaceAll(' ', '.') : ''}`;
        const visible = element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); };
        const controls = [...document.querySelectorAll('button,summary,input:not([type=file]),textarea,[role=dialog]')].filter(visible).map(element => ({ selector: selector(element), label: element.getAttribute('aria-label') ?? element.textContent?.slice(0, 90), box: box(element), fontSize: getComputedStyle(element).fontSize, disabled: element.hasAttribute('disabled'), inert: Boolean(element.closest('[inert]')) }));
        const layers = [...document.querySelectorAll('.chat-header,.composer,.peer-summary,.menu-panel,.message-actions,.message-action-list,.message-reaction-picker,.message.is-action-source,.message-text-selection,.recovery-reminder,.recovery-code-sheet,.recovery-code-panel,.device-link-sheet,.device-link-panel,.gallery-header,.gallery-tile time,.viewer-stage,.image-viewer')].filter(visible).map(element => { const style = getComputedStyle(element); const before = getComputedStyle(element, '::before'); return { selector: selector(element), box: box(element), color: style.color, background: style.background, backdrop: style.backdropFilter, mask: style.maskImage, pseudoBackground: before.background, pseudoBackdrop: before.backdropFilter, pseudoMask: before.maskImage, overflow: style.overflow, animation: style.animation, transition: style.transition }; });
        const rootStyle = getComputedStyle(document.documentElement);
        const tokens = Object.fromEntries(['--ink','--ink-muted','--ink-faint','--paper','--paper-pure','--glass','--glass-strong','--accent'].map(name => [name, rootStyle.getPropertyValue(name)]));
        const nodes = [...document.querySelectorAll('.gateway-heading h1,.gateway-heading > p:last-child,.credential-only-step,.form-error,.privacy-note,.menu-security,.device-security-note,.device-toolbar,.device-card,.message-text-selection,.recovery-code-actions')].filter(visible).map(element => ({ selector: selector(element), text: (element instanceof HTMLTextAreaElement ? element.value : element.textContent)?.slice(0, 300), box: box(element), font: getComputedStyle(element).fontSize, lineHeight: getComputedStyle(element).lineHeight }));
        return { viewport: { width: innerWidth, height: innerHeight, fontSize: rootStyle.fontSize, dark: matchMedia('(prefers-color-scheme:dark)').matches }, documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, app: box(document.querySelector('#app')), controls, layers, tokens, nodes, animations: window.__auditAnimations ?? [], active: selector(document.activeElement), text: document.body.innerText.slice(0, 3000) };
      });
      await creator.screenshot({ path: path.join(visualQaDirectory, filename) });
      evidence.push({ step, screen: name, setting, filename, capturedAt: new Date().toISOString(), ...result });
      await writeFile(path.join(auditDirectory, 'geometry.json'), JSON.stringify({ startedWithCurrentSource: true, note: 'Fresh local Chromium production build + preview, isolated test-room captures without hot reload. large = 20px root-font stress simulation, not native OS text scaling.', errors: auditPageErrors, screenshots: evidence }, null, 2));
      process.stdout.write(`Captured ${filename}\n`);
    }
    await variant('mobile');
  }
  async function menu() {
    await creator.waitForFunction(() => !document.querySelector('.more-menu')?.classList.contains('is-closing'));
    if (!await creator.locator('.more-menu').evaluate(element => element.open)) await creator.locator('.more-menu summary').click();
    await creator.waitForTimeout(300);
  }
  await creator.goto(baseUrl);
  await holdCover(creator);
  await capture('welcome', ['mobile', 'small', 'landscape', 'large']);
  await creator.locator('#create-room').click();
  await capture('passkey', ['mobile', 'small', 'desktop', 'landscape', 'dark', 'large']);
  await creator.locator('[data-device-verify]').click();
  await creator.locator('.pairing-screen').waitFor({ timeout: 15000 });
  await capture('pairing', ['mobile', 'landscape']);
  const invite = await creator.locator('#invite-url').inputValue();
  await joiner.goto(invite);
  await holdCover(joiner);
  await setPasskey(joiner);
  await creator.locator('.chat-shell').waitFor({ timeout: 15000 });
  await joiner.locator('.chat-shell').waitFor({ timeout: 15000 });
  await creator.locator('#peer-presence[data-state=online]').waitFor();
  if (process.argv.includes('--privacy-repro')) {
    await joiner.locator('#message-input').fill('audit-secret-canary');
    await joiner.locator('#composer').evaluate(form => form.requestSubmit());
    const received = creator.locator('.message.incoming').filter({ hasText: 'audit-secret-canary' });
    await received.waitFor();
    await creator.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => new Promise((resolve, reject) => { window.__rejectAuditCopy = reject; }) });
    });
    await received.dispatchEvent('contextmenu');
    await creator.locator('[data-message-action=copy]').click();
    await creator.waitForFunction(() => typeof window.__rejectAuditCopy === 'function');
    await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
    await creator.locator('.cover-trigger').waitFor();
    const before = await creator.locator('body').innerText();
    await creator.evaluate(() => window.__rejectAuditCopy(new Error('Document is not focused')));
    await creator.waitForTimeout(100);
    const after = await creator.locator('body').innerText();
    const leakedInlineSelection = await creator.locator('.message-text-selection').count();
    const canary = leakedInlineSelection ? await creator.locator('.message-text-selection').first().inputValue() : null;
    await creator.screenshot({ path: path.join(visualQaDirectory, 'clipboard-after-lock.png') });
    await writeFile(path.join(auditDirectory, 'clipboard-privacy.json'), JSON.stringify({ before, after, canary, covered: await creator.locator('.cover-trigger').count(), leakedInlineSelection }, null, 2));
    process.stdout.write(`Clipboard privacy reproduction: ${JSON.stringify({ covered: await creator.locator('.cover-trigger').count(), leakedInlineSelection, canary })}\n`);
    invariant(leakedInlineSelection === 0 && !after.includes('audit-secret-canary'), 'Clipboard fallback revealed message selection after locking');
    throw new Error('AUDIT_REPRO_COMPLETE');
  }
  await capture('chat-empty-pinned', ['mobile', 'small', 'landscape', 'dark']);
  const messages = [
    '周末想一起去海边走走吗？',
    '好呀，我查了一下天气，周六下午很适合出门。',
    '那我们带上相机。路上可以先去买咖啡，然后慢慢走到海边。',
    '时间不用太赶，下午两点出发就好。',
    '顺便把上次的照片带来，我想选几张打印出来。',
    '好的。这个周末就放慢一点，好好休息。',
  ];
  for (let index = 0; index < messages.length; index += 1) {
    const page = index % 2 ? creator : joiner;
    const other = index % 2 ? joiner : creator;
    await page.locator('#message-input').fill(messages[index]);
    await page.locator('#composer').evaluate(form => form.requestSubmit());
    await other.getByText(messages[index], { exact: true }).waitFor({ timeout: 5000 });
  }
  await creator.locator('#image-input').setInputFiles({
    name: '晚霞.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#dac8df"/><circle cx="390" cy="270" r="68" fill="#fff0c7"/><path d="M0 560Q210 340 600 580V900H0Z" fill="#808aaa"/><path d="M0 710Q310 510 600 690V900H0Z" fill="#566d88"/></svg>'),
  });
  await creator.locator('.image-preview img').waitFor({ timeout: 15000 });
  // Distinct light/dark, portrait/landscape fixture images exercise album and
  // gallery crops, timestamp contrast, and the header overlay on actual media.
  const fixtures = [
    { name: '海岸.svg', width: 900, height: 600, sky: '#bad9ea', ground: '#397999', rise: 390 },
    { name: '夜色.svg', width: 600, height: 900, sky: '#12213b', ground: '#30473c', rise: 570 },
    { name: '日光.svg', width: 900, height: 900, sky: '#f6deac', ground: '#b6b66b', rise: 540 },
  ].map(({ name, width, height, sky, ground, rise }) => ({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${sky}"/><circle cx="${width * .72}" cy="${height * .26}" r="${width * .09}" fill="#fff1be"/><path d="M0 ${rise} Q${width * .4} ${rise - 130} ${width} ${rise + 20} V${height} H0Z" fill="${ground}"/></svg>`) }));
  await creator.locator('#image-input').setInputFiles(fixtures);
  await creator.locator('.image-preview img').nth(3).waitFor({ timeout: 15000 });
  await creator.locator('#message-list').evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 160));
  await capture('chat-messages', ['mobile', 'small', 'desktop', 'landscape', 'dark', 'large']);
  await menu();
  await capture('chat-menu', ['mobile', 'small', 'landscape', 'dark', 'large']);
  await creator.locator('#export-recovery').click();
  await creator.locator('.recovery-code-panel').waitFor();
  await capture('recovery', ['mobile', 'small', 'landscape', 'dark', 'large']);
  await creator.locator('[data-cancel-code]').click();
  await creator.keyboard.press('Escape');
  await creator.waitForTimeout(300);
  const source = creator.locator('.message.incoming').filter({ hasText: messages[4] });
  await source.scrollIntoViewIfNeeded();
  await source.dispatchEvent('contextmenu');
  await creator.locator('.message-actions.is-visible').waitFor();
  await capture('message-menu', ['mobile', 'small', 'landscape']);
  // Re-enter native inline selection after each viewport/font change so the
  // selected textarea uses the paragraph's metrics for that exact variant.
  await capture('select-text-inline', ['mobile', 'small', 'landscape', 'dark', 'large'], async (setting) => {
    await creator.keyboard.press('Escape');
    await source.scrollIntoViewIfNeeded();
    await source.dispatchEvent('contextmenu');
    await creator.locator('.message-actions.is-visible').waitFor();
    const before = await source.locator('.message-text').boundingBox();
    await creator.getByRole('menuitem', { name: '选择文字', exact: true }).click();
    const selection = creator.locator('.message.is-selecting-text .message-bubble > .message-text-selection');
    await selection.waitFor();
    const after = await selection.boundingBox();
    const state = await selection.evaluate(element => ({
      value: element.value,
      readOnly: element.readOnly,
      selected: element.selectionEnd - element.selectionStart,
      focused: document.activeElement === element,
    }));
    invariant(state.value === messages[4] && state.readOnly && state.selected === state.value.length && state.focused,
      `${setting} did not select the original message inline: ${JSON.stringify(state)}`);
    invariant(before && after && ['x', 'y', 'width', 'height'].every(axis => Math.abs(before[axis] - after[axis]) < 1),
      `${setting} inline selection shifted the message text: ${JSON.stringify({ before, after })}`);
    invariant(await creator.locator('[role=dialog], .message-actions, .message-actions-backdrop').count() === 0,
      `${setting} inline selection left an app dialog or message menu open`);
  });
  await creator.keyboard.press('Escape');
  await creator.locator('.message-text-selection').waitFor({ state: 'detached' });
  await menu();
  await creator.locator('#manage-devices').click();
  await creator.locator('.device-card').first().waitFor();
  await capture('devices', ['mobile', 'small', 'landscape', 'dark', 'large']);
  await creator.getByRole('button', { name: '添加设备', exact: true }).click();
  await creator.locator('.device-link-panel').waitFor();
  await capture('device-link', ['mobile', 'small', 'landscape', 'dark', 'large']);
  await creator.locator('.device-link-sheet [data-close]').click();
  await creator.locator('#device-back').click();
  await creator.locator('#open-gallery').click();
  await creator.locator('.gallery-tile img').first().waitFor();
  await capture('gallery', ['mobile', 'small', 'desktop', 'landscape', 'dark', 'large']);
  await creator.locator('.gallery-tile').first().click();
  await creator.locator('.image-viewer.is-visible .viewer-stage img').waitFor();
  await creator.locator('.image-viewer').evaluate(async viewer => {
    await viewer.querySelector('img').decode();
    // Reveal installs the thumbnail animation on load or requestAnimationFrame;
    // allow it to attach before asking for running CSS/Web Animations.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(viewer.getAnimations({ subtree: true }).map(animation => animation.finished));
  });
  await capture('viewer', ['mobile', 'small', 'landscape', 'dark']);
  await creator.locator('[data-viewer-close]').click();
  await creator.locator('.image-viewer').waitFor({ state: 'detached' });
  await creator.locator('#gallery-back').click();
  await creator.evaluate(() => window.dispatchEvent(new Event('blur')));
  await holdCover(creator);
  await capture('unlock', ['mobile', 'small', 'landscape', 'large']);
  process.stdout.write(`UI audit finished: ${evidence.length} screenshots; ${auditPageErrors.length} browser errors.\n`);
} catch (error) {
  if (error.message !== 'AUDIT_REPRO_COMPLETE') throw error;
} finally {
  await browser?.close();
  await vite.close();
  await backend.close();
  await rm(dataDir, { recursive: true, force: true });
}
