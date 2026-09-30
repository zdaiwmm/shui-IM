import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Explicitly a desktop engine with a WeChat UA and controlled capability evidence.
const evidence = process.argv[2];
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__webview', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>'); });
const cases = [
  ['missing-constructor', true], ['missing-container', true], ['missing-create', true], ['missing-get', true],
  ['negative-prf-capability', true], ['not-supported', true],
  ['unknown-cancel', false], ['unknown-abort', false], ['unknown-security', false], ['unknown-transient', false],
  ['insecure-context', false], ['missing-crypto', false], ['missing-storage', false], ['storage-quota', false],
];
let browser; const results = [];
try {
  await server.listen(); if (evidence) await mkdir(evidence, { recursive: true });
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  for (const [name, fallback] of cases) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.65' });
    await context.addInitScript(name => {
      if (['missing-constructor', 'insecure-context', 'missing-crypto', 'missing-storage', 'storage-quota'].includes(name)) delete window.PublicKeyCredential;
      if (name === 'missing-container') Object.defineProperty(navigator, 'credentials', { configurable: true, value: undefined });
      if (name === 'missing-create') Object.defineProperty(navigator.credentials, 'create', { configurable: true, value: undefined });
      if (name === 'missing-get') Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: undefined });
      if (window.PublicKeyCredential) Object.defineProperty(PublicKeyCredential, 'getClientCapabilities', { configurable: true, value: async () => name === 'negative-prf-capability' ? { 'extension:prf': false } : {} });
      if (name === 'not-supported' || name.startsWith('unknown-')) Object.defineProperty(navigator.credentials, 'create', { configurable: true, value: async () => { throw new DOMException('synthetic capability outcome', { 'not-supported': 'NotSupportedError', 'unknown-cancel': 'NotAllowedError', 'unknown-abort': 'AbortError', 'unknown-security': 'SecurityError', 'unknown-transient': 'UnknownError' }[name]); } });
    }, name);
    const page = await context.newPage(); const errors = []; let roomWrites = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/rooms/.test(request.url())) roomWrites++; });
    await page.goto(`http://localhost:${server.httpServer.address().port}/__webview`);
    await page.evaluate(async () => { await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles(); const { QuietRoomApp } = await import('/src/app.ts'); window.app = new QuietRoomApp(document.querySelector('#app')); await app.start(); });
    await page.evaluate(name => {
      if (name === 'insecure-context') Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
      if (name === 'missing-crypto') Object.defineProperty(window, 'crypto', { configurable: true, value: undefined });
      if (name === 'missing-storage') Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
      if (name === 'storage-quota') { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, key) { if (String(key).startsWith('quiet-room:storage-probe:')) throw new DOMException('synthetic quota', 'QuotaExceededError'); return put.call(this, value, key); }; }
    }, name);
    await page.locator('#create-room').click();
    if (fallback) {
      await page.locator('.password-create .password-form').waitFor();
      assert.equal(await page.locator('[name=password]').getAttribute('autocomplete'), 'new-password');
      assert.match(await page.locator('.password-description').textContent(), /不是手机锁屏密码/);
      await page.locator('[name=password]').fill('synthetic password 123');
      await page.locator('[name=show]').check(); assert.equal(await page.locator('[name=password]').getAttribute('type'), 'text');
      await page.locator('[name=show]').uncheck(); assert.equal(await page.locator('[name=password]').inputValue(), 'synthetic password 123');
      if (evidence) { await page.locator('[name=password]').fill(''); await page.screenshot({ path: path.join(evidence, `F15-webview-${name}.png`) }); }
      await page.locator('[data-password-cancel]').click(); await page.locator('.password-sheet').waitFor({ state: 'detached' });
    } else {
      await page.waitForFunction(() => !document.querySelector('#create-room')?.disabled);
      assert.equal(await page.locator('.password-sheet').count(), 0, `${name} incorrectly offered a new password`);
      if (['insecure-context', 'missing-crypto', 'missing-storage', 'storage-quota'].includes(name)) assert.match(await page.locator('.form-error').textContent(), /安全连接|本机加密|存储权限|容量/, `${name} needs an actionable error`);
      if (evidence) await page.screenshot({ path: path.join(evidence, `F15-webview-${name}.png`) });
    }
    assert.equal(roomWrites, 0, 'No room or wrapper may be created before valid password confirmation');
    assert.deepEqual(errors, [], `${name} emitted a browser exception`);
    results.push({ name, fallback, passed: true }); await context.close();
  }
  if (evidence) await writeFile(path.join(evidence, 'webview-capabilities.json'), JSON.stringify({ engine: 'desktop Chromium', realWeChat: false, results }, null, 2));
  console.log(`PASS ${results.length} WeChat-UA capability, cancellation, environment and storage cases; no room creation or silent downgrade`);
} finally { await browser?.close(); await server.close(); }
