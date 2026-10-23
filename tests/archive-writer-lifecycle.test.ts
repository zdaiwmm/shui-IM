/** Local HTTP regressions using the production createStore authorization dependency. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { randomBase64Url } from '../src/lib/base64';
import { bundleFingerprint, createJoinProof, generateIdentity } from '../src/lib/crypto';
import { createCreatorMlsState, createRecoveryRequest, joinMlsGroup, prepareCreatorWelcome,
  prepareMlsRecoveryReplacement } from '../src/lib/mls';
import { archiveAccessHash, archiveAccessProof, archiveAccessToken, archiveWriterProof,
  newArchiveKey, sealArchiveObject } from '../src/lib/room-archive-crypto';
import type { Vault } from '../src/lib/types';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-archive-writer-lifecycle-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  const base = `http://127.0.0.1:${server.port}`;
  const json = async (route: string, token: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + route, { method, headers: {
      Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  return { dataDir, server, base, json,
    close: async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

async function joinedRoom(f: Awaited<ReturnType<typeof fixture>>) {
  const [creator, peer, replacement] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
  const creatorToken = randomBase64Url(32), peerToken = randomBase64Url(32), replacementToken = randomBase64Url(32);
  const invite = randomBase64Url(32), pairingSecret = randomBase64Url(32);
  const capabilities = ['room-archive-v2', 'recovery-replace-v1'];
  const created = await f.json('/api/rooms', '', 'POST', {
    creatorBundle: creator.publicBundle, accessToken: creatorToken, inviteToken: invite, capabilities,
  });
  expect(created.status).toBe(201);
  const roomId = created.body.roomId as string, route = `/api/rooms/${roomId}`;
  const proof = await createJoinProof(pairingSecret, peer.publicBundle);
  const joined = await f.json(`${route}/join`, invite, 'POST', {
    bundle: peer.publicBundle, proof, deviceAccessToken: peerToken, capabilities,
  });
  expect(joined.status).toBe(201);
  const common = { v: 3 as const, roomId, pairingSecret, members: joined.body.members,
    creatorFingerprint: await bundleFingerprint(creator.publicBundle), lastSeq: 0,
    protocol: 'mls-rfc9420' as const, createdAt: new Date().toISOString() };
  const source: Vault = { ...common, identity: creator, accessToken: creatorToken, role: 'creator',
    mls: await createCreatorMlsState(roomId, creator, joined.body.members) };
  source.mls = await prepareCreatorWelcome(source);
  const welcome = source.mls.pendingWelcome!;
  expect((await f.json(`${route}/mls-welcome`, creatorToken, 'PUT', { welcome })).status).toBe(200);
  const helper: Vault = { ...common, identity: peer, accessToken: peerToken, role: 'joiner',
    mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
  helper.mls = await joinMlsGroup(helper, welcome);
  source.mls.pendingWelcome = undefined;
  return { roomId, route, source, helper, replacement, replacementToken, capabilities };
}

function archiveRows(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'), { readOnly: true });
  try {
    return {
      writers: db.prepare('SELECT id,room_id,device_id,owner_role,descriptor FROM private_archives_v2 ORDER BY id').all(),
      access: db.prepare('SELECT archive_id,read_hash FROM private_archive_access_v2 ORDER BY archive_id').all(),
      objects: db.prepare('SELECT archive_id,id,record,bytes FROM private_archive_objects_v2 ORDER BY archive_id,id').all(),
    };
  } finally { db.close(); }
}

describe('private archive HTTP writer authorization at commit', () => {
  for (const mode of ['recovery-fenced', 'revoked'] as const) {
    it(`rejects admitted register, append and access rotation after the writer is ${mode}`, async () => {
      const f = await fixture();
      const requests: ClientRequest[] = [];
      try {
        const { roomId, route, source, helper, replacement, replacementToken, capabilities } = await joinedRoom(f);
        const sourceId = source.identity.publicBundle.deviceId;
        const key = newArchiveKey(), newRegistration = newArchiveKey();
        const archiveRoute = `${route}/private-archives/${key.descriptor.id}`;
        const registration = { descriptor: key.descriptor, proof: archiveWriterProof(key, roomId, sourceId) };
        expect((await f.json(archiveRoute, source.accessToken, 'PUT', registration)).status).toBe(200);
        const keep = await sealArchiveObject(key, { text: 'retained synthetic original' });
        expect((await f.json(`${archiveRoute}/${keep.id}`, source.accessToken, 'PUT', keep)).status).toBe(200);
        // Start from an already rotated capability; no failed request may restore the seed-derived old one.
        const originalRead = archiveAccessToken(key), currentRead = randomBase64Url(32);
        const currentHash = archiveAccessHash(currentRead);
        expect((await f.json(`${archiveRoute}/access`, source.accessToken, 'PUT', {
          expected: archiveAccessHash(originalRead), next: currentHash,
          proof: archiveAccessProof(key, roomId, sourceId, archiveAccessHash(originalRead), currentHash),
        })).status).toBe(200);
        const before = archiveRows(f.dataDir);
        const extra = await sealArchiveObject(key, { text: 'must not be appended by a stale writer' });
        const nextHash = archiveAccessHash(randomBase64Url(32));
        const operations = [
          { route: `${route}/private-archives/${newRegistration.descriptor.id}`, body: {
            descriptor: newRegistration.descriptor, proof: archiveWriterProof(newRegistration, roomId, sourceId),
          } },
          { route: `${archiveRoute}/${extra.id}`, body: extra },
          { route: `${archiveRoute}/access`, body: { expected: currentHash, next: nextHash,
            proof: archiveAccessProof(key, roomId, sourceId, currentHash, nextHash) } },
          // In the revoked case, hold one additional rebind until the new writer has registered.
          ...(mode === 'revoked' ? [{ route: archiveRoute, body: registration }] : []),
        ];
        let authenticated = 0, releaseBarrier!: () => void;
        const allAdmitted = new Promise<void>(resolve => { releaseBarrier = resolve; });
        const actualAuthenticate = f.server.store.authenticatedDevice.bind(f.server.store);
        vi.spyOn(f.server.store, 'authenticatedDevice').mockImplementation((...args: unknown[]) => {
          const member = actualAuthenticate(...args);
          // Observe the real result only; the production archive callback is never replaced.
          if (args[0] === roomId && args[1] === source.accessToken && member && ++authenticated === operations.length) releaseBarrier();
          return member;
        });
        const delayed = operations.map(operation => {
          const body = JSON.stringify(operation.body);
          const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
            const request = httpRequest(f.base + operation.route, { method: 'PUT', headers: {
              Authorization: `Bearer ${source.accessToken}`, 'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            } }, incoming => {
              const chunks: Buffer[] = [];
              incoming.on('data', chunk => chunks.push(chunk));
              incoming.on('error', reject);
              incoming.on('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
            });
            requests.push(request); request.on('error', reject);
            request.flushHeaders(); request.write(body.slice(0, 1));
          });
          void response.catch(() => undefined);
          return { request: requests.at(-1)!, body, response };
        });
        await Promise.race([allAdmitted, new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Archive admission barrier timed out')), 3000).unref();
        })]);
        expect(authenticated).toBe(operations.length);
        const proof = await createRecoveryRequest(source, replacement.publicBundle, replacementToken);
        const pending = await f.json(`${route}/recovery`, '', 'POST', {
          request: proof, accessToken: replacementToken, deviceName: 'Synthetic replacement', capabilities,
        });
        expect(pending.status).toBe(200);
        expect(f.server.store.deviceRecoveryPending(roomId, sourceId)).toBe(true);
        expect(f.server.store.authenticatedDevice(roomId, source.accessToken)).toBeNull();
        if (mode === 'revoked') {
          helper.members = pending.body.state.members;
          const target = helper.members.find(member => member.deviceId === replacement.publicBundle.deviceId)!;
          const prepared = await prepareMlsRecoveryReplacement(helper, proof, target);
          expect((await f.json(`${route}/mls-events`, helper.accessToken, 'PUT', { event: prepared.event })).status).toBe(200);
          expect(f.server.store.getMember(roomId, sourceId)?.status).toBe('revoked');
          expect(f.server.store.deviceRecoveryPending(roomId, sourceId)).toBe(false);
        } else {
          // A still-active row with a pending recovery must be fenced just like a revoked row.
          expect(f.server.store.getMember(roomId, sourceId)?.status).toBe('active');
        }
        for (const item of delayed.slice(0, 3)) item.request.end(item.body.slice(1));
        for (const item of delayed.slice(0, 3)) expect(await item.response).toMatchObject({ status: 401, body: { code: 'UNAUTHORIZED' } });
        expect(archiveRows(f.dataDir)).toEqual(before);
        if (mode === 'revoked') {
          const replacementId = replacement.publicBundle.deviceId;
          expect((await f.json(archiveRoute, replacementToken, 'PUT', {
            descriptor: key.descriptor, proof: archiveWriterProof(key, roomId, replacementId),
          })).status).toBe(200);
          const rebound = archiveRows(f.dataDir);
          expect(rebound.writers).toEqual(before.writers.map(row => ({ ...row, device_id: replacementId })));
          delayed[3]!.request.end(delayed[3]!.body.slice(1));
          expect(await delayed[3]!.response).toMatchObject({ status: 401, body: { code: 'UNAUTHORIZED' } });
          expect(archiveRows(f.dataDir)).toEqual(rebound);
          expect((await f.json(`${archiveRoute}/${extra.id}`, replacementToken, 'PUT', extra)).status).toBe(200);
        }
        // Card authority remains independent of live room membership and of the writer fence.
        expect((await f.json(`/api/private-archives/${key.descriptor.id}/${keep.id}`, currentRead)).body).toEqual(keep);
        expect((await f.json(`/api/private-archives/${key.descriptor.id}`, originalRead)).status).toBe(401);
        expect((await f.json(`${archiveRoute}/${extra.id}`, source.accessToken, 'PUT', extra)).status).toBe(401);
      } finally {
        for (const request of requests) request.destroy();
        vi.restoreAllMocks(); await f.close();
      }
    }, 20_000);
  }

  it('recovers a committed new-room join with the original active token after a lost response and invite expiry', async () => {
    const f = await fixture();
    let request: ClientRequest | undefined;
    try {
      const [creator, joiner] = await Promise.all([generateIdentity(), generateIdentity()]);
      const creatorToken = randomBase64Url(32), joinerToken = randomBase64Url(32), invite = randomBase64Url(32);
      const capabilities = ['room-archive-v2'];
      const created = await f.json('/api/rooms', '', 'POST', {
        creatorBundle: creator.publicBundle, accessToken: creatorToken, inviteToken: invite, capabilities,
      });
      expect(created.status).toBe(201);
      const roomId = created.body.roomId as string, route = `/api/rooms/${roomId}`;
      const proof = await createJoinProof(randomBase64Url(32), joiner.publicBundle);
      const body = { bundle: joiner.publicBundle, proof, deviceAccessToken: joinerToken, capabilities };
      // Drop the response before its JSON is consumed: the client retains only its durable original identity/token.
      const status = await new Promise<number>((resolve, reject) => {
        request = httpRequest(f.base + `${route}/join`, { method: 'POST', headers: {
          Authorization: `Bearer ${invite}`, 'Content-Type': 'application/json',
        } }, incoming => { const code = incoming.statusCode!; incoming.destroy(); resolve(code); });
        request.on('error', reject); request.end(JSON.stringify(body));
      });
      expect(status).toBe(201);
      const committed = f.server.store.roomState(roomId);
      const deadline = Date.parse(committed.invitationExpiresAt);
      vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      expect(f.server.store.authenticateInvite(roomId, invite)).toBe(false);
      expect((await f.json(`${route}/join`, invite, 'POST', body)).status).toBe(401);
      const recovered = await f.json(route, joinerToken);
      expect(recovered.status).toBe(200);
      expect(recovered.body.members).toHaveLength(2);
      expect(recovered.body.sealedAt).toBe(committed.sealedAt);
      const own = recovered.body.members.find((member: { deviceId: string }) => member.deviceId === joiner.publicBundle.deviceId);
      expect(own).toMatchObject({ ...joiner.publicBundle, role: 'joiner', status: 'active', joinProof: proof });
      expect(await bundleFingerprint({ deviceId: own.deviceId, encryptionKey: own.encryptionKey,
        signingKey: own.signingKey, mlsKeyPackage: own.mlsKeyPackage })).toBe(await bundleFingerprint(joiner.publicBundle));
      expect((await f.json(route, invite)).status).toBe(401);
      expect((await f.json(route, randomBase64Url(32))).status).toBe(401);
      expect(f.server.store.roomState(roomId).members).toHaveLength(2);
    } finally { vi.restoreAllMocks(); request?.destroy(); await f.close(); }
  }, 20_000);
});
