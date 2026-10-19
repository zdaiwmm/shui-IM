import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';

const encode = (value: string) => new TextEncoder().encode(value);
const domain = 'chamber-personal-identity-v1';
export type PersonalPublicIdentity = { v: 1; id: string; signingKey: string; recoveryKey: string; directoryKey: string };
export type PersonalProofAction = 'bind-device' | 'read-directory' | 'close-room' | 'restore-room' | 'restore-history';
export type PersonalProof = {
  v: 1; purpose: 'chamber-personal-proof-v1'; action: PersonalProofAction;
  identityId: string; roomId: string; deviceId: string; requestId: string;
  version: number; challenge: string; expiresAt: string; payloadHash: string;
};
const actions = new Set<PersonalProofAction>(['bind-device', 'read-directory', 'close-room', 'restore-room', 'restore-history']);

/** Never use the app-lock password as a BIP39 passphrase. */
export function normalizePersonalMnemonic(input: string): string {
  return input.normalize('NFKD').trim().toLowerCase().split(/\s+/u).join(' ');
}

export function personalEntropyFromMnemonic(input: string): Uint8Array<ArrayBuffer> {
  const mnemonic = normalizePersonalMnemonic(input);
  if (mnemonic.split(' ').length !== 12 || !validateMnemonic(mnemonic, wordlist)) {
    throw new Error('助记词的词数、词表、顺序或校验和不正确');
  }
  return new Uint8Array(mnemonicToEntropy(mnemonic, wordlist));
}

export function personalMnemonicFromEntropy(entropy: Uint8Array): string {
  if (entropy.length !== 16) throw new Error('身份熵长度不正确');
  return entropyToMnemonic(entropy, wordlist);
}

function identityId(keys: Omit<PersonalPublicIdentity, 'id'>): string {
  return toBase64Url(sha256(encode(canonicalStringify({ purpose: domain, ...keys }))));
}

/** Derived secret buffers belong to the callback and are cleared when it settles. */
export async function withPersonalKeys<T>(entropy: Uint8Array, operation: (keys: {
  publicIdentity: PersonalPublicIdentity; signingSecret: Uint8Array<ArrayBuffer>;
  recoverySecret: Uint8Array<ArrayBuffer>; directorySecret: Uint8Array<ArrayBuffer>;
}) => T | Promise<T>): Promise<T> {
  const seed = mnemonicToSeedSync(personalMnemonicFromEntropy(entropy), '');
  const derive = (purpose: string) => new Uint8Array(hkdf(sha256, seed, encode(domain), encode(purpose), 32));
  const signingSecret = derive('identity-signing-ed25519');
  const recoverySecret = derive('joint-history-x25519');
  const directorySecret = derive('private-directory-x25519');
  try {
    const keys = { v: 1 as const, signingKey: toBase64Url(ed25519.getPublicKey(signingSecret)), recoveryKey: toBase64Url(x25519.getPublicKey(recoverySecret)), directoryKey: toBase64Url(x25519.getPublicKey(directorySecret)) };
    return await operation({ publicIdentity: { ...keys, id: identityId(keys) }, signingSecret, recoverySecret, directorySecret });
  } finally {
    seed.fill(0); signingSecret.fill(0); recoverySecret.fill(0); directorySecret.fill(0);
  }
}

export function isPersonalPublicIdentity(value: unknown): value is PersonalPublicIdentity {
  if (!value || typeof value !== 'object') return false;
  const x = value as PersonalPublicIdentity;
  if (Object.keys(x).sort().join(',') !== 'directoryKey,id,recoveryKey,signingKey,v' || x.v !== 1 ||
      [x.id, x.signingKey, x.recoveryKey, x.directoryKey].some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item))) return false;
  return x.id === identityId({ v: 1, signingKey: x.signingKey, recoveryKey: x.recoveryKey, directoryKey: x.directoryKey });
}

export function validPersonalProof(proof: PersonalProof, identity: Pick<PersonalPublicIdentity,'id'>, now = Date.now()): boolean {
  return !!proof && Object.keys(proof).sort().join(',') === 'action,challenge,deviceId,expiresAt,identityId,payloadHash,purpose,requestId,roomId,v,version' &&
    proof.v === 1 && proof.purpose === 'chamber-personal-proof-v1' && actions.has(proof.action) &&
    proof.identityId === identity.id && [proof.roomId, proof.deviceId, proof.requestId].every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x)) &&
    Number.isSafeInteger(proof.version) && proof.version >= 1 && /^[A-Za-z0-9_-]{43}$/.test(proof.challenge) &&
    /^[A-Za-z0-9_-]{43}$/.test(proof.payloadHash) && typeof proof.expiresAt === 'string' &&
    Number.isFinite(Date.parse(proof.expiresAt)) && new Date(proof.expiresAt).toISOString() === proof.expiresAt && Date.parse(proof.expiresAt) > now && Date.parse(proof.expiresAt) <= now + 30 * 60_000;
}

export async function signPersonalProof(entropy: Uint8Array, proof: PersonalProof): Promise<string> {
  return withPersonalKeys(entropy, ({ publicIdentity, signingSecret }) => {
    if (!validPersonalProof(proof, publicIdentity)) throw new Error('身份操作的用途、目标或有效期不正确');
    return toBase64Url(ed25519.sign(encode(canonicalStringify(proof)), signingSecret));
  });
}

export function verifyPersonalProof(identity: PersonalPublicIdentity, proof: PersonalProof, signature: string, now = Date.now()): boolean {
  if (!isPersonalPublicIdentity(identity) || !validPersonalProof(proof, identity, now) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try { return ed25519.verify(fromBase64Url(signature), encode(canonicalStringify(proof)), fromBase64Url(identity.signingKey), { zip215: false }); }
  catch { return false; }
}
