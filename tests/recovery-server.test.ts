import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../server/index.mjs';
import { randomBase64Url } from '../src/lib/base64';
import { bundleFingerprint, generateIdentity } from '../src/lib/crypto';
import { createPushAuthorization } from '../src/lib/push';
import {
  createCreatorMlsState, createRecoveryRequest, decryptMlsApplication, encryptMlsApplication,
  joinMlsGroup, joinMlsMembership, prepareCreatorWelcome, prepareMlsRecoveryReplacement,
} from '../src/lib/mls';
import type { Vault } from '../src/lib/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-recovery-server-'));
  let server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  cleanups.push(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const [sourceIdentity, helperIdentity, freshIdentity] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
  const capabilities = ['recovery-replace-v1'];
  const sourceToken = randomBase64Url(32), helperToken = randomBase64Url(32), freshToken = randomBase64Url(32);
  const room = server.store.createRoom(sourceIdentity.publicBundle, sourceToken, randomBase64Url(32), '原设备', capabilities);
  const state = server.store.joinRoom(room.roomId, helperIdentity.publicBundle, 'test-proof', helperToken, '对方', capabilities);
  const common = {
    v: 3 as const, roomId: room.roomId, pairingSecret: randomBase64Url(32),
    creatorFingerprint: await bundleFingerprint(sourceIdentity.publicBundle), members: state.members,
    lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const,
  };
  const source: Vault = { ...common, identity: sourceIdentity, role: 'creator', accessToken: sourceToken,
    mls: await createCreatorMlsState(room.roomId, sourceIdentity, state.members) };
  source.mls = await prepareCreatorWelcome(source);
  server.store.saveMlsWelcome(room.roomId, source.mls.pendingWelcome);
  const helper: Vault = { ...common, identity: helperIdentity, role: 'joiner', accessToken: helperToken,
    mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
  helper.mls = await joinMlsGroup(helper, source.mls.pendingWelcome!);
  source.mls.pendingWelcome = undefined;
  const base = `http://127.0.0.1:${server.port}/api/rooms/${room.roomId}`;
  const post = async (proof: unknown, token = freshToken) => fetch(`${base}/recovery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: proof, accessToken: token, deviceName: '恢复设备', capabilities }),
  });
  const restart = async () => {
    const port = server.port;
    await server.close();
    server = await startServer({ port, host: '127.0.0.1', dataDir, quiet: true });
    return server;
  };
  return { server, source, helper, freshIdentity, freshToken, capabilities, base, post, restart };
}

describe('authenticated recovery replaces the old MLS identity', () => {
  it('recovers after later messages without reusing checkpoint ratchets, fences old tokens and enforces the new history boundary', async () => {
    let { server, source, helper, freshIdentity, freshToken, base, post, restart } = await setup();
    const checkpoint = structuredClone(source);
    const payload = { v: 1 as const, kind: 'text' as const, text: 'sent after backup', sentAt: new Date().toISOString() };
    const later = await encryptMlsApplication(source, payload, crypto.randomUUID());
    source.mls!.groupState = later.nextGroupState;
    helper.mls!.groupState = (await decryptMlsApplication(helper, later.envelope)).nextGroupState;
    server.store.insertMessage(source.roomId, later.envelope);
    // This unsent ciphertext is absent from both backup and server. Recovery
    // must use a fresh identity/epoch, not try to infer the old send ratchet.
    const unsent = await encryptMlsApplication(source, { ...payload, text: 'not stored on server' }, crypto.randomUUID());
    const proof = await createRecoveryRequest(checkpoint, freshIdentity.publicBundle, freshToken);
    const submitted = await post(proof);
    expect(submitted.status).toBe(200);
    const pending = (await submitted.json()).state;
    expect(pending.recoveryRequests).toHaveLength(1);
    server = await restart();
    expect((await fetch(`${base}/recovery/${proof.requestId}`, { headers: { Authorization: `Bearer ${freshToken}` } })).status).toBe(200);
    expect(server.store.authenticatedDevice(source.roomId, source.accessToken)).toBeNull();
    expect(() => server.store.insertMessage(source.roomId, unsent.envelope)).toThrow('UNAUTHORIZED');
    expect((await fetch(`${base}/recovery/${proof.requestId}`, { headers: { Authorization: `Bearer ${randomBase64Url(32)}` } })).status).toBe(401);
    expect((await fetch(base, { headers: { Authorization: `Bearer ${freshToken}` } })).status).toBe(401);
    expect((await post(proof)).status).toBe(200); // Lost response can be retried.

    helper.members = pending.members;
    const target = pending.members.find((member: { deviceId: string }) => member.deviceId === freshIdentity.publicBundle.deviceId);
    const replacement = await prepareMlsRecoveryReplacement(helper, proof, target);
    const committed = await fetch(`${base}/mls-events`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${helper.accessToken}` },
      body: JSON.stringify({ event: replacement.event }),
    });
    expect(committed.status).toBe(200);
    const completed = (await committed.json()).state;
    server = await restart();
    expect(completed.recoveryRequests).toHaveLength(0);
    expect(completed.members.find((member: { deviceId: string }) => member.deviceId === source.identity.publicBundle.deviceId).status).toBe('revoked');
    expect(server.store.authenticatedDevice(source.roomId, source.accessToken)).toBeNull();
    expect(server.store.authenticatedDevice(source.roomId, freshToken)?.deviceId).toBe(freshIdentity.publicBundle.deviceId);
    expect(server.store.messagesAfter(source.roomId, 0, 500, freshIdentity.publicBundle.deviceId)).toHaveLength(0);
    expect((await post(proof)).status).toBe(200); // Completed request is idempotent, not a second replacement.
    expect((await fetch(`${base}/recovery/${proof.requestId}`, { headers: { Authorization: `Bearer ${freshToken}` } })).status).toBe(200);

    helper.mls = { ...helper.mls!, groupState: replacement.nextGroupState, lastEventSeq: 1 };
    helper.members = completed.members;
    const restored: Vault = { ...checkpoint, identity: freshIdentity, accessToken: freshToken, members: completed.members,
      lastSeq: 1, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
    restored.mls = await joinMlsMembership(restored, replacement.event, 1);
    const freshMessage = await encryptMlsApplication(restored, { ...payload, text: 'new identity works' }, crypto.randomUUID());
    const received = await decryptMlsApplication(helper, freshMessage.envelope);
    expect(received.payload).toMatchObject({ text: 'new identity works' });
    await expect(decryptMlsApplication(checkpoint, freshMessage.envelope)).rejects.toThrow();

    // Replacing this device again must revoke its completed recovery-status
    // credential too, including replay of its original correctly signed proof.
    helper.mls.groupState = received.nextGroupState;
    const nextIdentity = await generateIdentity();
    const nextToken = randomBase64Url(32);
    const nextProof = await createRecoveryRequest(restored, nextIdentity.publicBundle, nextToken);
    const nextPending = (await (await post(nextProof, nextToken)).json()).state;
    helper.members = nextPending.members;
    const nextTarget = nextPending.members.find((member: { deviceId: string }) => member.deviceId === nextIdentity.publicBundle.deviceId);
    const nextReplacement = await prepareMlsRecoveryReplacement(helper, nextProof, nextTarget);
    expect((await fetch(`${base}/mls-events`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${helper.accessToken}` },
      body: JSON.stringify({ event: nextReplacement.event }),
    })).status).toBe(200);
    expect((await fetch(`${base}/recovery/${proof.requestId}`, { headers: { Authorization: `Bearer ${freshToken}` } })).status).toBe(401);
    expect((await post(proof)).status).toBe(401);
  });

  it('rejects forged bindings, wrong tokens, incompatible helpers and competing recovery requests before fencing any additional device', async () => {
    const { server, source, helper, freshIdentity, freshToken, capabilities, post } = await setup();
    const proof = await createRecoveryRequest(source, freshIdentity.publicBundle, freshToken);
    expect((await post({ ...proof, sourceDeviceId: helper.identity.publicBundle.deviceId })).status).toBe(400);
    expect((await post(proof, randomBase64Url(32))).status).toBe(400);
    server.store.updateMemberCapabilities(source.roomId, helper.identity.publicBundle.deviceId, []);
    expect((await post(proof)).status).toBe(409);
    expect(server.store.authenticatedDevice(source.roomId, source.accessToken)).not.toBeNull();
    server.store.updateMemberCapabilities(source.roomId, helper.identity.publicBundle.deviceId, capabilities);
    expect((await post(proof)).status).toBe(200);
    const otherIdentity = await generateIdentity();
    const competing = await createRecoveryRequest(helper, otherIdentity.publicBundle, freshToken);
    expect((await post(competing)).status).toBe(409);
    expect(server.store.authenticatedDevice(source.roomId, helper.accessToken)).not.toBeNull();
  });

  it('rejects noncanonical expiry and removes an expired replacement before restoring source access', async () => {
    const { server, source, freshIdentity, freshToken, base, post } = await setup();
    const proof = await createRecoveryRequest(source, freshIdentity.publicBundle, freshToken);
    // The store is also a boundary: equivalent +00:00 and malformed dates
    // must not enter fields queried with lexicographic UTC comparisons.
    for (const expiresAt of [proof.expiresAt.replace('Z', '+00:00'), 'not-a-date']) {
      expect(() => server.store.createRecoveryRequest(source.roomId, { ...proof, expiresAt }, freshToken, '恢复设备', ['recovery-replace-v1']))
        .toThrow('INVALID_RECOVERY_REQUEST');
      expect((await post({ ...proof, expiresAt })).status).toBe(400);
    }
    expect((await post(proof)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(proof.expiresAt) + 1));
    expect((await fetch(`${base}/recovery/${proof.requestId}`, { headers: { Authorization: `Bearer ${freshToken}` } })).status).toBe(410);
    expect(server.store.getMember(source.roomId, freshIdentity.publicBundle.deviceId)).toBeNull();
    expect(server.store.authenticatedDevice(source.roomId, source.accessToken)).not.toBeNull();
    expect((await post(proof)).status).toBe(400);
  });

  it('fences slow HTTP bodies, queued blob writes, push changes and old device links at their mutation boundaries', async () => {
    const { server, source, helper, freshIdentity, freshToken, base, post } = await setup();
    const sourceId = source.identity.publicBundle.deviceId;
    const roomId = source.roomId;
    const chunk = new Uint8Array(32);
    const blobId = crypto.randomUUID();
    const completeId = crypto.randomUUID();
    server.store.createBlob(roomId, blobId, 1, chunk.length, sourceId);
    server.store.createBlob(roomId, completeId, 1, chunk.length, sourceId);
    await server.store.putBlobChunk(roomId, completeId, 0, chunk, sourceId);
    const linkId = crypto.randomUUID(), linkSecret = randomBase64Url(32);
    server.store.createDeviceLink(roomId, sourceId, linkId, linkSecret, new Date(Date.now() + 60_000).toISOString());
    const subscription = { endpoint: 'https://fcm.googleapis.com/subscription/fenced', keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) } };
    server.store.savePushSubscription(roomId, sourceId, subscription);
    const reservedId = crypto.randomUUID();
    const bodies = [
      { url: `${base}/blobs`, method: 'POST', body: JSON.stringify({ blobId: reservedId, chunkCount: 1, encryptedSize: 32 }) },
      { url: `${base}/device-links`, method: 'POST', body: JSON.stringify({ authorizerId: sourceId, linkId: crypto.randomUUID(), secret: randomBase64Url(32), expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
      { url: `${base}/blobs/${blobId}/chunks/0`, method: 'PUT', body: Buffer.from(chunk) },
      { url: `${base}/push/${sourceId}`, method: 'DELETE', body: JSON.stringify({ authorization: await createPushAuthorization(source, 'unsubscribe', subscription.endpoint) }) },
    ];
    let initialChecks = 0;
    let allAuthenticated!: () => void;
    const initialAuth = new Promise<void>((resolve) => { allAuthenticated = resolve; });
    const originalAuth = server.store.authenticatedDevice;
    vi.spyOn(server.store, 'authenticatedDevice').mockImplementation((...args: unknown[]) => {
      const result = originalAuth(...args);
      if (args[1] === source.accessToken && ++initialChecks === bodies.length) allAuthenticated();
      return result;
    });
    const delayed = bodies.map(({ url, method, body }) => {
      let finish!: (status: number) => void;
      const response = new Promise<number>((resolve) => { finish = resolve; });
      const request = httpRequest(url, { method, headers: { Authorization: `Bearer ${source.accessToken}`, 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json' } }, (incoming) => { incoming.resume(); incoming.on('end', () => finish(incoming.statusCode ?? 0)); });
      request.flushHeaders();
      return { request, body, response };
    });
    await initialAuth;
    const proof = await createRecoveryRequest(source, freshIdentity.publicBundle, freshToken);
    // Queue work, then fence synchronously before the per-blob queue starts.
    const queuedWrite = server.store.putBlobChunk(roomId, blobId, 0, chunk, sourceId).catch((error: Error) => error.message);
    const queuedComplete = server.store.completeBlob(roomId, completeId, sourceId).catch((error: Error) => error.message);
    server.store.createRecoveryRequest(roomId, proof, freshToken, '恢复设备', ['recovery-replace-v1']);
    expect(await queuedWrite).toBe('UNAUTHORIZED');
    expect(await queuedComplete).toBe('UNAUTHORIZED');
    for (const delayedRequest of delayed) delayedRequest.request.end(delayedRequest.body);
    expect(await Promise.all(delayed.map((entry) => entry.response))).toEqual([401, 401, 401, 401]);
    expect(() => server.store.blobStatus(roomId, reservedId)).toThrow('INVALID_BLOB');
    expect(server.store.blobStatus(roomId, blobId).uploadedIndexes).toEqual([]);
    expect(server.store.blobStatus(roomId, completeId).completed).toBe(false);
    expect(() => server.store.createBlob(roomId, crypto.randomUUID(), 1, 32, sourceId)).toThrow('UNAUTHORIZED');
    expect(() => server.store.createBlob(roomId, crypto.randomUUID(), 1, 32)).toThrow('UNAUTHORIZED');
    expect(() => server.store.updateMemberCapabilities(roomId, sourceId, [])).toThrow('UNAUTHORIZED');
    expect(() => server.store.savePushSubscription(roomId, sourceId, subscription)).toThrow('UNAUTHORIZED');
    expect(() => server.store.deletePushSubscription(roomId, sourceId)).toThrow('UNAUTHORIZED');
    expect(server.store.pushSubscriptionsForRoom(roomId, helper.identity.publicBundle.deviceId)).toHaveLength(1);
    const extraIdentity = await generateIdentity();
    expect(() => server.store.claimDeviceLink(linkId, linkSecret, extraIdentity.publicBundle, randomBase64Url(32), '旧邀请', ['recovery-replace-v1'])).toThrow('UNAUTHORIZED');
    expect(() => server.store.deviceLinkStatus(linkId, linkSecret)).toThrow('UNAUTHORIZED');
    expect(server.store.authenticatedDevice(roomId, helper.accessToken)).not.toBeNull();
    expect((await post(proof)).status).toBe(200);
  });
});
