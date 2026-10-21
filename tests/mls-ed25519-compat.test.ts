import { afterEach, expect, it, vi } from 'vitest';
import { fromBase64Url, toBase64Url } from '../src/lib/base64';
import { generateIdentity } from '../src/lib/crypto';
import { createCreatorMlsState, decryptMlsApplication, encryptMlsApplication, joinMlsGroup, prepareCreatorWelcome } from '../src/lib/mls';
import type { RoomMember, Vault } from '../src/lib/types';

afterEach(() => vi.restoreAllMocks());

it('exchanges MLS messages between persisted PKCS#8 and seed identities with native Ed25519 generation unavailable', async () => {
  const oldIdentity = await generateIdentity();
  const seed = fromBase64Url(oldIdentity.mlsPrivatePackage!.signaturePrivateKey);
  // RFC 8410's Ed25519 PKCS#8 encoding, as stored by the previous native path.
  const pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  pkcs8.set(seed, 16);
  oldIdentity.mlsPrivatePackage!.signaturePrivateKey = toBase64Url(pkcs8);
  seed.fill(0); pkcs8.fill(0);

  const generate = crypto.subtle.generateKey;
  vi.spyOn(crypto.subtle, 'generateKey').mockImplementation((...args) => {
    const algorithm = typeof args[0] === 'string' ? args[0] : args[0].name;
    if (algorithm === 'Ed25519') return Promise.reject(new DOMException('Native Ed25519 unavailable', 'OperationError'));
    return Reflect.apply(generate, crypto.subtle, args);
  });
  await expect(crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])).rejects.toMatchObject({ name: 'OperationError' });
  const newIdentity = await generateIdentity();
  const roomId = crypto.randomUUID();
  const members: RoomMember[] = [
    { ...oldIdentity.publicBundle, role: 'creator', joinProof: null },
    { ...newIdentity.publicBundle, role: 'joiner', joinProof: 'bound-by-invite' },
  ];
  const common = { v: 2 as const, roomId, accessToken: 'a'.repeat(43), pairingSecret: 'b'.repeat(43),
    creatorFingerprint: 'synthetic-creator', members, lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' as const };
  const creator: Vault = { ...common, role: 'creator', identity: oldIdentity,
    mls: await createCreatorMlsState(roomId, oldIdentity, members) };
  creator.mls = await prepareCreatorWelcome(creator);
  const joiner: Vault = { ...common, role: 'joiner', identity: newIdentity,
    mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
  joiner.mls = await joinMlsGroup(joiner, creator.mls.pendingWelcome!);
  creator.mls = { ...creator.mls, pendingWelcome: undefined };
  for (const [sender, receiver] of [[creator, joiner], [joiner, creator]]) {
    const payload = { v: 1 as const, kind: 'text' as const, text: 'compatible MLS identity', sentAt: new Date().toISOString() };
    const encrypted = await encryptMlsApplication(sender!, payload, crypto.randomUUID());
    sender!.mls!.groupState = encrypted.nextGroupState;
    const opened = await decryptMlsApplication(receiver!, encrypted.envelope);
    receiver!.mls!.groupState = opened.nextGroupState;
    expect(opened.payload).toEqual(payload);
    await expect(decryptMlsApplication(receiver!, encrypted.envelope)).rejects.toThrow();
  }
});

it('fails closed when secure randomness is unavailable', async () => {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new DOMException('Secure randomness unavailable', 'OperationError'); });
  await expect(generateIdentity()).rejects.toThrow('Secure randomness unavailable');
});
