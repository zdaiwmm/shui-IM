import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalStringify } from './canonical';
import { toBase64Url } from './base64';
import { verifyPersonalDeviceBinding, type PersonalDeviceBinding } from './personal-device-binding';
import { bindPersonalDevice } from './personal-device-binding';
import { verifyPersonalProof, type PersonalProof, type PersonalPublicIdentity } from './personal-identity';
import type { PublicBundle } from './types';
import { generateIdentity } from './crypto';
import { randomBase64Url } from './base64';
import { signPersonalProof } from './personal-identity';
import { usePersonalIdentity, type StoredPersonalIdentity } from './personal-identity-vault';
import type { LocalCredentialResult } from './password-protection';
import type { PersonalDirectoryEntry } from './personal-directory';
import { personalChallenge } from './personal-directory-sync';
export type PersonalDevicePayload = { v: 1; purpose: 'chamber-device-request-v1'; roomId: string; role: 'creator' | 'joiner';
  bundle: PublicBundle; binding: PersonalDeviceBinding; tokenHash: string; deviceName: string; capabilities: string[] };
export type PersonalDeviceRequest = { payload: PersonalDevicePayload; proof: PersonalProof; signature: string };
export type PersonalDeviceAuthorization = { request: PersonalDeviceRequest; approverBinding: PersonalDeviceBinding; approvedAt: string };
export const personalDevicePayloadHash = (payload: PersonalDevicePayload) => toBase64Url(sha256(new TextEncoder().encode(canonicalStringify(payload))));
export function personalDeviceSafetyCode(request: PersonalDeviceRequest): string {
  const hash = sha256(new TextEncoder().encode(canonicalStringify(request)));
  return String(new DataView(hash.buffer, hash.byteOffset, hash.byteLength).getUint32(0) % 1_000_000).padStart(6, '0');
}
export async function preparePersonalDevice(entry: PersonalDirectoryEntry, stored: StoredPersonalIdentity, credential: LocalCredentialResult,
  deviceName: string, capabilities: string[], signal: AbortSignal,generation=entry.lifecycle?.generation??1) {
  const identity = await generateIdentity(); signal.throwIfAborted();
  const binding = await usePersonalIdentity(stored, credential, entropy => bindPersonalDevice(entropy, identity));
  const accessToken = randomBase64Url(32);
  const payload: PersonalDevicePayload = { v: 1, purpose: 'chamber-device-request-v1', roomId: entry.roomId, role: entry.role,
    bundle: identity.publicBundle, binding, tokenHash: toBase64Url(sha256(new TextEncoder().encode(accessToken))), deviceName, capabilities };
  const proof = await personalChallenge(stored.identity.id, { action: 'bind-device', roomId: entry.roomId, deviceId: identity.publicBundle.deviceId,
    version: generation, payloadHash: personalDevicePayloadHash(payload) }, signal);
  const signature = await usePersonalIdentity(stored, credential, entropy => signPersonalProof(entropy, proof));
  const request: PersonalDeviceRequest = { payload, proof, signature };
  if (!await verifyPersonalDeviceRequest(request, stored.identity)) throw new Error('新设备请求与本机身份不一致');
  signal.throwIfAborted(); return { identity, binding, accessToken, request };
}
export async function verifyPersonalDeviceRequest(request: PersonalDeviceRequest, owner: PersonalPublicIdentity, now = Date.now()): Promise<boolean> {
  try {
    const p = request.payload, proof = request.proof;
    return Object.keys(request).sort().join(',') === 'payload,proof,signature' &&
      Object.keys(p).sort().join(',') === 'binding,bundle,capabilities,deviceName,purpose,role,roomId,tokenHash,v' &&
      p.v === 1 && p.purpose === 'chamber-device-request-v1' && ['creator', 'joiner'].includes(p.role) &&
      typeof p.deviceName === 'string' && p.deviceName.length >= 1 && p.deviceName.length <= 40 &&
      Array.isArray(p.capabilities) && p.capabilities.length <= 32 && p.capabilities.every(c => /^[a-z0-9-]{1,40}$/.test(c)) &&
      /^[A-Za-z0-9_-]{43}$/.test(p.tokenHash) && canonicalStringify(p.binding.identity) === canonicalStringify(owner) &&
      await verifyPersonalDeviceBinding(p.binding, p.bundle) && proof.action === 'bind-device' && proof.roomId === p.roomId &&
      proof.deviceId === p.bundle.deviceId && proof.payloadHash === personalDevicePayloadHash(p) && verifyPersonalProof(owner, proof, request.signature, now);
  } catch { return false; }
}
