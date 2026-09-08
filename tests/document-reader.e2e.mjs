import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { readerPdf, readerEpub } from './fixtures/document-fixtures.mjs';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__reader', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; worker-src 'self'; connect-src 'self'; object-src 'none'");
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"><button id="underlying">Underlying content</button></div></body></html>');
});
const screenshotDirectory = process.argv[2];
let browser;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.on('request', request => { const url = new URL(request.url()); if (url.protocol !== 'blob:' && !['localhost', '127.0.0.1'].includes(url.hostname)) external.push(request.url()); });
  await page.goto(`http://localhost:${server.httpServer.address().port}/__reader`);
  await page.evaluate(async pdf => {
    await import('/src/styles.css');
    const { DocumentReader } = await import('/src/lib/document-reader.ts');
    const { EpubReader } = await import('/src/lib/epub-reader.ts');
    for (const method of ['load', 'render']) {
      const original = EpubReader.prototype[method];
      EpubReader.prototype[method] = async function(...args) {
        try { return await original.apply(this, args); }
        catch (error) { window.readerDiagnostic = `${method}: ${error.stack}`; throw error; }
      };
    }
    const root = document.querySelector('#app');
    let workers = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); workers++; }
      terminate() { workers--; return super.terminate(); }
    };
    window.readerTest = {
      pdf,
      workers: () => workers,
      open(type = 'application/pdf', text) {
        window.readerTest.view?.destroy();
        const view = new DocumentReader(root, type === 'application/pdf' ? 'Quiet Room · 阅读样本.pdf' : type === 'application/epub+zip' ? '安静的房间.epub' : '阅读笔记.txt', type, () => view.destroy());
        window.readerTest.view = view;
        void view.load(new Blob([text ?? new Uint8Array(pdf)], { type }));
      },
    };
    window.readerTest.open();
  }, readerPdf());
  const ready = async () => {
    await page.locator('.document-reader:is([data-state="ready"], [data-state="error"])').waitFor();
    assert.equal(await page.locator('.document-reader').getAttribute('data-state'), 'ready', await page.evaluate(() => window.readerDiagnostic ?? document.querySelector('.reader-status')?.textContent));
  };
  await ready();
  assert.equal(await page.locator('#underlying').evaluate(node => node.inert), true);
  assert.match(await page.locator('.reader-text-layer').textContent(), /Quiet Room/);
  const pixels = await page.locator('.reader-pdf-page canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200 && data[i + 3] > 0) colored++;
    return colored;
  });
  assert(pixels > 5000, 'PDF canvas is blank');
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await ready();
  assert.match(await page.locator('.reader-text-layer').textContent(), /Second page/);
  await page.getByRole('button', { name: '上一页', exact: true }).click(); await ready();
  const swipe = async (dx, dy = 0, multi = false) => page.locator('.reader-stage').evaluate((stage, { dx, dy, multi }) => {
    const pointer = (type, x, y, id = 1) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id, clientX: x, clientY: y }));
    pointer('pointerdown', 200, 200);
    if (multi) pointer('pointerdown', 180, 200, 2);
    pointer('pointermove', 200 + dx, 200 + dy);
    pointer('pointerup', 200 + dx, 200 + dy);
    if (multi) pointer('pointerup', 180, 200, 2);
  }, { dx, dy, multi });
  await swipe(-130); await ready();
  assert.equal(await page.getByRole('spinbutton').inputValue(), '2');
  await swipe(130); await ready();
  assert.equal(await page.getByRole('spinbutton').inputValue(), '1');
  await swipe(-10); await swipe(-50, 160); await swipe(-130, 0, true);
  assert.equal(await page.getByRole('spinbutton').inputValue(), '1', 'short, vertical or multitouch gestures must not page');
  if (process.env.QUIET_ROOM_TEST_BROWSER !== 'webkit') {
    const cdp = await page.context().newCDPSession(page);
    for (const direction of [-1, 1]) {
      const x = direction < 0 ? 290 : 90;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: 170 }] });
      for (const distance of [30, 70, 110, 160]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + direction * distance, y: 170 }] });
        await page.waitForTimeout(25);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await ready();
      assert.equal(await page.getByRole('spinbutton').inputValue(), direction < 0 ? '2' : '1', 'native touch swipe');
    }
    await cdp.detach();
  }
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('searchbox').fill('Needle');
  assert.equal(await page.getByRole('searchbox').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  await page.getByRole('searchbox').press('Enter');
  await page.waitForFunction(() => document.querySelector('.reader-paging input').value === '2'); await ready();
  assert.match(await page.locator('.reader-match').textContent(), /Needle/);
  const before = await page.locator('.reader-pdf-page canvas').evaluate(node => node.getBoundingClientRect().width);
  await page.getByRole('button', { name: '放大', exact: true }).click(); await ready();
  assert(await page.locator('.reader-pdf-page canvas').evaluate(node => node.getBoundingClientRect().width) > before);
  await swipe(130);
  assert.equal(await page.getByRole('spinbutton').inputValue(), '2', 'zoomed PDF keeps horizontal panning');
  await page.getByRole('button', { name: '适合宽度', exact: true }).click(); await ready();
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  await page.getByRole('button', { name: '上下滚动', exact: true }).click(); await ready();
  await page.waitForFunction(() => document.querySelectorAll('.reader-pdf-slot canvas').length === 2);
  await page.locator('.reader-stage').evaluate(stage => stage.scrollTop = stage.scrollHeight);
  await page.waitForFunction(() => document.querySelector('.reader-paging input').value === '2');
  await page.getByRole('button', { name: '左右翻页', exact: true }).click(); await ready();
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const [width, height] of [[320, 760], [390, 844], [768, 900], [1280, 900], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250); await ready();
      const geometry = await page.locator('.document-reader').evaluate(el => {
        const stage = el.querySelector('.reader-stage').getBoundingClientRect();
        const toolbar = el.querySelector('.reader-toolbar').getBoundingClientRect();
        const buttons = [...el.querySelectorAll('button')].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect());
        return { overflow: el.scrollWidth > el.clientWidth, overlap: stage.bottom > toolbar.top + 1,
          controls: buttons.every(rect => rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth) };
      });
      assert.deepEqual(geometry, { overflow: false, overlap: false, controls: true }, `${width} ${colorScheme}`);
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `pdf-${width}-${colorScheme}.png`) });
    }
  }
  await page.evaluate(() => { window.readerTest.canvas = document.querySelector('canvas'); });
  await page.getByRole('button', { name: '关闭阅读器', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => ({ count: document.querySelectorAll('.document-reader').length,
    width: window.readerTest.canvas.width, workers: window.readerTest.workers(), inert: document.querySelector('#underlying').inert })),
  { count: 0, width: 0, workers: 0, inert: false });
  const literal = '# 阅读笔记\n\n<script>window.readerExecuted = true</script>\n\n离线阅读和搜索。\n'.repeat(30);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(text => window.readerTest.open('text/markdown', text), literal); await ready();
  assert.equal(await page.locator('.reader-text').textContent(), literal);
  assert.equal(await page.evaluate(() => window.readerExecuted), undefined);
  assert(await page.locator('.reader-paging span').evaluate(node => Number(node.textContent.slice(2)) > 1));
  await swipe(-130); assert.equal(await page.getByRole('spinbutton').inputValue(), '2');
  assert(await page.locator('.reader-stage').evaluate(stage => stage.scrollTop === 0));
  await page.getByRole('button', { name: '上下滚动', exact: true }).click(); await ready();
  assert(await page.locator('.reader-stage').evaluate(stage => stage.scrollHeight > stage.clientHeight));
  await page.getByRole('button', { name: '左右翻页', exact: true }).click(); await ready();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('searchbox').fill('离线阅读'); await page.getByRole('searchbox').press('Enter');
  assert.equal(await page.locator('.reader-text mark').textContent(), '离线阅读');
  if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, 'text-390-dark.png') });
  await page.getByRole('searchbox').press('Escape');
  for (const epub2 of [false, true]) {
    await page.evaluate(bytes => window.readerTest.open('application/epub+zip', new Uint8Array(bytes)), await readerEpub({ epub2 }));
    await ready();
    assert.match(await page.locator('.reader-epub').textContent(), /窗外的光/);
    assert.equal(await page.getByRole('combobox', { name: '章节目录' }).locator('option').count(), 2);
    assert.equal(await page.locator('.reader-epub script, .reader-epub iframe, .reader-epub style, .reader-epub [onclick], .reader-epub [id]').count(), 0);
    assert.equal(await page.evaluate(() => window.readerExecuted), undefined);
    await page.locator('.reader-epub img').evaluate(image => image.decode());
    assert(await page.locator('.reader-epub img').evaluate(image => image.naturalWidth > 0));
    if (screenshotDirectory && !epub2) {
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        for (const [width, height] of [[320, 760], [390, 844], [1280, 900]]) {
          await page.setViewportSize({ width, height });
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: path.join(screenshotDirectory, `epub-${width}-${colorScheme}.png`) });
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByRole('link', { name: '阅读下一章' }).click(); await ready();
    assert.equal(await page.getByRole('combobox', { name: '章节目录' }).inputValue(), '2');
    await page.getByRole('combobox').selectOption('1'); await ready();
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByRole('searchbox').fill('Needle'); await page.getByRole('searchbox').press('Enter');
    await page.waitForFunction(() => document.querySelector('.reader-directory').value === '2'); await ready();
    assert.equal(await page.locator('.reader-epub mark').textContent(), 'Needle');
    await page.getByRole('button', { name: '关闭阅读器' }).click();
    assert.equal(await page.evaluate(() => window.readerTest.workers()), 0);
  }
  for (const options of [{ badPath: true }, { encrypted: true }, { oversized: true }]) {
    await page.evaluate(bytes => window.readerTest.open('application/epub+zip', new Uint8Array(bytes)), await readerEpub(options));
    await page.locator('.document-reader[data-state="error"]').waitFor();
    assert.equal(await page.evaluate(() => window.readerTest.workers()), 0);
    assert.equal(await page.locator('.reader-epub').count(), 0);
  }
  await page.evaluate(bytes => window.readerTest.open('application/epub+zip', new Uint8Array(bytes)), await readerEpub({ long: true, cover: true })); await ready();
  await page.getByRole('combobox').selectOption('2'); await ready();
  const pagesInChapter = await page.locator('.reader-paging span').evaluate(node => Number(node.textContent.slice(2)));
  assert(pagesInChapter > 5, 'Long chapter must split into screen-sized pages');
  await swipe(-130);
  assert.equal(await page.getByRole('spinbutton').inputValue(), '2');
  assert.equal(await page.getByRole('combobox').inputValue(), '2', 'A swipe skipped the rest of the chapter');
  assert(await page.locator('.reader-epub').evaluate(node => node.offsetHeight <= node.closest('.reader-stage').clientHeight));
  await page.getByRole('button', { name: '上下滚动' }).click(); await ready();
  assert(await page.locator('.reader-stage').evaluate(stage => stage.scrollHeight > stage.clientHeight * 5));
  await page.getByRole('button', { name: '左右翻页' }).click(); await ready();
  assert.equal(await page.locator('.reader-paging span').evaluate(node => Number(node.textContent.slice(2))), pagesInChapter);
  for (const epub2 of [false, true]) {
    assert(await page.evaluate(async bytes => {
      const { EpubReader } = await import('/src/lib/epub-reader.ts');
      const reader = new EpubReader(() => {});
      try { await reader.load(new Uint8Array(bytes)); return (await reader.cover())?.size > 0; }
      finally { reader.destroy(); }
    }, await readerEpub({ cover: true, epub2 })), 'Declared EPUB cover missing');
  }
  await page.evaluate(bytes => {
    window.readerTest.open('application/epub+zip', new Uint8Array(bytes));
    window.readerTest.view.destroy();
  }, await readerEpub());
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.readerTest.workers()), 0);
  await page.evaluate(() => window.readerTest.open('application/pdf', 'not a PDF'));
  await page.locator('.document-reader[data-state="error"]').waitFor();
  assert.equal(await page.locator('canvas').count(), 0);
  assert.equal(await page.evaluate(() => window.readerTest.workers()), 0);
  await page.evaluate(() => window.readerTest.open('text/plain', 'x'.repeat(4 * 1024 * 1024 + 1)));
  await page.locator('.document-reader[data-state="error"]').waitFor();
  assert.match(await page.locator('.reader-status').textContent(), /4 MB/);
  assert.equal(await page.locator('.reader-text').count(), 0);
  await page.evaluate(() => window.readerTest.open());
  await page.waitForFunction(() => window.readerTest.workers() > 0);
  await page.evaluate(() => window.readerTest.view.destroy());
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.readerTest.workers()), 0);
  await page.evaluate(() => { window.readerTest.open(); window.readerTest.view.destroy(); });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.document-reader').count(), 0);
  assert.equal(await page.evaluate(() => window.readerTest.workers()), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('Document reader: PDF pixels/swipe/zoom, EPUB 2/3 chapters/navigation/search/images, unsafe archive rejection, text safety, focus, responsive geometry and worker cleanup passed.');
} finally { await browser?.close(); await server.close(); }
