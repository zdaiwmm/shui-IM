import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Capture a real renderer at its tested state. No DOM substitute or new state
 * is constructed here; media, gestures and authorization keep their owners. */
export async function auditP1Surface(page, name, selector = 'body') {
  const directory = process.env.QUIET_ROOM_P1_EVIDENCE;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const viewport = page.viewportSize();
  const original = await page.evaluate(() => {
    return { preference: localStorage.getItem('quiet-room:color-scheme'), dark: matchMedia('(prefers-color-scheme: dark)').matches, fontSize: document.documentElement.style.fontSize };
  });
  const metrics = [];
  try {
    await page.evaluate(() => { localStorage.setItem('quiet-room:color-scheme', 'system'); window.dispatchEvent(new StorageEvent('storage', { key: 'quiet-room:color-scheme' })); });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForTimeout(260);
        await page.locator(selector).first().waitFor({ state: 'visible' });
        await page.waitForFunction(scheme => document.documentElement.dataset.colorScheme === scheme, scheme, {timeout:2000}).catch(async cause => { console.error('P1_SCHEME_DIAGNOSTIC',await page.evaluate(()=>({systemDark:matchMedia('(prefers-color-scheme: dark)').matches,effective:document.documentElement.dataset.colorScheme,preference:localStorage.getItem('quiet-room:color-scheme')})));throw cause; });
        const result = await page.evaluate(selector => {
          const surface = document.querySelector(selector);
          return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
            scheme: document.documentElement.dataset.colorScheme,
            controls: [...surface.querySelectorAll('button')].filter(e => e.getClientRects().length && !e.closest('[hidden]')).map(e => ({
              label: e.getAttribute('aria-label') || e.textContent.trim(), width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height,
            })),
            inputs: [...surface.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea')].filter(e => e.getClientRects().length && !e.closest('[hidden], .sr-only')).map(e => ({ font: parseFloat(getComputedStyle(e).fontSize), height: e.getBoundingClientRect().height })),
          };
        }, selector);
        assert.equal(result.overflow, false, `${name}/${width}/${scheme}: horizontal overflow`);
        assert.equal(result.scheme, scheme, `${name}: effective scheme`);
        for (const control of result.controls.filter(e => /^(关闭|收起)/.test(e.label))) assert.ok(control.width >= 43.9 && control.height >= 43.9, `${name}: close target ${JSON.stringify(control)}`);
        assert.ok(result.inputs.every(e => e.font >= 16), `${name}: readable input type ${JSON.stringify(result.inputs)}`);
        metrics.push({ width, scheme, ...result });
        await page.screenshot({ path: path.join(directory, `${name}-${width}-${scheme}.png`), animations: 'disabled' });
      }
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await page.waitForTimeout(260);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `${name}: 200% text must reflow`);
    metrics.push({ width: 320, scheme: 'dark', textScale: 200, overflow });
    await page.screenshot({ path: path.join(directory, `${name}-text200.png`), animations: 'disabled' });
  } finally {
    await page.evaluate(fontSize => { document.documentElement.style.fontSize = fontSize; }, original.fontSize);
    if (viewport) await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: original.dark ? 'dark' : 'light' });
    await page.evaluate(preference => {
      if (preference === null) localStorage.removeItem('quiet-room:color-scheme'); else localStorage.setItem('quiet-room:color-scheme', preference);
      window.dispatchEvent(new StorageEvent('storage', { key: 'quiet-room:color-scheme' }));
    }, original.preference);
    await page.waitForTimeout(260);
  }
  await writeFile(path.join(directory, `${name}.json`), JSON.stringify({ renderer: selector, synthetic: true, realDevice: false, engine: page.context().browser().browserType().name(), metrics }, null, 2));
}
