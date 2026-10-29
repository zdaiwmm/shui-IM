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

async function fixture(legacy = false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-admin-abuse-'));
  const generated = await makeAdminConfig();
  const config = legacy ? { v: 1, salt: Buffer.alloc(32, 1).toString('base64url'), hash: Buffer.alloc(32, 2).toString('base64url'), totpSecret: generated.totpSecret } : generated;
  const options = { dataDir, host: '127.0.0.1', port: 0, quiet: true, adminConfig: config, trustedProxyAddresses: '127.0.0.1' };
  let server = await startServer(options);
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
  return { get server() { return server; }, config, send,
    restart: async () => { await server.close(); server = await startServer(options); } };
}

describe('administrator authentication budgets', () => {
  it('isolates sources, protects step-up verification and restores quota without weakening TOTP replay protection', async () => {
    const f = await fixture(), start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
    const invalid = { code: 'invalid' };
    for (let i = 0; i < 8; i++) {
      const response = await f.send('192.0.2.1', 'invalid JSON');
      expect(response.status).toBe(400); await response.arrayBuffer();
    }
    const limited = await f.send('192.0.2.1', 'invalid JSON');
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    const factors = { code: totp(f.config.totpSecret) };
    const login = await f.send('192.0.2.2', factors);
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0], { csrf } = await login.json();
    const replay = await f.send('192.0.2.3', factors);
    expect(replay.status).toBe(401); await replay.arrayBuffer();
    const identity = await generateIdentity();
    const { roomId } = f.server.store.createRoom(identity.publicBundle, 'a'.repeat(43));
    for (let i = 0; i < 7; i++) {
      const response = await f.send('192.0.2.2', { ...invalid, confirmRoomId: 'wrong' }, `/admin-api/rooms/${roomId}`, 'DELETE', { Cookie: cookie, 'X-CSRF-Token': csrf });
      expect(response.status).toBe(400); await response.arrayBuffer();
    }
    const sharedBudget = await f.send('192.0.2.2', invalid);
    expect(sharedBudget.status).toBe(429); await sharedBudget.arrayBuffer();
    expect(f.server.store.roomState(roomId).members).toHaveLength(1);
    vi.setSystemTime(start + 60_000);
    const renewed = await f.send('192.0.2.1', { code: totp(f.config.totpSecret) });
    expect(renewed.status).toBe(200); await renewed.arrayBuffer();
  });

  it('keeps one verifier in flight and reports busy separately from source exhaustion', async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(verifyAdmin).mockImplementationOnce(async () => { await held; return null; });
    const first = f.send('192.0.2.1', { code: '000000' });
    try {
      await vi.waitFor(() => expect(verifyAdmin).toHaveBeenCalledTimes(1));
      const busy = await f.send('192.0.2.2', { code: totp(f.config.totpSecret) });
      expect(busy.status).toBe(503); expect(busy.headers.get('retry-after')).toBe('1');
      expect(await busy.json()).toMatchObject({ code: 'AUTH_BUSY' });
      expect(verifyAdmin).toHaveBeenCalledTimes(1);
    } finally { release(); const response = await first; await response.arrayBuffer(); }
    const retry = await f.send('192.0.2.2', { code: totp(f.config.totpSecret) });
    expect(retry.status).toBe(200); await retry.arrayBuffer();
  });

  it('persists legacy replay protection and the shared five-failure cooldown across sources and restarts', async () => {
    const f = await fixture(true), start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
    const factors = { code: totp(f.config.totpSecret) };
    const login = await f.send('192.0.2.1', factors);
    expect(login.status).toBe(200); await login.arrayBuffer();
    const identity = await generateIdentity();
    const { roomId } = f.server.store.createRoom(identity.publicBundle, 'b'.repeat(43));
    const secondLogin = await f.send('192.0.2.1', { code: totp(f.config.totpSecret, Math.floor(start / 30_000) + 1) });
    expect(secondLogin.status).toBe(200);
    const cookie = secondLogin.headers.get('set-cookie')!.split(';')[0], { csrf } = await secondLogin.json();
    const stepUpFailure = await f.send('192.0.2.1', { confirmRoomId: roomId, code: 'invalid' }, `/admin-api/rooms/${roomId}`, 'DELETE', { Cookie: cookie, 'X-CSRF-Token': csrf });
    expect(stepUpFailure.status).toBe(401); await stepUpFailure.arrayBuffer();
    await f.restart();
    const replay = await f.send('192.0.2.2', factors);
    expect(replay.status).toBe(401); await replay.arrayBuffer();
    for (let i = 3; i <= 5; i++) {
      const failure = await f.send(`192.0.2.${i}`, { code: 'invalid' });
      expect(failure.status).toBe(401); await failure.arrayBuffer();
    }
    const verifications = vi.mocked(verifyAdmin).mock.calls.length;
    const limited = await f.send('198.51.100.1', { code: totp(f.config.totpSecret, Math.floor(start / 30_000) + 1) });
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('900');
    await limited.arrayBuffer();
    await f.restart();
    vi.setSystemTime(start + 30_000);
    const persisted = await f.send('203.0.113.1', { code: totp(f.config.totpSecret) });
    expect(persisted.status).toBe(429); expect(persisted.headers.get('retry-after')).toBe('870');
    await persisted.arrayBuffer();
    expect(verifyAdmin).toHaveBeenCalledTimes(verifications);
    vi.setSystemTime(start + 15 * 60_000);
    const recovered = await f.send('203.0.113.2', { code: totp(f.config.totpSecret) });
    expect(recovered.status).toBe(200); await recovered.arrayBuffer();
    for (let i = 3; i <= 6; i++) {
      const failure = await f.send(`203.0.113.${i}`, { code: 'invalid' });
      expect(failure.status).toBe(401); await failure.arrayBuffer();
    }
    vi.setSystemTime(start + 16 * 60_000);
    const reset = await f.send('203.0.113.7', { code: totp(f.config.totpSecret) });
    expect(reset.status).toBe(200); await reset.arrayBuffer();
  });
});
