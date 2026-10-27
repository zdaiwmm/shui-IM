import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../server/index.mjs';
import { WRITE_LIMITS } from '../server/request-limits.mjs';
import { generateIdentity } from '../src/lib/crypto';
import { createPushAuthorization } from '../src/lib/push';
import { createCreatorMlsState, prepareCreatorWelcome, prepareMlsWindowUpdate } from '../src/lib/mls';
import type { Vault } from '../src/lib/types';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); vi.restoreAllMocks(); });

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-abuse-'));
  const server = await startServer({ dataDir, host: '127.0.0.1', port: 0, quiet: true, trustedProxyAddresses: '127.0.0.1' });
  cleanups.push(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const identity = await generateIdentity(), token = 'a'.repeat(43);
  const { roomId } = server.store.createRoom(identity.publicBundle, token, 'i'.repeat(43), 'fixture', ['message-window-v1']);
  const send = (route: string, method: string, body = '{}', source = '192.0.2.1', accessToken = token) => fetch(`http://127.0.0.1:${server.port}${route}`, {
    method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Forwarded-For': source }, body,
  });
  return { server, identity, token, roomId, send };
}

describe('write-route abuse controls', () => {
  it('enforces all four device budgets before body parsing/work, independent of source IP and other operations', async () => {
    const f = await fixture(), deviceId = f.identity.publicBundle.deviceId;
    const other = await generateIdentity();
    const second = f.server.store.joinRoom(f.roomId, other.publicBundle, 'fixture-proof', 'b'.repeat(43));
    expect(second.members).toHaveLength(2);
    const routes = [
      ['mls-events', `/api/rooms/${f.roomId}/mls-events`, 'PUT', 400],
      ['mls-welcome', `/api/rooms/${f.roomId}/mls-welcome`, 'PUT', 400],
      ['blob-complete', `/api/rooms/${f.roomId}/blobs/${crypto.randomUUID()}/complete`, 'POST', 404],
      ['push-delete', `/api/rooms/${f.roomId}/push/${deviceId}`, 'DELETE', 400],
    ] as const;
    for (const [operation, route, method, status] of routes) {
      for (let i = 0; i < WRITE_LIMITS[operation].device; i++) {
        const response = await f.send(route, method, '{}', `192.0.2.${i % 200 + 1}`);
        expect(response.status).toBe(status); await response.arrayBuffer();
      }
      const rejected = await f.send(route, method, 'invalid JSON', '198.51.100.1');
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get('retry-after')).toMatch(/^[1-6]?\d$/);
      expect(await rejected.json()).toMatchObject({ code: 'RATE_LIMITED' });
      const otherRoute = operation === 'push-delete' ? `/api/rooms/${f.roomId}/push/${other.publicBundle.deviceId}` : route;
      const independent = await f.send(otherRoute, method, '{}', '192.0.2.1', 'b'.repeat(43));
      expect(independent.status).toBe(status); await independent.arrayBuffer();
    }
    expect(f.server.store.roomState(f.roomId).nextMlsEventSeq).toBe(0);
  });

  it('bounds unauthenticated work even when every request supplies a different forged forwarding chain', async () => {
    const f = await fixture(), route = `/api/rooms/${f.roomId}/mls-welcome`;
    for (let i = 0; i < WRITE_LIMITS['mls-welcome'].source; i++) {
      const response = await f.send(route, 'PUT', '{}', `192.0.2.${i % 200 + 1}, 198.51.100.1`, 'invalid');
      expect(response.status).toBe(401); await response.arrayBuffer();
    }
    const rejected = await f.send(route, 'PUT', '{}', '203.0.113.1, 198.51.100.1', 'invalid');
    expect(rejected.status).toBe(429); await rejected.arrayBuffer();
    const separate = await f.send(route, 'PUT', '{}', '198.51.100.2', 'invalid');
    expect(separate.status).toBe(401); await separate.arrayBuffer();
  });

  it('preserves signed welcome/event retries, a nine-attachment completion burst and signed unsubscribe', async () => {
    const f = await fixture(), other = await generateIdentity(), caps = ['message-window-v1'];
    f.server.store.joinRoom(f.roomId, other.publicBundle, 'fixture-proof', 'b'.repeat(43), 'peer', caps);
    const members = f.server.store.roomState(f.roomId).members;
    const vault: Vault = { v: 3, roomId: f.roomId, accessToken: f.token, pairingSecret: '', creatorFingerprint: 'fixture', members,
      lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420', role: 'creator', identity: f.identity,
      mls: await createCreatorMlsState(f.roomId, f.identity, members) };
    vault.mls = await prepareCreatorWelcome(vault);
    for (let i = 0; i < 2; i++) {
      const response = await f.send(`/api/rooms/${f.roomId}/mls-welcome`, 'PUT', JSON.stringify({ welcome: vault.mls.pendingWelcome }));
      expect(response.status).toBe(200); await response.arrayBuffer();
    }
    vault.mls.pendingWelcome = undefined;
    const update = await prepareMlsWindowUpdate(vault);
    for (let i = 0; i < 2; i++) {
      const response = await f.send(`/api/rooms/${f.roomId}/mls-events`, 'PUT', JSON.stringify({ event: update.event }));
      expect(response.status).toBe(200);
      expect((await response.json()).event.duplicate).toBe(i === 1);
    }
    expect(f.server.store.roomState(f.roomId).nextMlsEventSeq).toBe(1);
    for (let i = 0; i < 9; i++) {
      const id = crypto.randomUUID(), actor = f.identity.publicBundle.deviceId;
      f.server.store.createBlob(f.roomId, id, 1, 17, actor);
      await f.server.store.putBlobChunk(f.roomId, id, 0, new Uint8Array(17), actor);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await f.send(`/api/rooms/${f.roomId}/blobs/${id}/complete`, 'POST');
        expect(response.status).toBe(200); expect((await response.json()).completed).toBe(true);
      }
    }
    const authorization = await createPushAuthorization(vault, 'unsubscribe', 'https://push.example.test/synthetic');
    const response = await f.send(`/api/rooms/${f.roomId}/push/${f.identity.publicBundle.deviceId}`, 'DELETE', JSON.stringify({ authorization }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ removed: true });
  });

  it('returns 400 for malformed path escapes without logging an internal error or breaking health', async () => {
    const f = await fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const pathname of ['/%E0%A4%A', '/api/%ZZ', '/%FF']) {
      const response = await fetch(`http://127.0.0.1:${f.server.port}${pathname}`);
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'INVALID_PATH' });
    }
    const health = await fetch(`http://127.0.0.1:${f.server.port}/api/health`);
    expect(health.status).toBe(200); await health.arrayBuffer(); expect(log).not.toHaveBeenCalled();
  });

  it('configures the public proxy to replace forwarding headers while retaining edge budgets', async () => {
    const config = await readFile(new URL('../deploy/nginx-ai.shui.click.conf', import.meta.url), 'utf8');
    expect(config).not.toContain('$proxy_add_x_forwarded_for');
    expect(config.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g)).toHaveLength(4);
    expect(config).toContain('limit_req zone=quiet_room_api burst=60 nodelay;');
    expect(config).toContain('limit_req zone=quiet_room_create burst=2 nodelay;');
  });
});
