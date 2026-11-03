import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer } from '../server/index.mjs';
import { leadPixelConfig } from '../server/lead-pixel.mjs';

afterEach(() => vi.unstubAllEnvs());

it('rejects incomplete or malformed pixel settings', () => {
  expect(() => leadPixelConfig({ LEAD_PIXEL_CONNECTION: 'invalid' })).toThrow();
  expect(() => leadPixelConfig({ LEAD_PIXEL_KEY: 'pixel-v1.invalid' })).toThrow();
});

it.each([false, true])('isolates the deployment pixel settings (configured=%s)', async configured => {
  const connection = '00000000-0000-4000-8000-000000000001';
  const key = 'pixel-v1.' + 'b'.repeat(64);
  vi.stubEnv('LEAD_PIXEL_CONNECTION', configured ? connection : '');
  vi.stubEnv('LEAD_PIXEL_KEY', configured ? key : '');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'lead-policy-'));
  const server = await startServer({ port: 0, dataDir, quiet: true });
  function request(host: string, pathname: string) {
    return new Promise<{ policy: string; body: string }>((resolve, reject) => {
      get({ hostname: '127.0.0.1', port: server.port, path: pathname, headers: { host } }, response => {
        let body = '';
        response.setEncoding('utf8').on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ policy: String(response.headers['content-security-policy']), body }));
      }).on('error', reject);
    });
  }
  try {
    for (const host of ['mijiu.cloud', 'ai.shui.click', 'admin.mijiu.cloud']) {
      const shell = await request(host, '/');
      const runtime = await request(host, '/api/site-runtime.js');
      if (configured && host === 'mijiu.cloud') {
        const collector = 'https://shui.click/collect/' + connection;
        const directives = shell.policy.split('; ');
        expect(directives).toContain("script-src 'self' 'wasm-unsafe-eval' https://shui.click/lead.js");
        expect(directives).toContain(`connect-src 'self' ws://mijiu.cloud wss://mijiu.cloud ${collector} ${collector}/batch ${collector}/receipts`);
        expect(runtime.body).toContain(connection);
        expect(runtime.body).toContain(key);
      } else {
        expect(shell.policy).not.toContain('https://shui.click');
        expect(runtime.body).not.toMatch(/leadq|shui\.click\/lead|pixel-v1/);
        expect(runtime.body).not.toContain(connection);
      }
    }
    expect((await request('mijiu.cloud', '/api/health')).policy).not.toContain('https://shui.click');
    expect((await request('mijiu.cloud', '/sw.js')).policy).not.toContain('https://shui.click');
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
