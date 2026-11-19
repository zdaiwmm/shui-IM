import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { createAixServer } from '../services/aix-x/index.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shui-youtube-'));
const token = 'test-youtube-gateway-token-0000000000000';
const videoId = 'TestVideo01';
const url = `https://youtu.be/${videoId}?si=tracking`;
const title = 'A public YouTube fixture';
const description = 'First paragraph.\n\n' + 'Second paragraph. '.repeat(24);
const publicAix = 'https://aix.shui.click';
const upstreamRanges = [];
const browserDestinations = [];
let relay, app, vite, browser, video, cover;

function videoResponse(bytes, range) {
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
  if (!range) return new Response(bytes, { headers: { ...headers, 'Content-Length': String(bytes.length) } });
  const [, start, end] = /^bytes=(\d*)-(\d*)$/.exec(range);
  const first = start ? Number(start) : Math.max(0, bytes.length - Number(end));
  const last = start && end ? Math.min(Number(end), bytes.length - 1) : bytes.length - 1;
  if (first >= bytes.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
  return new Response(bytes.subarray(first, last + 1), { status: 206, headers: {
    ...headers, 'Content-Length': String(last - first + 1), 'Content-Range': `bytes ${first}-${last}/${bytes.length}`,
  } });
}

try {
  relay = createAixServer({
    gatewayToken: token, publicOrigin: publicAix,
    youtubeExtract: async id => {
      assert.equal(id, videoId);
      return { id, extractor_key: 'Youtube', availability: 'public', title, channel: 'Fixture channel', description, duration: 2,
        formats: [{ url: 'https://r1---sn-example.googlevideo.com/videoplayback', format_id: '18', ext: 'mp4',
          protocol: 'https', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', width: 320, height: 180, tbr: 500 }] };
    },
    fetch: async (destination, { headers }) => {
      if (destination.hostname === 'i.ytimg.com') return new Response(cover, { headers: { 'Content-Type': 'image/jpeg' } });
      assert.equal(destination.hostname, 'r1---sn-example.googlevideo.com');
      upstreamRanges.push(headers.Range);
      return videoResponse(video, headers.Range);
    },
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const relayOrigin = `http://127.0.0.1:${relay.address().port}`;
  app = await startServer({ port: 0, host: '127.0.0.1', quiet: true, dataDir: directory, youtubeEnabled: true, xPostGatewayToken: token,
    youtubeGatewayFetch: (destination, init) => fetch(relayOrigin + new URL(destination).pathname, init),
  });
  vite = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error',
    plugins: [{ name: 'youtube-e2e', transform(code, id) {
      if (id.endsWith('/src/main.ts')) return code.replace('void app.start();', 'window.app=app;void app.start();');
    } }],
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
      '/api': { target: `http://127.0.0.1:${app.port}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${app.port}`, ws: true, changeOrigin: false },
    } },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
  async function pageFor() {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.route('**/*', async route => {
      const destination = new URL(route.request().url());
      if (destination.origin === origin) return route.continue();
      if (destination.origin === publicAix) {
        const response = await route.fetch({ url: relayOrigin + destination.pathname, maxRedirects: 0 });
        return route.fulfill({ response });
      }
      browserDestinations.push(destination.hostname);
      return route.abort();
    });
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async text => { window.inviteLink = text; } },
    }));
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    return page;
  }
  const sender = await pageFor();
  const receiver = await pageFor();
  await sender.goto(origin);
  const sample = await sender.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const drawing = canvas.getContext('2d');
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (const color of ['red', 'green', 'blue', 'purple']) {
      drawing.fillStyle = color;
      drawing.fillRect(0, 0, 320, 180);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach(track => track.stop());
    return { jpeg: canvas.toDataURL('image/jpeg').split(',')[1], mp4: Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())) };
  });
  cover = Buffer.from(sample.jpeg, 'base64');
  video = Buffer.from(sample.mp4);
  await sender.locator('#create-room').click();
  await sender.locator('#copy-invite').click();
  await sender.waitForFunction(() => !!window.inviteLink);
  await receiver.goto(await sender.evaluate(() => window.inviteLink));
  await sender.locator('#message-input:not([disabled])').waitFor();
  await receiver.locator('#message-input:not([disabled])').waitFor();
  await sender.waitForFunction(() => {
    const members = window.app.session.vault.members.filter(member => member.status === 'active');
    return members.length === 2 && members.every(member => member.capabilities.includes('youtube-preview-v1'));
  });
  const draftResponse = sender.waitForResponse(response => new URL(response.url()).pathname.endsWith('/youtube-video'));
  await sender.locator('#message-input').fill(url);
  assert.equal((await draftResponse).status(), 200, 'The browser and Vite proxy must preserve the authorized chat origin');
  await sender.locator('.link-preview-draft').filter({ hasText: title }).waitFor();
  await sender.locator('#send-text').click();
  const card = receiver.locator('.youtube-card').filter({ hasText: title });
  await card.waitFor();
  await receiver.waitForFunction(() => document.querySelector('.youtube-card .x-post-poster')?.naturalWidth === 320);
  assert.equal(upstreamRanges.length, 0, 'Preview must not read video bytes');
  assert.deepEqual(await receiver.evaluate(({ url }) => {
    return [...window.app.messages.values()].find(item => item.payload?.text === url)?.payload.preview;
  }, { url }), { url, siteName: 'YouTube', title: 'YouTube', description: '', layout: 'text', youtube: true });
  await card.getByRole('button', { name: '查看全文' }).click();
  await card.getByText(description, { exact: true }).waitFor();
  await card.getByRole('button', { name: '播放视频' }).click();
  const player = card.locator('video');
  await card.locator('video[data-actual-playback="true"]').waitFor();
  await card.getByRole('button', { name: '暂停视频' }).click();
  const target = await player.evaluate(media => media.currentTime < .65 ? 1.2 : .2);
  await card.getByRole('slider', { name: '视频进度' }).fill(String(target));
  await receiver.waitForFunction(target => {
    const media = document.querySelector('.youtube-card video');
    return media && !media.seeking && Math.abs(media.currentTime - target) < .45;
  }, target);
  await card.locator('.x-post-toggle').click();
  await card.locator('video[data-actual-playback="true"]').waitFor();
  assert.ok(upstreamRanges.some(range => /^bytes=/.test(range ?? '')), 'The relay must serve browser range requests');
  await card.locator('.youtube-stop').click();
  await card.locator('video').waitFor({ state: 'detached' });
  assert.deepEqual(browserDestinations.filter(host => /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/.test(host)), []);
  console.log('YouTube card shared, played, sought and closed with YouTube domains blocked in the browser.');
} finally {
  await browser?.close();
  await vite?.close();
  await app?.close();
  if (relay?.listening) {
    relay.close();
    relay.closeAllConnections();
  }
  await rm(directory, { recursive: true, force: true });
}
