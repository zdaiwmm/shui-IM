import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPersonalDirectory } from '../server/personal-directory.mjs';
import { canonicalStringify } from '../server/protocol.mjs';
import { randomBase64Url } from '../src/lib/base64';
import { signPersonalProof, withPersonalKeys, type PersonalProof } from '../src/lib/personal-identity';

const entropy = new Uint8Array(16).fill(41), otherEntropy = new Uint8Array(16).fill(42);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(file = ':memory:') {
  const db = new DatabaseSync(file); cleanups.push(() => db.close());
  db.exec('CREATE TABLE IF NOT EXISTS rooms(room_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS effects(value TEXT)');
  const directory = createPersonalDirectory(db, { getMember: () => null, chamberInvitations: { state: () => null } });
  const root = await withPersonalKeys(entropy, keys => keys.publicIdentity);
  const other = await withPersonalKeys(otherEntropy, keys => keys.publicIdentity);
  directory.register(root); directory.register(other);
  const input = { action: 'read-directory', roomId: 'directory', deviceId: crypto.randomUUID(), version: 1, payloadHash: randomBase64Url(32) };
  const issue = (): PersonalProof => directory.challenge(root.id, input);
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM chamber_challenges').get() as { n: number }).n;
  return { db, directory, root, other, input, issue, count };
}

describe('anonymous challenge issuance with authenticated one-use consumption', () => {
  it('does not reserve identity or global slots and preserves concurrent outstanding proofs', async () => {
    const f = await fixture(), first = f.issue();
    const requests = new Set([first.requestId]);
    for (let i = 0; i < 10_010; i++) requests.add(f.issue().requestId);
    expect(requests.size).toBe(10_011); expect(f.count()).toBe(0);
    const last = f.issue();
    expect(f.directory.read(first, await signPersonalProof(entropy, first))).toEqual([]);
    expect(f.directory.read(last, await signPersonalProof(entropy, last))).toEqual([]);
    expect(f.count()).toBe(2);
    const other = f.directory.challenge(f.other.id, f.input);
    expect(f.directory.read(other, await signPersonalProof(otherEntropy, other))).toEqual([]);
  });

  it('binds server issuance to every scoped field even when a root signs the modified proof', async () => {
    const f = await fixture(), proof = f.issue();
    const variants: PersonalProof[] = [
      { ...proof, roomId: crypto.randomUUID() }, { ...proof, deviceId: crypto.randomUUID() },
      { ...proof, requestId: crypto.randomUUID() }, { ...proof, version: 2 },
      { ...proof, payloadHash: randomBase64Url(32) }, { ...proof, challenge: randomBase64Url(32) },
      { ...proof, action: 'close-room' }, { ...proof, expiresAt: new Date(Date.parse(proof.expiresAt) - 1000).toISOString() },
      { ...proof, identityId: f.other.id },
    ];
    for (const changed of variants) {
      const signature = await signPersonalProof(changed.identityId === f.other.id ? otherEntropy : entropy, changed);
      const effect = vi.fn();
      expect(() => f.directory.authorize(changed, signature, changed.action, effect)).toThrow('PERSONAL_PROOF_EXPIRED');
      expect(effect).not.toHaveBeenCalled();
    }
    const signature = await signPersonalProof(entropy, proof);
    expect(() => f.directory.authorize(proof, signature, 'close-room', vi.fn())).toThrow('UNAUTHORIZED');
    expect(() => f.directory.read(proof, randomBase64Url(64))).toThrow('UNAUTHORIZED');
    expect(f.count()).toBe(0); expect(f.directory.read(proof, signature)).toEqual([]);
    expect(() => f.directory.read(proof, signature)).toThrow('PERSONAL_PROOF_EXPIRED');
  });

  it('rolls back both operation and consumption on failure, including receipt persistence failure', async () => {
    const f = await fixture(), proof = f.issue(), signature = await signPersonalProof(entropy, proof);
    const effect = () => f.db.prepare('INSERT INTO effects VALUES(?)').run('synthetic');
    expect(() => f.directory.authorize(proof, signature, 'read-directory', () => { effect(); throw new Error('synthetic operation failure'); })).toThrow('synthetic operation failure');
    expect(() => f.directory.authorize(proof, signature, 'read-directory', () => { effect(); return Promise.resolve(); })).toThrow('INVALID_JSON');
    f.db.exec("CREATE TRIGGER receipt_failure BEFORE INSERT ON chamber_challenges BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    expect(() => f.directory.authorize(proof, signature, 'read-directory', effect)).toThrow('synthetic receipt failure');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM effects').get()).toEqual({ n: 0 }); expect(f.count()).toBe(0);
    f.db.exec('DROP TRIGGER receipt_failure');
    f.directory.authorize(proof, signature, 'read-directory', effect);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM effects').get()).toEqual({ n: 1 }); expect(f.count()).toBe(1);
    expect(() => f.directory.authorize(proof, signature, 'read-directory', effect)).toThrow('PERSONAL_PROOF_EXPIRED');
  });

  it('shares issuance across connections and retains challenges and replay protection after restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'chamber-challenge-restart-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'test.sqlite'), f = await fixture(file), pending = f.issue(), consumed = f.issue();
    f.directory.read(consumed, await signPersonalProof(entropy, consumed));
    const g = await fixture(file), another = g.issue();
    expect(g.directory.read(pending, await signPersonalProof(entropy, pending))).toEqual([]);
    expect(f.directory.read(another, await signPersonalProof(entropy, another))).toEqual([]);
    const inFlight = f.issue();
    cleanups.pop()!(); cleanups.pop()!(); // Close both handles before opening again.
    const restarted = await fixture(file);
    expect(restarted.directory.read(inFlight, await signPersonalProof(entropy, inFlight))).toEqual([]);
    const signature = await signPersonalProof(entropy, consumed);
    expect(() => restarted.directory.read(consumed, signature)).toThrow('PERSONAL_PROOF_EXPIRED');
    const foreign = await fixture();
    const unconsumed = restarted.issue();
    const signed = await signPersonalProof(entropy, unconsumed);
    expect(() => foreign.directory.read(unconsumed, signed)).toThrow('PERSONAL_PROOF_EXPIRED');
    expect(restarted.directory.read(unconsumed, signed)).toEqual([]);
  });

  it('accepts exact pre-upgrade challenges once without letting old quota occupancy block issuance', async () => {
    const f = await fixture(), legacy = { ...f.issue(), challenge: randomBase64Url(32) };
    const insert = f.db.prepare('INSERT INTO chamber_challenges VALUES(?,?,?,?,0)');
    for (let i = 0; i < 20; i++) {
      const proof = i ? { ...legacy, requestId: crypto.randomUUID() } : legacy;
      insert.run(proof.requestId, f.root.id, canonicalStringify(proof), proof.expiresAt);
    }
    const fresh = f.issue();
    const changed = { ...legacy, version: 2 };
    expect(() => f.directory.read(changed, '')).toThrow('UNAUTHORIZED');
    const changedSignature = await signPersonalProof(entropy, changed);
    expect(() => f.directory.read(changed, changedSignature)).toThrow('PERSONAL_PROOF_EXPIRED');
    const signature = await signPersonalProof(entropy, legacy);
    expect(f.directory.read(legacy, signature)).toEqual([]);
    expect(() => f.directory.read(legacy, signature)).toThrow('PERSONAL_PROOF_EXPIRED');
    expect(f.directory.read(fresh, await signPersonalProof(entropy, fresh))).toEqual([]);
  });

  it('expires at the absolute deadline and removes expired receipts without allowing reuse', async () => {
    const f = await fixture(), proof = f.issue(), signature = await signPersonalProof(entropy, proof);
    f.directory.read(proof, signature); expect(f.count()).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(proof.expiresAt));
    expect(() => f.directory.read(proof, signature)).toThrow('UNAUTHORIZED');
    const fresh = f.issue(); expect(f.count()).toBe(0);
    expect(f.directory.read(fresh, await signPersonalProof(entropy, fresh))).toEqual([]);
    expect(() => f.directory.read(proof, signature)).toThrow('UNAUTHORIZED');
  });
});
