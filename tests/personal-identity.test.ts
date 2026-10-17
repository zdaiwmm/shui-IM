import { afterEach, describe, expect, it, vi } from 'vitest';
import { personalChallenge } from '../src/lib/personal-directory-sync';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { personalEntropyFromMnemonic, personalMnemonicFromEntropy, signPersonalProof, verifyPersonalProof, withPersonalKeys, type PersonalProof } from '../src/lib/personal-identity';
import { preparePersonalIdentity, usePersonalIdentity, validStoredPersonalIdentity } from '../src/lib/personal-identity-vault';
import { deriveNumericPasswordCredential, derivePasswordCredential, type LocalCredentialResult } from '../src/lib/password-protection';
import { randomBase64Url } from '../src/lib/base64';

// Public BIP39 test vector. Never use this phrase for actual funds or identities.
const phrase = Array(11).fill('abandon').concat('about').join(' ');
const entropy = new Uint8Array(16);
afterEach(()=>vi.unstubAllGlobals());

describe('Chamber personal identity', () => {
  it('matches the public BIP39 vector and MetaMask default Ethereum account', () => {
    expect(personalMnemonicFromEntropy(entropy)).toBe(phrase);
    expect(personalEntropyFromMnemonic(phrase)).toEqual(entropy);
    const seed = mnemonicToSeedSync(phrase, '');
    const hd = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
    const publicKey = secp256k1.getPublicKey(hd.privateKey!, false);
    const address = Buffer.from(keccak_256(publicKey.subarray(1)).subarray(12)).toString('hex');
    expect(address).toBe('9858effd232b4033e47d90003d41ec34ecaeda94');
    hd.wipePrivateData(); seed.fill(0);
  });

  it('rejects a valid-length phrase with an invalid checksum and non-product word counts', () => {
    expect(() => personalEntropyFromMnemonic(Array(12).fill('abandon').join(' '))).toThrow();
    expect(() => personalEntropyFromMnemonic(phrase + ' abandon')).toThrow();
  });

  it('derives separate identity, recovery and directory secrets and clears them after an exception', async () => {
    let captured: Uint8Array[] = [];
    await expect(withPersonalKeys(entropy, keys => {
      captured = [keys.signingSecret, keys.recoverySecret, keys.directorySecret];
      expect(new Set(captured.map(bytes => Buffer.from(bytes).toString('hex'))).size).toBe(3);
      throw new Error('cancelled');
    })).rejects.toThrow('cancelled');
    expect(captured.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  });

  it('signs bound operations and rejects changed actions, versions, targets or expiry', async () => {
    const identity = await withPersonalKeys(entropy, keys => keys.publicIdentity);
    const proof: PersonalProof = { v: 1, purpose: 'chamber-personal-proof-v1', action: 'close-room', identityId: identity.id,
      roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), requestId: crypto.randomUUID(),
      version: 1, challenge: randomBase64Url(32), expiresAt: new Date(Date.now() + 60_000).toISOString(), payloadHash: randomBase64Url(32) };
    const signature = await signPersonalProof(entropy, proof);
    expect(verifyPersonalProof(identity, proof, signature)).toBe(true);
    for (const changed of [{ action: 'restore-room' }, { version: 2 }, { roomId: crypto.randomUUID() }, { challenge: randomBase64Url(32) }]) {
      expect(verifyPersonalProof(identity, { ...proof, ...changed } as PersonalProof, signature)).toBe(false);
    }
    expect(verifyPersonalProof(identity, proof, signature, Date.parse(proof.expiresAt))).toBe(false);
  });
  it('refuses a compromised challenge service substituting the operation before any root signature',async()=>{
    const identity=await withPersonalKeys(entropy,keys=>keys.publicIdentity),input={action:'read-directory' as const,roomId:'directory',deviceId:crypto.randomUUID(),version:1,payloadHash:randomBase64Url(32)};
    const proof:PersonalProof={...input,v:1,purpose:'chamber-personal-proof-v1',identityId:identity.id,requestId:crypto.randomUUID(),challenge:randomBase64Url(32),expiresAt:new Date(Date.now()+60_000).toISOString()};
    for(const changed of [{action:'close-room'},{roomId:crypto.randomUUID()},{deviceId:crypto.randomUUID()},{version:2},{payloadHash:randomBase64Url(32)},{identityId:randomBase64Url(32)},{expiresAt:new Date(Date.now()+31*60_000).toISOString()}]){
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...proof,...changed})));
      await expect(personalChallenge(identity.id,input,new AbortController().signal)).rejects.toThrow('用途、目标或内容被替换');
    }
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json(proof)));
    expect(await personalChallenge(identity.id,input,new AbortController().signal)).toEqual(proof);
  });
});

describe('encrypted personal root vault', () => {
  it('requires an application-lock credential before creating an identity', async () => {
    await expect(preparePersonalIdentity(undefined as unknown as LocalCredentialResult)).rejects.toThrow('先设置应用锁');
  });

  it('really encrypts a numeric-password root, rejects wrong passwords, and wipes callback entropy', async () => {
    const credential = await deriveNumericPasswordCredential('012345');
    const stored = await preparePersonalIdentity(credential, entropy);
    expect(validStoredPersonalIdentity(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(phrase);
    let retained: Uint8Array | undefined;
    await usePersonalIdentity(stored, credential, bytes => { retained = bytes; expect(personalMnemonicFromEntropy(bytes)).toBe(phrase); });
    expect(retained!.every(byte => byte === 0)).toBe(true);
    const wrong = await derivePasswordCredential('012346', credential.kdf, 'numeric-6');
    await expect(usePersonalIdentity(stored, wrong, () => undefined)).rejects.toThrow();
    const changedFormat = structuredClone(stored);
    if (changedFormat.protection.method === 'password') delete changedFormat.protection.passwordFormat;
    await expect(usePersonalIdentity(changedFormat, credential, () => undefined)).rejects.toThrow();
    const daily = { ...credential }; delete daily.rootKek;
    await expect(usePersonalIdentity(stored, daily, () => undefined)).rejects.toThrow('重新验证');
    await expect(usePersonalIdentity(stored, { ...credential, rootKek: credential.kek }, () => undefined)).rejects.toThrow();
  });

  it('requires a distinct root PRF input and rejects a daily cached passkey output', async () => {
    const dailyRecord = { credentialId: randomBase64Url(32), prfSalt: randomBase64Url(32), transports: ['internal'] as AuthenticatorTransport[],
      authenticatorAttachment: 'platform' as const, backupEligible: true, createdAt: new Date().toISOString() };
    const rootRecord = { ...dailyRecord, prfSalt: randomBase64Url(32) };
    const daily = { record: dailyRecord, prfOutput: crypto.getRandomValues(new Uint8Array(32)) };
    const root = { record: rootRecord, prfOutput: crypto.getRandomValues(new Uint8Array(32)) };
    await expect(preparePersonalIdentity(daily, entropy, dailyRecord)).rejects.toThrow('独立');
    const stored = await preparePersonalIdentity(root, entropy, dailyRecord);
    await expect(usePersonalIdentity(stored, daily, () => undefined)).rejects.toThrow();
    await expect(usePersonalIdentity(stored, { record: rootRecord, prfOutput: daily.prfOutput }, () => undefined)).rejects.toThrow();
    await usePersonalIdentity(stored, root, bytes => expect(bytes).toEqual(entropy));
  });

  it('does not change the identity or wallet entropy when local protection changes', async () => {
    const first = await deriveNumericPasswordCredential('012345');
    const second = await deriveNumericPasswordCredential('987654');
    const a = await preparePersonalIdentity(first, entropy), b = await preparePersonalIdentity(second, entropy);
    expect(a.identity).toEqual(b.identity);
    expect(a.payload).not.toEqual(b.payload);
    await expect(usePersonalIdentity(a, second, () => undefined)).rejects.toThrow();
  });

  it('fails closed on switched payloads, unknown root fields, and public-identity substitution', async () => {
    const credential = await deriveNumericPasswordCredential('012345');
    const a = await preparePersonalIdentity(credential, entropy);
    const b = await preparePersonalIdentity(credential, new Uint8Array(16).fill(1));
    expect(validStoredPersonalIdentity({ ...a, mnemonic: phrase })).toBe(false);
    await expect(usePersonalIdentity({ ...a, payload: b.payload }, credential, () => undefined)).rejects.toThrow();
    await expect(usePersonalIdentity({ ...a, identity: b.identity }, credential, () => undefined)).rejects.toThrow();
  });
});
