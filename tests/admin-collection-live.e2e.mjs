// Explicit live upstream smoke test; never accesses a production database.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from '../server/index.mjs';
import { createExpressionCatalog } from '../server/expression-catalog.mjs';
import { makeAdminConfig, totp } from '../server/admin-auth.mjs';
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dataDir = await mkdtemp(join(tmpdir(), 'collection-live-'));
const output = process.argv[2] || '/private/tmp/collection-live-evidence';
await mkdir(output, { recursive: true });
let service, browser, page;
const evidence = [];
try {
  const config = await makeAdminConfig('synthetic-live-test-password');
  // Reserve a local ephemeral port, then use its exact admin origin.
  const { createServer } = await import('node:net');
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  service = await startServer({ port, host: '127.0.0.1', dataDir, adminConfig: config, adminOrigin: `http://localhost:${port}`, quiet: true });
  browser = await chromium.launch(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {});
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${port}`);
  await page.locator('[name=password]').fill('synthetic-live-test-password');
  await page.locator('[name=code]').fill(totp(config.totpSecret));
  await page.getByRole('button', { name: '验证并登录' }).click();
  await page.getByRole('button', { name: '表情采集', exact: true }).click();
  for (const [channel, keyword, id] of [['signal', 'cat meme', '8771105c23a9dc10df5aafb55105ef02'], ['noto', 'white flag', 'noto-1f3f3_fe0f']]) {
    await page.locator('#collection-channel').selectOption(channel);
    await page.locator('[name=keyword]').fill(keyword);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    const card = page.locator('.source-pack').filter({ has: page.locator(`img[src*="/${id}/"]`) });
    await Promise.race([card.waitFor({ timeout: 60000 }), page.getByText('来源连接或目录读取失败，请重新搜索', { exact: true }).waitFor({ timeout: 60000 }).then(() => { throw new Error('Live upstream search unavailable'); })]);
    await card.locator('img').evaluate(img => img.decode());
    const accepted = page.waitForResponse(response => response.url().endsWith('/expressions/collect') && response.status() === 202);
    await card.getByRole('button', { name: '采集此包' }).click();
    const job = await (await accepted).json();
    await page.reload();
    await page.getByRole('button', { name: '采集任务', exact: true }).click();
    await page.getByRole('heading', { name: '采集任务', exact: true }).waitFor();
    await page.getByRole('tab', { name: /已完成/ }).click();
    await page.locator(`[data-job-id="${job.id}"]`).getByText('已完成', { exact: true }).waitFor({ timeout: 180000 });
    await page.getByRole('button', { name: '返回表情采集' }).click();
    await page.locator('#collection-channel').selectOption(channel);
    await page.locator('[name=keyword]').fill(keyword);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await card.waitFor();
    await card.locator('img').evaluate(img => img.decode());
    const detail = await page.evaluate(async id => (await fetch(`/admin-api/expressions/${id}`)).json(), id);
    assert.equal(detail.status, 'published'); assert(detail.items.length > 0);
    const bytes = await page.evaluate(async id => (await (await fetch(`/admin-api/expressions/${id}/media/0`)).arrayBuffer()).byteLength, id);
    assert(bytes > 0);
    evidence.push({ channel, id, count: detail.items.length, firstImageBytes: bytes, status: detail.status });
    await page.screenshot({ path: `${output}/${channel}-desktop.png` });
    await page.setViewportSize({ width: 320, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert(await card.evaluate(el => {
      const title = el.querySelector('.source-pack-info').getBoundingClientRect();
      const image = el.querySelector('img').getBoundingClientRect();
      const button = el.querySelector('button').getBoundingClientRect();
      return title.width >= image.width && button.top >= title.bottom;
    }), 'Narrow card retains readable text and puts the action below it');
    await page.screenshot({ path: `${output}/${channel}-mobile.png` });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    assert(await card.locator('button').first().isDisabled());
  }
  // Exercise a full page of upstream covers, including requests beyond the
  // browser's initial viewport. This is separate from single-pack acquisition.
  await page.locator('#collection-channel').selectOption('signal');
  await page.locator('[name=keyword]').fill('');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.source-cover').length === 24);
  const covers = await page.locator('.source-cover').evaluateAll(async images => {
    return Promise.all(images.map(async image => {
      image.loading = 'eager';
      try { await image.decode(); return { ok: true, id: image.getAttribute('src') }; }
      catch { return { ok: false, id: image.getAttribute('src') }; }
    }));
  });
  evidence.push({ fullPageSignalPreviews: covers });
  assert(covers.every(cover => cover.ok), 'All 24 Signal covers decode');
  await page.screenshot({ path: `${output}/signal-full-page.png`, fullPage: true });
  await browser.close(); browser = undefined; await service.close(); service = undefined;
  const reopened = createExpressionCatalog({ dataDir });
  try { for (const item of evidence.filter(item => item.id)) { assert.equal(reopened.detail(item.id).items.length, item.count); assert.equal(reopened.preview(item.id, 0).bytes.length, item.firstImageBytes); } } finally { await reopened.close(); }
  await writeFile(`${output}/result.json`, JSON.stringify({ at: new Date().toISOString(), restartReadback: true, evidence }, null, 2));
  console.log(JSON.stringify({ restartReadback: true, evidence, output }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: `${output}/failure.png` }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await service?.close(); await rm(dataDir, { recursive: true, force: true }); }
