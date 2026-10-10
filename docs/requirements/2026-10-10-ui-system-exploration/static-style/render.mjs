import { chromium } from '/Users/achilles/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const output = process.argv[2];
const patternPath = process.argv[3];
if (!output || !path.isAbsolute(output)) throw Error('Pass an absolute PNG output path.');
if (!patternPath || !path.isAbsolute(patternPath)) throw Error('Pass an absolute local Telegram pattern SVG path.');
const pattern = await fs.readFile(patternPath, 'utf8');
if (/<script|foreignObject|<image|<!DOCTYPE|\bon\w+\s*=|(?:href|src)=["']https?:/i.test(pattern)) throw Error('Pattern must be a local, passive SVG.');
const patternUrl = 'data:image/svg+xml;base64,' + Buffer.from(pattern).toString('base64');
await fs.mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1224, height: 1050 }, deviceScaleFactor: 2 });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.route('http://**/*', route => route.abort());
  await page.route('https://**/*', route => route.abort());
  await page.goto(new URL('board.html', import.meta.url).href);
  await page.evaluate(url => document.documentElement.style.setProperty('--wallpaper-pattern', 'url("' + url + '")'), patternUrl);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const report = await page.evaluate(() => ({
    canvasWidth: document.documentElement.scrollWidth,
    canvasHeight: document.querySelector('.board').getBoundingClientRect().height,
    chats: [...document.querySelectorAll('.chat')].map(chat => {
      const timeline = chat.querySelector('.timeline').getBoundingClientRect();
      return {
        width: chat.clientWidth, height: chat.clientHeight,
        titleHeight: chat.querySelector('.titlebar').getBoundingClientRect().height,
        composerHeight: chat.querySelector('.composer').getBoundingClientRect().height,
        bubbles: chat.querySelectorAll('.bubble').length,
        clippedBubbles: [...chat.querySelectorAll('.bubble')].filter(bubble => {
          const rect = bubble.getBoundingClientRect();
          return rect.top < timeline.top - 1 || rect.bottom > timeline.bottom + 1;
        }).length,
      };
    }),
    themeColors: [...document.querySelectorAll('section > .chat')].map(chat => ({
      accent: getComputedStyle(chat).getPropertyValue('--accent').trim(),
      incoming: getComputedStyle(chat).getPropertyValue('--incoming').trim(),
      outgoing: getComputedStyle(chat).getPropertyValue('--outgoing').trim(),
      wallpaper: getComputedStyle(chat).getPropertyValue('--chat').trim(),
    })),
  }));
  await page.locator('.board').screenshot({ path: output });
  console.log(JSON.stringify({ ...report, patternLoaded: true, pageErrors: failures, evidence: 'V5 static screenshot-derived colors; Chromium only, no Safari keyboard validation.' }, null, 2));
  if (failures.length || report.chats.some(chat => chat.clippedBubbles)) throw Error('Static rendering has errors or clipped messages.');
} finally {
  await browser.close();
}
