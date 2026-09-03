import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../server/index.mjs';
import { createJoinProof, encryptMessage, generateIdentity } from '../src/lib/crypto';
import { randomBase64Url } from '../src/lib/base64';
import { createPushAuthorization } from '../src/lib/push';
import type { RoomMember, Vault } from '../src/lib/types';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

async function jsonRequest(url: string, options: RequestInit = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

describe('background wake-up integration', () => {
  it('sends only the other enrolled device subscription after a non-duplicate commit', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-push-server-'));
    const wakes: unknown[] = [];
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      quiet: true,
      pushService: {
        enabled: true,
        publicKey: 'test-public-key',
        allowedHosts: ['push.example.test'],
        async wake(subscription: unknown) {
          wakes.push(subscription);
          return { delivered: true };
        },
      },
    });
    cleanup.push(async () => {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const creatorToken = randomBase64Url(32);
    const inviteToken = randomBase64Url(32);
    const joinerToken = randomBase64Url(32);
    const pairingSecret = randomBase64Url(32);
    const [creatorIdentity, joinerIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
    const room = await jsonRequest(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorBundle: creatorIdentity.publicBundle, accessToken: creatorToken, inviteToken }),
    });
    const proof = await createJoinProof(pairingSecret, joinerIdentity.publicBundle);
    const state = await jsonRequest(`${baseUrl}/api/rooms/${room.roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inviteToken}` },
      body: JSON.stringify({ bundle: joinerIdentity.publicBundle, proof, deviceAccessToken: joinerToken }),
    });
    const members = state.members as RoomMember[];
    const vault: Vault = {
      v: 1,
      roomId: room.roomId,
      accessToken: creatorToken,
      role: 'creator',
      pairingSecret,
      creatorFingerprint: 'unused',
      identity: creatorIdentity,
      members,
      lastSeq: 0,
      createdAt: new Date().toISOString(),
      protocol: 'legacy-v1',
    };
    const endpoint = 'https://push.example.test/subscription/joiner';
    const joinerVault: Vault = { ...vault, accessToken: joinerToken, role: 'joiner', identity: joinerIdentity };
    const forgedRegistration = await fetch(`${baseUrl}/api/rooms/${room.roomId}/push/${joinerIdentity.publicBundle.deviceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joinerToken}` },
      body: JSON.stringify({ subscription: {
        endpoint,
        keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) },
      }, authorization: {
        ...await createPushAuthorization(vault, 'subscribe', endpoint),
        deviceId: joinerIdentity.publicBundle.deviceId,
      } }),
    });
    expect(forgedRegistration.status).toBe(400);
    await jsonRequest(`${baseUrl}/api/rooms/${room.roomId}/push/${joinerIdentity.publicBundle.deviceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joinerToken}` },
      body: JSON.stringify({ subscription: {
        endpoint,
        keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) },
      }, authorization: await createPushAuthorization(joinerVault, 'subscribe', endpoint) }),
    });
    const envelope = await encryptMessage(vault, {
      v: 1,
      kind: 'text',
      text: 'server cannot put this in push',
      sentAt: new Date().toISOString(),
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanup.unshift(async () => socket.close());
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'auth', roomId: room.roomId, accessToken: creatorToken,
      deviceId: creatorIdentity.publicBundle.deviceId, afterSeq: 0, afterReceiptSeq: 0,
    }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for ready')), 3000);
      socket.on('message', (raw) => {
        if (JSON.parse(raw.toString()).type !== 'ready') return;
        clearTimeout(timer);
        resolve();
      });
    });
    socket.send(JSON.stringify({ type: 'send', envelope }));
    for (let attempt = 0; attempt < 30 && wakes.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(wakes).toEqual([expect.objectContaining({ endpoint, deviceId: joinerIdentity.publicBundle.deviceId })]);

    socket.send(JSON.stringify({ type: 'send', envelope }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wakes).toHaveLength(1);
  }, 20_000);
});
