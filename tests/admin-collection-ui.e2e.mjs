import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const vite = await createServer({
  configFile: false,
  appType: 'custom',
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'admin-collection-ui-fixture', configureServer(server) {
    server.middlewares.use('/__admin_collection', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="admin"></div></body></html>');
    });
  } }],
});

let browser;
try {
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(60_000);
  const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-00000000000${index}`);
  let jobs = [
    { id: ids[0], channel: 'signal', sourceId: 'a'.repeat(32), title: 'Signal running', kind: 'stickers', status: 'running', added: 0, target: 1, failed: 0, totalFiles: 20, downloadedFiles: 8, downloadedBytes: 4096, started: Date.now() - 8000, packStarted: Date.now() - 8000 },
    { id: ids[1], channel: 'signal', title: 'Signal queued', kind: 'stickers', status: 'queued', added: 0, target: 1, failed: 0 },
    { id: ids[2], channel: 'noto', title: 'Noto complete', kind: 'gifs', status: 'completed', added: 1, target: 1, failed: 0, totalFiles: 1, downloadedFiles: 1 },
    { id: ids[3], channel: 'signal', title: 'Signal cancelled', kind: 'stickers', status: 'cancelled', added: 0, target: 1, failed: 0 },
    { id: ids[4], channel: 'signal', title: 'Signal failed', kind: 'stickers', status: 'failed', added: 0, target: 1, failed: 1, error: '来源下载失败，请重试' },
  ];
  await page.route('**/admin-api/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const pathname = url.pathname;
    let status = 200; let body;
    if (pathname === '/admin-api/session') body = { csrf: 'fixture-csrf' };
    else if (pathname === '/admin-api/rooms') body = { rooms: [], total: 0 };
    else if (pathname === '/admin-api/expressions/jobs' && request.method() === 'GET') body = { jobs };
    else if (pathname.endsWith('/cancel') && request.method() === 'POST') {
      const id = pathname.split('/')[4]; jobs = jobs.map(job => job.id === id ? { ...job, status: 'cancelled', error: '' } : job); body = jobs.find(job => job.id === id);
    } else if (pathname.endsWith('/retry') && request.method() === 'POST') {
      const id = pathname.split('/')[4]; const previous = jobs.find(job => job.id === id);
      const restarted = { ...previous, id: '00000000-0000-4000-8000-000000000009', status: 'running', error: '', downloadedFiles: 0, downloadedBytes: 0 };
      jobs = [restarted, ...jobs]; status = 202; body = restarted;
    } else if (pathname === '/admin-api/expressions/source') body = { packs: [], total: 0 };
    else { status = 404; body = { error: 'NOT_FOUND' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__admin_collection`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.evaluate(() => import('/src/admin.ts'));
  await page.getByRole('button', { name: '表情采集', exact: true }).click();
  const toolbarOrder = await page.locator('.resource-toolbar .actions > button').allTextContents();
  assert.deepEqual(toolbarOrder, ['采集任务', '管理已入库资源'], 'Task entry must sit immediately before catalog management');
  await page.getByRole('button', { name: '采集任务', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: '采集任务', exact: true }).isVisible(), true);
  assert.match(await page.locator('.collection-capacity').textContent(), /同时进行 10 个任务/);
  await page.getByRole('tab', { name: '进行中 1' }).waitFor();
  assert.deepEqual(await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.textContent.replace(/\s+/g, ' ').trim())),
    ['进行中 1', '排队中 1', '已完成 1', '已取消 1', '异常 1']);
  assert.equal(await page.getByRole('tab', { name: '进行中 1' }).getAttribute('aria-selected'), 'true');
  const running = page.locator(`[data-job-id="${ids[0]}"]`);
  assert.equal(await running.getByRole('button', { name: '取消任务' }).isVisible(), true);
  await running.getByRole('button', { name: '取消任务' }).click();
  await page.getByRole('tab', { name: '已取消 2' }).waitFor();
  await page.getByRole('tab', { name: '已取消 2' }).click();
  const cancelled = page.locator(`[data-job-id="${ids[0]}"]`);
  await cancelled.getByRole('button', { name: '重新采集' }).click();
  await page.waitForFunction(() => document.querySelector('[role="tab"][data-status="running"]')?.getAttribute('aria-selected') === 'true');
  await page.reload();
  await page.evaluate(() => import('/src/admin.ts'));
  await page.getByRole('tab', { name: '进行中 1' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '采集任务', exact: true }).isVisible(), true, 'Task subpage did not survive refresh');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Task subpage overflows the mobile viewport');
  console.log(JSON.stringify({ separateEntry: true, defaultRunningTab: true, fiveStatuses: true, cancelAndRetry: true, refreshRestoresSubpage: true, mobileFits: true }));
} finally {
  await browser?.close();
  await vite.close();
}
