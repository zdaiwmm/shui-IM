import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ configFile: false, appType: 'custom', root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__weak_call', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body></body></html>'); });
let browser;
const results = [];
try {
  await server.listen();
  const executable = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' };
  browser = await chromium.launch({ ...executable, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__weak_call`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const profiles = [
    ...[100, 300, 800].map(latency => ({ name: `signaling-latency-${latency}`, latency })),
    ...[0.05, 0.1, 0.2].map(loss => ({ name: `signaling-loss-${loss}`, loss, ackLoss: loss * 2 })),
    { name: 'dns-config-response-delay', configDelay: 800 },
    ...[1000, 5000, 15000].map(disconnectMs => ({ name: `signaling-disconnect-${disconnectMs}`, disconnectMs })),
    { name: 'uplink-quality-recovery', quality: true, uplinkLoss: 0.2 },
    { name: 'downlink-quality-recovery', quality: true, uplinkLoss: 0.02 },
    ...[100, 300, 800].map(latency => ({ name: `cdp-latency-${latency}`, network: { latency } })),
    ...[5, 10, 20].map(packetLoss => ({ name: `cdp-rtp-loss-${packetLoss}`, network: { packetLoss } })),
    { name: 'cdp-asymmetric-uplink', network: { uploadThroughput: 40_000, downloadThroughput: 500_000 } },
    { name: 'cdp-asymmetric-downlink', network: { uploadThroughput: 500_000, downloadThroughput: 40_000 } },
  ];
  for (const profile of profiles) {
    await cdp.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: profile.network ? [{ urlPattern: '', latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...profile.network }] : [] });
    const result = await page.evaluate(async profile => (await import('/tests/helpers/weak-call-browser.js')).runWeakCall(profile), profile);
    results.push(result); process.stdout.write(`Weak browser scenario: ${JSON.stringify(result)}\n`);
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`WEAK_NETWORK_BROWSER_PASS scenarios=${results.length}; synthetic signaling/statistics and CDP WebRTC shaping, native Chrome media; not physical iPhone or real TURN impairment\n`);
} finally { await browser?.close(); await server.close(); }
