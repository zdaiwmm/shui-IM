/** Isolated synthetic lifecycle regression. No production endpoints or data. */
import { it, expect, vi } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { generateIdentity, createJoinProof, verifyJoinProof, bundleFingerprint } from '../src/lib/crypto';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, encryptMlsApplication, decryptMlsApplication } from '../src/lib/mls';
import { randomBase64Url } from '../src/lib/base64';
import type { Vault } from '../src/lib/types';

async function runLifecycle(mode: 'normal' | 'renew' | 'deadline') {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chamber-audit-lifecycle-'));
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1', quiet: true });
  let pending: http.ClientRequest | undefined;
  try {
    const [creator, candidate] = await Promise.all([generateIdentity(), generateIdentity()]);
    const creatorToken = randomBase64Url(32), candidateToken = randomBase64Url(32);
    const oldInvite = randomBase64Url(32), nextInvite = randomBase64Url(32), pairingSecret = randomBase64Url(32);
    const caps = ['room-archive-v2'];
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (suffix: string, token: string, body: unknown) => {
      const response = await fetch(base + suffix, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json(); expect(response.ok).toBe(true); return value;
    };
    const { roomId } = await post('/api/rooms', '', { creatorBundle: creator.publicBundle, accessToken: creatorToken, inviteToken: oldInvite, capabilities: caps });
    const proof = await createJoinProof(pairingSecret, candidate.publicBundle);
    const body = JSON.stringify({ bundle: candidate.publicBundle, proof, deviceAccessToken: candidateToken, capabilities: caps });
    let reached!: () => void;
    const admitted = new Promise<void>(resolve => { reached = resolve; });
    const original = server.store.authenticateInvite.bind(server.store);
    server.store.authenticateInvite = (id: string, token: string) => {
      const result = original(id, token);
      if (id === roomId && token === oldInvite && result) reached();
      return result;
    };
    const completed = new Promise<{ status: number; state: any }>((resolve, reject) => {
      pending = http.request(`${base}/api/rooms/${roomId}/join`, { method: 'POST', headers: {
        Authorization: `Bearer ${oldInvite}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode!, state: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      pending.on('error', reject);
      pending.flushHeaders(); pending.write(body.slice(0, 1));
    });
    await Promise.race([admitted, new Promise((_, reject) => setTimeout(() => reject(new Error('admission barrier timeout')), 3000).unref())]);
    expect(original(roomId, oldInvite)).toBe(true);
    if (mode === 'renew') {
      await post(`/api/rooms/${roomId}/new-invitation`, creatorToken, { previousToken: oldInvite, token: nextInvite });
      expect(original(roomId, oldInvite)).toBe(false);
      expect(original(roomId, nextInvite)).toBe(true);
    } else if (mode === 'deadline') {
      const deadline = Date.parse(server.store.roomState(roomId).invitationExpiresAt);
      vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      expect(original(roomId, oldInvite)).toBe(false);
    }
    pending!.end(body.slice(1));
    const result = await completed;
    // A normal join is the control. Rotation/expiry between request admission
    // and transaction commit must reject without sealing or adding a member.
    if (mode !== 'normal') {
      expect(result.status).toBe(401);
      expect(server.store.roomState(roomId).members).toHaveLength(1);
      expect(server.store.roomState(roomId).sealedAt).toBeNull();
      return;
    }
    expect(result.status).toBe(201);
    expect(result.state.members.filter((m: any) => m.status === 'active')).toHaveLength(2);
    const member = result.state.members.find((m: any) => m.deviceId === candidate.publicBundle.deviceId);
    expect(member.role).toBe('joiner');
    expect(await verifyJoinProof(pairingSecret, candidate.publicBundle, member.joinProof)).toBe(true);
    const members = result.state.members;
    const common = { v: 3 as const, roomId, pairingSecret, creatorFingerprint: await bundleFingerprint(creator.publicBundle), members,
      lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const };
    const sender: Vault = { ...common, identity: creator, role: 'creator', accessToken: creatorToken,
      mls: await createCreatorMlsState(roomId, creator, members) };
    sender.mls = await prepareCreatorWelcome(sender);
    expect(sender.mls.pendingWelcome).toBeDefined();
    server.store.saveMlsWelcome(roomId, sender.mls.pendingWelcome);
    const receiver: Vault = { ...common, identity: candidate, role: 'joiner', accessToken: candidateToken,
      mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
    receiver.mls = await joinMlsGroup(receiver, sender.mls.pendingWelcome!);
    const encrypted = await encryptMlsApplication(sender, { v: 1, kind: 'text', text: 'synthetic future message', sentAt: new Date().toISOString() }, crypto.randomUUID());
    expect((await decryptMlsApplication(receiver, encrypted.envelope)).payload).toMatchObject({ text: 'synthetic future message' });
    console.log(JSON.stringify({ reproduction: 'capability-lifecycle', mode, invalidAtCommit: mode !== 'normal', httpStatus: result.status,
      activeRoles: members.map((m: any) => m.role).sort(), originalProofStillValid: true, realMlsFutureMessageReadable: true }));
  } finally {
    vi.restoreAllMocks(); pending?.destroy(); await server.close(); await rm(dataDir, { recursive: true, force: true });
  }
}
for (const mode of ['normal', 'renew', 'deadline'] as const) it(`fences invitation lifecycle at commit: ${mode}`, () => runLifecycle(mode), 20_000);
