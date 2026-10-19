import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash, webcrypto } from 'node:crypto';
import { canonicalStringify } from './protocol.mjs';
const bytes = x => Buffer.from(canonicalStringify(x));
export const personalHash = x => createHash('sha256').update(bytes(x)).digest('base64url');
export function validPersonalPublicBundle(bundle) {
  const key=(jwk,signing)=>!!jwk&&Object.keys(jwk).every(k=>['kty','crv','x','y','key_ops','ext'].includes(k))&&jwk.kty==='EC'&&jwk.crv==='P-256'&&
    /^[A-Za-z0-9_-]{43}$/.test(jwk.x??'')&&/^[A-Za-z0-9_-]{43}$/.test(jwk.y??'')&&(jwk.ext===undefined||typeof jwk.ext==='boolean')&&
    (jwk.key_ops===undefined||Array.isArray(jwk.key_ops)&&jwk.key_ops.length<2&&jwk.key_ops.every(op=>signing&&op==='verify'));
  return !!bundle&&Object.keys(bundle).sort().join(',')===(bundle.mlsKeyPackage===undefined?'deviceId,encryptionKey,signingKey':'deviceId,encryptionKey,mlsKeyPackage,signingKey')&&
    /^[0-9a-f-]{36}$/i.test(bundle.deviceId)&&key(bundle.encryptionKey,false)&&key(bundle.signingKey,true)&&
    (bundle.mlsKeyPackage===undefined||typeof bundle.mlsKeyPackage==='string'&&/^[A-Za-z0-9_-]{64,65536}$/.test(bundle.mlsKeyPackage));
}
export function validPersonalIdentity(x) {
  return !!x && Object.keys(x).sort().join(',') === 'directoryKey,id,recoveryKey,signingKey,v' && x.v === 1 &&
    [x.id, x.signingKey, x.recoveryKey, x.directoryKey].every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s)) &&
    x.id === personalHash({ purpose: 'chamber-personal-identity-v1', v: 1, signingKey: x.signingKey, recoveryKey: x.recoveryKey, directoryKey: x.directoryKey });
}

export function verifyPersonalProof(identity, proof, signature, now = Date.now()) {
  try {
    if (!validPersonalIdentity(identity) || !proof || Object.keys(proof).sort().join(',') !== 'action,challenge,deviceId,expiresAt,identityId,payloadHash,purpose,requestId,roomId,v,version' ||
      proof.v !== 1 || proof.purpose !== 'chamber-personal-proof-v1' || proof.identityId !== identity.id ||
      !['bind-device', 'read-directory', 'close-room', 'restore-room', 'restore-history'].includes(proof.action) ||
      ![proof.roomId, proof.deviceId, proof.requestId].every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s)) ||
      !Number.isSafeInteger(proof.version) || proof.version < 1 || ![proof.challenge, proof.payloadHash].every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s)) ||
      typeof proof.expiresAt !== 'string' || new Date(proof.expiresAt).toISOString() !== proof.expiresAt ||
      Date.parse(proof.expiresAt) <= now || Date.parse(proof.expiresAt) > now + 30 * 60_000 ||
      typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    return ed25519.verify(Buffer.from(signature, 'base64url'), bytes(proof), Buffer.from(identity.signingKey, 'base64url'), { zip215: false });
  } catch { return false; }
}
export async function verifyPersonalDeviceBinding(binding, bundle) {
  try {
    if (!validPersonalPublicBundle(bundle) || !binding || Object.keys(binding).sort().join(',') !== 'bundleHash,deviceSignature,identity,purpose,rootSignature,v' ||
      binding.v !== 1 || binding.purpose !== 'chamber-personal-device-v1' || !validPersonalIdentity(binding.identity) ||
      binding.bundleHash !== personalHash(bundle) ||
      ![binding.deviceSignature, binding.rootSignature].every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{86}$/.test(s))) return false;
    const { rootSignature, deviceSignature, ...body } = binding;
    if (!ed25519.verify(Buffer.from(rootSignature, 'base64url'), bytes(body), Buffer.from(binding.identity.signingKey, 'base64url'), { zip215: false })) return false;
    const key = await webcrypto.subtle.importKey('jwk', bundle.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(deviceSignature, 'base64url'), bytes(body));
  } catch { return false; }
}

export async function verifyChamberHistoryRecord(record, owner, peer, member) {
  try {
    if (!record || Object.keys(record).sort().join(',') !== 'id,keyEnvelope,ownerId,revision,roomId,sealed,v' || record.v !== 1 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(record.id) || record.ownerId !== owner.id || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      Object.keys(record.sealed).sort().join(',') !== 'ciphertext,iv' || !/^[A-Za-z0-9_-]{16}$/.test(record.sealed.iv) ||
      !/^[A-Za-z0-9_-]{22,4194326}$/.test(record.sealed.ciphertext)) return false;
    const e = record.keyEnvelope;
    if (!e || Object.keys(e).sort().join(',') !== 'author,context,ownerSignature,purpose,sealed,v' || e.v !== 1 || e.purpose !== 'chamber-joint-history-key-v1' ||
      canonicalStringify(e.context) !== canonicalStringify({ roomId: record.roomId, backupId: record.id, revision: record.revision,
        contentDigest: personalHash(record.sealed), owner, peer }) || !e.author || Object.keys(e.author).sort().join(',') !== 'binding,bundle' ||
      canonicalStringify(e.author.binding.identity) !== canonicalStringify(owner) || e.author.bundle.deviceId !== member.deviceId ||
      canonicalStringify(e.author.bundle.signingKey) !== canonicalStringify(member.signingKey) ||
      canonicalStringify(e.author.bundle.encryptionKey) !== canonicalStringify(member.encryptionKey) ||
      e.author.bundle.mlsKeyPackage !== member.mlsKeyPackage || !await verifyPersonalDeviceBinding(e.author.binding, e.author.bundle) ||
      Object.keys(e.sealed).sort().join(',') !== 'ciphertext,enc' || !/^[A-Za-z0-9_-]{43}$/.test(e.sealed.enc) ||
      !/^[A-Za-z0-9_-]{22,2048}$/.test(e.sealed.ciphertext) || !/^[A-Za-z0-9_-]{86}$/.test(e.ownerSignature)) return false;
    const { ownerSignature, ...unsigned } = e;
    const key = await webcrypto.subtle.importKey('jwk', member.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(ownerSignature, 'base64url'), bytes(unsigned));
  } catch { return false; }
}

export async function verifyPersonalDirectoryRecord(record, owner, member) {
  try {
    if (!record || Object.keys(record).sort().join(',') !== 'author,identityId,purpose,revision,roomId,sealed,signature,v' || record.v !== 1 ||
      record.purpose !== 'chamber-personal-directory-v1' || record.identityId !== owner.id || !/^[0-9a-f-]{36}$/i.test(record.roomId) ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      Object.keys(record.sealed).sort().join(',') !== 'ciphertext,enc' || !/^[A-Za-z0-9_-]{43}$/.test(record.sealed.enc) ||
      !/^[A-Za-z0-9_-]{22,2796224}$/.test(record.sealed.ciphertext) || !/^[A-Za-z0-9_-]{86}$/.test(record.signature) ||
      Object.keys(record.author).sort().join(',') !== 'binding,bundle' || canonicalStringify(record.author.binding.identity) !== canonicalStringify(owner) ||
      record.author.bundle.deviceId !== member.deviceId || canonicalStringify(record.author.bundle.signingKey) !== canonicalStringify(member.signingKey) ||
      canonicalStringify(record.author.bundle.encryptionKey) !== canonicalStringify(member.encryptionKey) || record.author.bundle.mlsKeyPackage !== member.mlsKeyPackage ||
      !await verifyPersonalDeviceBinding(record.author.binding, record.author.bundle)) return false;
    const { signature, ...unsigned } = record;
    const key = await webcrypto.subtle.importKey('jwk', member.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature, 'base64url'), bytes(unsigned));
  } catch { return false; }
}
