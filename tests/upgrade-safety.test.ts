import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startServer } from '../server/index.mjs';

it('rejects an invalid Upgrade URL without taking down the HTTP server', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-upgrade-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, '127.0.0.1');
      let data = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('Upgrade response timed out')));
      const nonce = randomBytes(16).toString('base64');
      socket.on('connect', () => socket.write(`GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${nonce}\r\n\r\n`));
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('error', reject);
      socket.on('end', () => { socket.destroy(); resolve(data); });
    });
    expect(response).toContain('400 Bad Request');
    const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
