import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { generateIdentity, createJoinProof, bundleFingerprint } from '../src/lib/crypto';
import { bindPersonalDevice } from '../src/lib/personal-device-binding';
import { signPersonalProof } from '../src/lib/personal-identity';
import { personalHash } from '../server/personal-protocol.mjs';
import { randomBase64Url } from '../src/lib/base64';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, createRecoveryRequest, prepareMlsRecoveryReplacement } from '../src/lib/mls';
import type { Vault } from '../src/lib/types';

async function request(base: string, route: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(base + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}

describe('challenge issuance and initial join authorization regressions', () => {
  it('preserves retries for legacy joins that originally used the invite as their device credential', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'join-legacy-token-'));
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
    try {
      const [a, b] = await Promise.all([generateIdentity(), generateIdentity()]);
      const invite = randomBase64Url(32);
      const room = server.store.createRoom(a.publicBundle, randomBase64Url(32), invite);
      const first = server.store.joinRoom(room.roomId, b.publicBundle, 'synthetic-proof');
      expect(server.store.joinRoom(room.roomId, b.publicBundle, 'synthetic-proof').members).toEqual(first.members);
      expect(server.store.joinRoom(room.roomId, b.publicBundle, 'synthetic-proof', invite).members).toEqual(first.members);
      expect(() => server.store.joinRoom(room.roomId, b.publicBundle, 'synthetic-proof', randomBase64Url(32))).toThrow('UNAUTHORIZED');
      expect(server.store.roomState(room.roomId).members).toHaveLength(2);
    } finally { await server.close(); await rm(dataDir, { recursive: true, force: true }); }
  });

  it('anonymous challenge traffic cannot block a fresh legitimate proof, including across restart', async () => {
    for (let repetition = 0; repetition < 1; repetition++) {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'audit2-challenges-'));
      let server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
      let db: DatabaseSync | undefined;
      try {
        let base = `http://127.0.0.1:${server.port}`;
        const entropy = new Uint8Array(16).fill(41), otherEntropy = new Uint8Array(16).fill(42);
        const [victim, other] = await Promise.all([generateIdentity(), generateIdentity()]);
        const [binding, otherBinding] = await Promise.all([bindPersonalDevice(entropy, victim), bindPersonalDevice(otherEntropy, other)]);
        for (const [device, personalBinding] of [[victim, binding], [other, otherBinding]] as const) {
          const created = await request(base, '/api/rooms', 'POST', { creatorBundle: device.publicBundle, accessToken: randomBase64Url(32), inviteToken: randomBase64Url(32), personalBinding, deviceName: 'Synthetic audit identity' });
          expect(created.status).toBe(201);
        }
        const route = `/api/chamber/identities/${binding.identity.id}`;
        const input = { action: 'read-directory', roomId: 'directory', deviceId: victim.publicBundle.deviceId, version: 1, payloadHash: personalHash({ purpose: 'synthetic-directory-read' }) };
        const first = await request(base, route + '/challenge', 'POST', input);
        expect(first.status).toBe(200);
        const signature = await signPersonalProof(entropy, first.body);
        expect((await request(base, route + '/directory', 'POST', { proof: first.body, signature })).status).toBe(200);
        const reserved = await request(base, route + '/challenge', 'POST', input);
        const reservedSignature = await signPersonalProof(entropy, reserved.body);
        
        for (let n = 0; n < 19; n++) {
          const anonymous = await request(base, route + '/challenge', 'POST', { ...input, deviceId: crypto.randomUUID() });
          expect(anonymous.status).toBe(200);
        }
        expect((await request(base, route + '/challenge', 'POST', input)).status).toBe(200);
        const unrelated = await request(base, `/api/chamber/identities/${otherBinding.identity.id}/challenge`, 'POST', { ...input, deviceId: other.publicBundle.deviceId });
        expect(unrelated.status).toBe(200);
        // Issuance does not evict an earlier proof or reserve durable slots.
        expect((await request(base, route + '/directory', 'POST', { proof: reserved.body, signature: reservedSignature })).status).toBe(200);
        expect((await request(base, route + '/challenge', 'POST', input)).status).toBe(200);
        expect((await request(base, route + '/challenge', 'POST', input)).status).toBe(200);
        db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'), { readOnly: true });
        const rows = db.prepare('SELECT COUNT(*) AS n, MAX(expires_at) AS expiry FROM chamber_challenges WHERE identity_id=? AND consumed=0').get(binding.identity.id) as { n: number; expiry: string | null };
        expect(rows.n).toBe(0); db.close(); db = undefined;
        await server.close();
        server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
        base = `http://127.0.0.1:${server.port}`;
        const afterRestart = await request(base, route + '/challenge', 'POST', input);
        expect(afterRestart.status).toBe(200);
        expect((await request(base, `/api/chamber/identities/${otherBinding.identity.id}/challenge`, 'POST', input)).status).toBe(200);
        // Advance Date only to classify the persisted deadline; no change to
        // authorization, quotas, routes, SQL or cryptographic validation.
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(first.body.expiresAt) + 1);
        const afterDeadline = await request(base, route + '/challenge', 'POST', input);
        expect(afterDeadline.status).toBe(200); vi.useRealTimers();

      } finally { vi.useRealTimers(); db?.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); }
    }
  });

  it('exact join retries require the active original token and obey recovery fencing and revocation', async () => {
    for (let repetition = 0; repetition < 1; repetition++) {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'audit2-join-replay-'));
      let server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
      try {
        let base = `http://127.0.0.1:${server.port}`;
        const [a, b, freshB] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
        const [aToken, bToken, freshToken, invite, pairing] = Array.from({ length: 5 }, () => randomBase64Url(32));
        const capabilities = ['recovery-replace-v1'];
        const created = await request(base, '/api/rooms', 'POST', { creatorBundle: a.publicBundle, accessToken: aToken, inviteToken: invite, deviceName: 'A', capabilities });
        expect(created.status).toBe(201); const roomId = created.body.roomId, route = `/api/rooms/${roomId}`;
        const proof = await createJoinProof(pairing, b.publicBundle);
        const joinInput = { bundle: b.publicBundle, proof, deviceAccessToken: bToken, deviceName: 'Original B', capabilities };
        const joined = await request(base, route + '/join', 'POST', joinInput, invite);
        expect(joined.status).toBe(201);
        expect((await request(base, route + '/join', 'POST', joinInput, invite)).status).toBe(201);
        expect((await request(base, route + '/join', 'POST', { ...joinInput, deviceAccessToken: randomBase64Url(32) }, invite)).status).toBe(401);
        const { deviceAccessToken: _token, ...missingToken } = joinInput;
        expect((await request(base, route + '/join', 'POST', missingToken, invite)).status).toBe(401);
        const common = { v: 3 as const, roomId, pairingSecret: pairing, creatorFingerprint: await bundleFingerprint(a.publicBundle), members: joined.body.members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const };
        const creator: Vault = { ...common, identity: a, role: 'creator', accessToken: aToken, mls: await createCreatorMlsState(roomId, a, common.members) };
        creator.mls = await prepareCreatorWelcome(creator);
        expect((await request(base, route + '/mls-welcome', 'PUT', { welcome: creator.mls.pendingWelcome }, aToken)).status).toBe(200);
        const oldJoiner: Vault = { ...common, identity: b, role: 'joiner', accessToken: bToken, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
        oldJoiner.mls = await joinMlsGroup(oldJoiner, creator.mls.pendingWelcome!);
        const recovery = await createRecoveryRequest(oldJoiner, freshB.publicBundle, freshToken);
        const pending = await request(base, route + '/recovery', 'POST', { request: recovery, accessToken: freshToken, deviceName: 'Synthetic replacement B', capabilities });
        expect(pending.status).toBe(200);
        expect((await request(base, route + '/join', 'POST', joinInput, invite)).status).toBe(401);
        creator.members = pending.body.state.members;
        const target = creator.members.find(member => member.deviceId === freshB.publicBundle.deviceId)!;
        const replacement = await prepareMlsRecoveryReplacement(creator, recovery, target);
        expect((await request(base, route + '/mls-events', 'PUT', { event: replacement.event }, aToken)).status).toBe(200);
        expect(server.store.getMember(roomId, b.publicBundle.deviceId)?.status).toBe('revoked');
        expect((await request(base, route, 'GET', undefined, bToken)).status).toBe(401);
        expect((await request(base, route, 'GET', undefined, invite)).status).toBe(401);
        expect((await request(base, route + '/join', 'POST', joinInput, randomBase64Url(32))).status).toBe(401);
        expect((await request(base, route + '/join', 'POST', { ...joinInput, proof: 'wrong-proof' }, invite)).status).toBe(409);
        const replayInput = { ...joinInput, deviceAccessToken: randomBase64Url(32) };
        const replay = await request(base, route + '/join', 'POST', replayInput, invite);
        expect(replay.status).toBe(401);
        expect(replay.body.members).toBeUndefined();
        expect((await request(base, route + '/join', 'POST', joinInput, invite)).status).toBe(401);
        await server.close(); server = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true }); base = `http://127.0.0.1:${server.port}`;
        const restarted = await request(base, route + '/join', 'POST', replayInput, invite);
        expect(restarted.status).toBe(401);
        expect((await request(base, route, 'GET', undefined, bToken)).status).toBe(401);
        expect(server.store.getMember(roomId, b.publicBundle.deviceId)?.status).toBe('revoked');

      } finally { await server.close(); await rm(dataDir, { recursive: true, force: true }); }
    }
  });
});
