import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../server/index.mjs';
import { makeAdminConfig, totp, verifyAdmin } from '../server/admin-auth.mjs';
import { generateIdentity } from '../src/lib/crypto';

vi.mock('../server/admin-auth.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/admin-auth.mjs')>();
  return { ...actual, verifyAdmin: vi.fn(actual.verifyAdmin) };
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const clean of cleanups.splice(0)) await clean();
  vi.mocked(verifyAdmin).mockClear();
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-admin-abuse-'));
  const password = 'synthetic-admin-password-only', config = await makeAdminConfig(password);
  const server = await startServer({ dataDir, host: '127.0.0.1', port: 0, quiet: true, adminConfig: config, trustedProxyAddresses: '127.0.0.1' });
  cleanups.push(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const send = (source: string, body: unknown, route = '/admin-api/login', method = 'POST', extra: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const bytes = typeof body === 'string' ? body : JSON.stringify(body);
    const request = httpRequest({ hostname: '127.0.0.1', port: server.port, path: route, method, agent: false,
      headers: { Host: 'admin.mijiu.cloud', Origin: 'https://admin.mijiu.cloud', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bytes), 'X-Forwarded-For': source, ...extra } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])) })));
    });
    request.on('error', reject); request.end(bytes);
  });
  return { server, password, config, send };
}

describe('administrator authentication budgets', () => {
  it('isolates sources, protects step-up verification and restores quota without weakening TOTP replay protection', async () => {
    const f = await fixture(), start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
    const invalid = { password: 'wrong', code: 'invalid' };
    for (let i = 0; i < 8; i++) {
      const response = await f.send('192.0.2.1', invalid);
      expect(response.status).toBe(401); await response.arrayBuffer();
    }
    const limited = await f.send('192.0.2.1', 'invalid JSON');
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    const factors = { password: f.password, code: totp(f.config.totpSecret) };
    const login = await f.send('192.0.2.2', factors);
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0], { csrf } = await login.json();
    const replay = await f.send('192.0.2.3', factors);
    expect(replay.status).toBe(401); await replay.arrayBuffer();
    const identity = await generateIdentity();
    const { roomId } = f.server.store.createRoom(identity.publicBundle, 'a'.repeat(43));
    for (let i = 0; i < 7; i++) {
      const response = await f.send('192.0.2.2', { ...invalid, confirmRoomId: roomId }, `/admin-api/rooms/${roomId}`, 'DELETE', { Cookie: cookie, 'X-CSRF-Token': csrf });
      expect(response.status).toBe(401); await response.arrayBuffer();
    }
    const sharedBudget = await f.send('192.0.2.2', invalid);
    expect(sharedBudget.status).toBe(429); await sharedBudget.arrayBuffer();
    expect(f.server.store.roomState(roomId).members).toHaveLength(1);
    vi.setSystemTime(start + 60_000);
    const renewed = await f.send('192.0.2.1', { password: f.password, code: totp(f.config.totpSecret) });
    expect(renewed.status).toBe(200); await renewed.arrayBuffer();
  });

  it('keeps one expensive verifier in flight and reports busy separately from source exhaustion', async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(verifyAdmin).mockImplementationOnce(async () => { await held; return null; });
    const first = f.send('192.0.2.1', { password: 'held', code: '000000' });
    try {
      await vi.waitFor(() => expect(verifyAdmin).toHaveBeenCalledTimes(1));
      const busy = await f.send('192.0.2.2', { password: f.password, code: totp(f.config.totpSecret) });
      expect(busy.status).toBe(503); expect(busy.headers.get('retry-after')).toBe('1');
      expect(await busy.json()).toMatchObject({ code: 'AUTH_BUSY' });
      expect(verifyAdmin).toHaveBeenCalledTimes(1);
    } finally { release(); const response = await first; await response.arrayBuffer(); }
    const retry = await f.send('192.0.2.2', { password: f.password, code: totp(f.config.totpSecret) });
    expect(retry.status).toBe(200); await retry.arrayBuffer();
  });
});
