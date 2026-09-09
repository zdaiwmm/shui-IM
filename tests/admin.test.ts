import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { startServer } from '../server/index.mjs';
import { makeAdminConfig, totp, verifyAdmin } from '../server/admin-auth.mjs';
import { generateIdentity } from '../src/lib/crypto';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanups.splice(0)) await fn(); });

describe('isolated session administration', () => {
  it('implements RFC TOTP and rejects reused or invalid factors', async () => {
    // RFC 6238 SHA-1 test secret; the application uses its six-digit suffix.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totp(secret, 1)).toBe('287082');
    const config = await makeAdminConfig('a-long-test-password-only', secret);
    expect(await verifyAdmin(config, 'a-long-test-password-only', '287082', -1, 59_000)).toBe(1);
    expect(await verifyAdmin(config, 'a-long-test-password-only', '287082', 1, 59_000)).toBeNull();
    expect(await verifyAdmin(config, 'incorrect-password', '287082', -1, 59_000)).toBeNull();
  });

  it('requires exact origin, password and TOTP; enforces CSRF and step-up deletion; persists replay protection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'quiet-admin-test-'));
    const password = 'long-admin-test-password-only';
    const config = await makeAdminConfig(password);
    let server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, adminConfig: config, quiet: true });
    cleanups.push(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
    const send = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: server.port, path: route, method, agent: false,
        headers: { Host: 'admin.mijiu.cloud', Origin: 'https://admin.mijiu.cloud', 'Content-Type': 'application/json',
          ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(JSON.stringify(body)) }), ...headers } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
          headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])) })));
      });
      request.on('error', error => reject(new Error(`${method} ${route}: ${error.message}`, { cause: error }))); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const code = totp(config.totpSecret);
    expect((await send('/admin-api/login', 'POST', { password, code }, { Host: 'ai.shui.click' })).status).toBe(404);
    expect((await send('/admin-api/login', 'POST', { password, code }, { Origin: 'https://ai.shui.click' })).status).toBe(403);
    expect((await send('/admin-api/rooms')).status).toBe(401);
    expect((await send('/api/rooms')).status).toBe(404);
    const login = await send('/admin-api/login', 'POST', { password, code });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie')!;
    expect(setCookie).toContain('__Host-qr-admin=');
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) expect(setCookie).toContain(attribute);
    expect(setCookie).not.toContain('Domain=');
    expect(login.headers.get('cache-control')).toBe('no-store');
    const cookie = setCookie.split(';')[0]!;
    const { csrf } = await login.json();
    expect((await send('/admin-api/login', 'POST', { password, code })).status).toBe(401);
    const identity = await generateIdentity();
    const { roomId } = server.store.createRoom(identity.publicBundle, 't'.repeat(43), 'i'.repeat(43), '<img src=x onerror=alert(1)>');
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
    const upload = { kind: 'gifs', title: '<img src=x onerror=alert(1)>', tags: 'cat', files: [{ data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7' }] };
    expect((await send('/admin-api/expressions')).status).toBe(401);
    expect((await send('/admin-api/expressions', 'POST', upload, { Cookie: cookie })).status).toBe(403);
    expect((await send('/admin-api/expressions', 'POST', upload, { ...headers, Origin: 'https://ai.shui.click' })).status).toBe(403);
    const created = await send('/admin-api/expressions', 'POST', upload, headers);
    expect(created.status).toBe(201); const expression = await created.json();
    expect(expression.status).toBe('pending');
    expect((await send(`/admin-api/expressions/${expression.id}/media/0`, 'GET', undefined, headers)).headers.get('content-type')).toBe('image/gif');
    expect((await send(`/admin-api/expressions/${expression.id}`, 'PATCH', { title: 'Reviewed', tags: 'cat', status: 'published' }, headers)).status).toBe(200);
    expect((await send(`/admin-api/expressions/${expression.id}`, 'DELETE', undefined, headers)).status).toBe(200);
    expect((await send(`/admin-api/expressions/${expression.id}/media/0`, 'GET', undefined, headers)).status).toBe(404);
    const list = await send('/admin-api/rooms', 'GET', undefined, headers);
    expect((await list.json()).rooms[0].roomId).toBe(roomId);
    const detail = await send(`/admin-api/rooms/${roomId}`, 'GET', undefined, headers);
    const text = await detail.text();
    expect(text).not.toContain('encryptionPrivateKey');
    expect(text).not.toContain('fetch_hash');
    expect(text).not.toContain(config.totpSecret);
    expect((await send(`/admin-api/rooms/${roomId}`, 'DELETE', { confirmRoomId: roomId, password, code }, { Cookie: cookie })).status).toBe(403);
    expect((await send(`/admin-api/rooms/${roomId}`, 'DELETE', { confirmRoomId: 'wrong', password, code }, headers)).status).toBe(400);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now + 30_000);
    const nextCode = totp(config.totpSecret);
    const deleted = await send(`/admin-api/rooms/${roomId}`, 'DELETE', { confirmRoomId: roomId, password, code: nextCode }, headers);
    expect({ status: deleted.status, body: await deleted.json() }).toEqual({ status: 200, body: { deleted: true } });
    expect(server.store.roomState(roomId)).toBeNull();
    await server.close();
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, adminConfig: config, quiet: true });
    expect((await send('/admin-api/login', 'POST', { password, code: nextCode })).status).toBe(401);
  }, 15_000);
});
