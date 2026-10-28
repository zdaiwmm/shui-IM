import { cancelPasswordForm } from './helpers/form-input.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Synthetic WebView policy plus ordinary-browser ambiguous-error safeguards. No real WeChat claim.
const evidence = process.argv[2];
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__webview', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>'); });
const cases = [
  ['embedded-negative-prf-with-api', true], ['missing-constructor', true], ['missing-container', true], ['missing-create', true], ['missing-get', true],
  ['negative-prf-capability', true], ['negative-builtin-capability', true], ['not-supported', true],
  ['unknown-cancel', false], ['unknown-abort', false], ['unknown-security', false], ['unknown-transient', false],
  ['unknown-unreadable', false], ['unknown-constraint', false], ['invalid-native-data', false],
  ['insecure-context', false], ['missing-crypto', false], ['missing-storage', false], ['storage-quota', false],
];
let browser; const results = [];
try {
  await server.listen(); if (evidence) await mkdir(evidence, { recursive: true });
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  for (const [name, fallback] of cases) {
    console.log(`WEBVIEW_CASE ${name}`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, userAgent: name.startsWith('unknown-') ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.65' });
    await context.addInitScript(name => {
      if (['missing-constructor', 'insecure-context', 'missing-crypto', 'missing-storage', 'storage-quota'].includes(name)) delete window.PublicKeyCredential;
      if (name === 'missing-container') Object.defineProperty(navigator, 'credentials', { configurable: true, value: undefined });
      if (name === 'missing-create') Object.defineProperty(navigator.credentials, 'create', { configurable: true, value: undefined });
      if (name === 'missing-get') Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: undefined });
      if (window.PublicKeyCredential) Object.defineProperty(PublicKeyCredential, 'getClientCapabilities', { configurable: true, value: async () => ['negative-prf-capability','embedded-negative-prf-with-api'].includes(name) ? { 'extension:prf': false } : name === 'negative-builtin-capability' ? { 'extension:prf':true,userVerifyingPlatformAuthenticator:false } : {} });
      // Control both probes: a real Linux false result would correctly select
      // password before the simulated unknown/cancelled ceremony is reached.
      if (window.PublicKeyCredential) Object.defineProperty(PublicKeyCredential,'isUserVerifyingPlatformAuthenticatorAvailable',{
        configurable:true,value:async()=>{throw Error('Synthetic unknown built-in capability');},
      });
      if (name === 'negative-builtin-capability') Object.defineProperty(navigator.credentials,'create',{configurable:true,value:async()=>{throw Error('Unavailable built-in verifier must choose password before requesting an external key');}});
      if (name === 'not-supported' || name.startsWith('unknown-') || name === 'invalid-native-data') Object.defineProperty(navigator.credentials, 'create', { configurable: true, value: async () => { throw new DOMException('synthetic capability outcome', { 'not-supported': 'NotSupportedError', 'unknown-cancel': 'NotAllowedError', 'unknown-abort': 'AbortError', 'unknown-security': 'SecurityError', 'unknown-transient': 'UnknownError', 'unknown-unreadable':'NotReadableError', 'unknown-constraint':'ConstraintError', 'invalid-native-data':'DataError' }[name]); } });
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
    // Exercise capability selection itself; new-room creation no longer asks for a lock.
    await page.evaluate(()=>app.renderCreateProtection({name:'合成空间',avatar:{v:1,kind:'emoji',emoji:'1f60a',background:0}}));
    await page.locator('[data-device-verify]').waitFor();
    assert.equal(await page.locator('#new-space-name, #profile-done').count(), 0, 'Creation skips profile setup');
    await page.waitForFunction(() => document.querySelector('.password-sheet') || document.querySelector('[data-device-verify]')?.disabled === false);
    if (!await page.locator('.password-sheet').count()) await page.locator('[data-device-verify]').click();
    if (fallback) {
      await page.locator('.password-create .password-form').waitFor();
      assert.equal(await page.locator('.password-form input').count(), 0, 'New numeric setup has no input or show-password control');
      assert.equal(await page.locator('[data-digit]').count(), 10);
      for (const digit of '012') await page.locator(`[data-digit="${digit}"]`).click();
      assert.equal(await page.locator('.numeric-password-dots .filled').count(), 3);
      if (evidence) await page.screenshot({ path: path.join(evidence, `F15-webview-${name}.png`) });
      await cancelPasswordForm(page); await page.locator('.password-sheet').waitFor({ state: 'detached' });
    } else {
      if (name.startsWith('unknown-')) {
        await page.locator('.new-protection-choice').waitFor();
        assert.equal(await page.locator('.password-sheet').count(),0,'Ambiguous failure requires explicit user choice');
        await page.locator('[data-protection-cancel]').click();
      }
      await page.waitForFunction(() => !document.querySelector('[data-device-verify]')?.disabled).catch(async error=>{
        console.error('WEBVIEW_CASE_STATE',name,await page.evaluate(()=>({hidden:document.hidden,focused:document.hasFocus(),covered:window.app?.privacyCovered,
          pending:window.app?.deviceVerificationActive,buttonDisabled:document.querySelector('[data-device-verify]')?.disabled,
          passwordSheet:!!document.querySelector('.password-sheet'),error:document.querySelector('.form-error')?.textContent})));throw error;
      });
      assert.equal(await page.locator('.password-sheet').count(), 0, `${name} incorrectly offered a new password`);
      const environmentErrors = {
        'insecure-context': /浏览器信任的 HTTPS 安全环境.*信任开发证书/,
        'missing-crypto': /无法使用所需的本机加密.*换用支持的浏览器/,
        'missing-storage': /无法保存本机加密数据.*检查存储权限/,
        'storage-quota': /暂时无法保存本机加密数据.*存储权限或可用容量/,
      };
      if (environmentErrors[name]) assert.match(await page.locator('.app-toast[data-tone=error]').textContent(), environmentErrors[name], `${name} needs its actionable environment error`);
      if (evidence) await page.screenshot({ path: path.join(evidence, `F15-webview-${name}.png`) });
    }
    assert.equal(roomWrites, 0, 'No room or wrapper may be created before valid password confirmation');
    assert.deepEqual(errors, [], `${name} emitted a browser exception`);
    results.push({ name, fallback, passed: true }); await context.close();
  }
  if (evidence) await writeFile(path.join(evidence, 'webview-capabilities.json'), JSON.stringify({ engine: 'desktop Chromium', realWeChat: false, results }, null, 2));
  console.log(`PASS ${results.length} WeChat-UA capability, cancellation, environment and storage cases; no room creation or silent downgrade`);
} finally { await browser?.close(); await server.close(); }
