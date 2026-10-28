import { uiLiteral } from './language';
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { isPersonalPublicIdentity, validPersonalProof, verifyPersonalProof, withPersonalKeys, type PersonalPublicIdentity, type PersonalProof } from './personal-identity';
import { verifyPersonalDeviceBinding, type PersonalDeviceBinding } from './personal-device-binding';
import type { PrivateIdentity, PublicBundle } from './types';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const deliverySuite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const bytes = (value: unknown) => encoder.encode(canonicalStringify(value));
const hash = (value: unknown) => toBase64Url(sha256(bytes(value)));
const same = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);
const fail = () => new Error(uiLiteral('双方历史恢复材料的身份、范围或有效期不一致'));
type HpkeEnvelope = { enc: string; ciphertext: string };
export type JointHistoryContext = {
  roomId: string; backupId: string; revision: number; contentDigest: string;
  owner: PersonalPublicIdentity; peer: PersonalPublicIdentity;
};
export type JointHistoryKeyEnvelope = {
  v: 1; purpose: 'chamber-joint-history-key-v1'; context: JointHistoryContext;
  sealed: HpkeEnvelope; ownerSignature: string;
  author?: { binding: PersonalDeviceBinding; bundle: PublicBundle };
};
export type JointHistoryRelease = { v: 1; envelopeHash: string; peerProof: PersonalProof; peerSignature: string } &
  ({ inner: HpkeEnvelope; delivery?: never } | { delivery: HpkeEnvelope; inner?: never });
export type JointHistoryScope = {
  v: 1; purpose: 'chamber-joint-history-scope-v1'; roomId: string; ownerId: string; peerId: string;
  scope: 'chat' | 'gallery' | 'all'; generation: number; target: PublicBundle;
  heads: { deviceId: string; id: string; digest: string; revision: number; afterSeq: number; upperSeq: number }[];
  units: { id: string; deviceId: string; revision: number; envelopeHash: string }[];
};
export type VerifiedJointHistoryScope = Readonly<{ requestId: string; expiresAt: string; scopeHash: string }>;
const verifiedScopes = new WeakMap<VerifiedJointHistoryScope, { proof: PersonalProof; signature: string; owner: PersonalPublicIdentity; peer: PersonalPublicIdentity; target: PublicBundle; units: Map<string, JointHistoryScope['units'][number]> }>();
export const jointHistoryScopeHash = (scope: JointHistoryScope) => hash(scope);

/** Verify the signed snapshot once; the returned token exposes no secret and cannot be forged by serialization. */
export function prepareJointHistoryScope(scope: JointHistoryScope, proof: PersonalProof, signature: string,
  owner: PersonalPublicIdentity, peer: PersonalPublicIdentity): VerifiedJointHistoryScope {
  if (!scope || Object.keys(scope).sort().join(',') !== 'generation,heads,ownerId,peerId,purpose,roomId,scope,target,units,v' || scope.v !== 1 ||
    scope.purpose !== 'chamber-joint-history-scope-v1' || scope.ownerId !== owner.id || scope.peerId !== peer.id || owner.id === peer.id ||
    !['chat', 'gallery', 'all'].includes(scope.scope) || !Number.isSafeInteger(scope.generation) || scope.generation < 1 ||
    !Array.isArray(scope.heads) || scope.heads.length < 1 || scope.heads.length > 1000 || !Array.isArray(scope.units) || scope.units.length < 1 || scope.units.length > 50_000 ||
    !validDeliveryTarget(scope.target) || proof.deviceId !== scope.target.deviceId || proof.action !== 'restore-history' || proof.roomId !== scope.roomId || proof.version !== scope.generation ||
    proof.payloadHash !== hash(scope) || !verifyPersonalProof(owner, proof, signature)) throw fail();
  const heads = new Map<string, JointHistoryScope['heads'][number]>(), units = new Map<string, JointHistoryScope['units'][number]>(), ids = new Map<string, JointHistoryScope['units'][number]>();
  for (const head of scope.heads) {
    if (!head || Object.keys(head).sort().join(',') !== 'afterSeq,deviceId,digest,id,revision,upperSeq' || heads.has(head.deviceId) ||
      !/^[0-9a-f-]{36}$/i.test(head.deviceId) || !/^[A-Za-z0-9_-]{43}$/.test(head.id) || !/^[A-Za-z0-9_-]{43}$/.test(head.digest) ||
      !Number.isSafeInteger(head.revision) || head.revision < 1 || !Number.isSafeInteger(head.afterSeq) || head.afterSeq < 0 || !Number.isSafeInteger(head.upperSeq) || head.upperSeq < head.afterSeq) throw fail();
    heads.set(head.deviceId, structuredClone(head));
  }
  for (const unit of scope.units) {
    if (!unit || Object.keys(unit).sort().join(',') !== 'deviceId,envelopeHash,id,revision' || !/^[A-Za-z0-9_-]{43}$/.test(unit.id) ||
      !/^[A-Za-z0-9_-]{43}$/.test(unit.envelopeHash) || ids.has(unit.id) || units.has(unit.envelopeHash) ||
      !Number.isSafeInteger(unit.revision) || unit.revision < 1 || !heads.has(unit.deviceId) || unit.revision > heads.get(unit.deviceId)!.revision) throw fail();
    const copy = structuredClone(unit); ids.set(unit.id, copy); units.set(unit.envelopeHash, copy);
  }
  for (const head of heads.values()) if (ids.get(head.id)?.deviceId !== head.deviceId || ids.get(head.id)?.revision !== head.revision) throw fail();
  const token = Object.freeze({ requestId: proof.requestId, expiresAt: proof.expiresAt, scopeHash: proof.payloadHash });
  verifiedScopes.set(token, { proof: structuredClone(proof), signature, owner: structuredClone(owner), peer: structuredClone(peer), target: structuredClone(scope.target), units }); return token;
}

function validDeliveryTarget(target: PublicBundle): boolean {
  const publicKey = (key: JsonWebKey) => key && Object.keys(key).every(k => ['key_ops', 'ext', 'kty', 'crv', 'x', 'y'].includes(k)) &&
    key.kty === 'EC' && key.crv === 'P-256' && /^[A-Za-z0-9_-]{43}$/.test(key.x ?? '') && /^[A-Za-z0-9_-]{43}$/.test(key.y ?? '');
  return !!target && Object.keys(target).sort().join(',') === 'deviceId,encryptionKey,mlsKeyPackage,signingKey' &&
    /^[0-9a-f-]{36}$/i.test(target.deviceId) && typeof target.mlsKeyPackage === 'string' && /^[A-Za-z0-9_-]{64,262144}$/.test(target.mlsKeyPackage) &&
    !!publicKey(target.encryptionKey) && !!publicKey(target.signingKey);
}

const deliveryInfo = (request: PersonalProof, envelopeHash: string, target: PublicBundle) => bytes({
  purpose: 'chamber-history-device-delivery-v1', ownerRequestHash: hash(request), envelopeHash, targetHash: hash(target),
});
async function sealDelivery(inner: HpkeEnvelope, request: PersonalProof, envelopeHash: string, target: PublicBundle): Promise<HpkeEnvelope> {
  const recipientPublicKey = await crypto.subtle.importKey('jwk', target.encryptionKey, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const info = deliveryInfo(request, envelopeHash, target), raw = bytes(inner);
  try {
    const sender = await deliverySuite.createSenderContext({ recipientPublicKey, info: info.buffer });
    return { enc: toBase64Url(sender.enc), ciphertext: toBase64Url(await sender.seal(raw.buffer, info.buffer)) };
  } finally { raw.fill(0); }
}
async function openDelivery(delivery: HpkeEnvelope, request: PersonalProof, envelopeHash: string, target: PrivateIdentity, expected: PublicBundle): Promise<HpkeEnvelope> {
  if (!same(target.publicBundle, expected) || Object.keys(delivery).sort().join(',') !== 'ciphertext,enc' ||
    !/^[A-Za-z0-9_-]{87}$/.test(delivery.enc) || !/^[A-Za-z0-9_-]{22,2048}$/.test(delivery.ciphertext)) throw fail();
  const privateKey = await crypto.subtle.importKey('jwk', target.encryptionPrivateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('jwk', expected.encryptionKey, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const info = deliveryInfo(request, envelopeHash, expected), enc = fromBase64Url(delivery.enc), ciphertext = fromBase64Url(delivery.ciphertext);
  const recipient = await deliverySuite.createRecipientContext({ recipientKey: { privateKey, publicKey }, enc: enc.buffer, info: info.buffer });
  const raw = new Uint8Array(await recipient.open(ciphertext.buffer, info.buffer));
  try { const inner = JSON.parse(decoder.decode(raw)) as HpkeEnvelope; if (!validCiphertext(inner)) throw fail(); return inner; }
  finally { raw.fill(0); }
}

function validContext(x: JointHistoryContext): boolean {
  return !!x && Object.keys(x).sort().join(',') === 'backupId,contentDigest,owner,peer,revision,roomId' &&
    [x.roomId, x.backupId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) &&
    Number.isSafeInteger(x.revision) && x.revision > 0 && /^[A-Za-z0-9_-]{43}$/.test(x.contentDigest) &&
    isPersonalPublicIdentity(x.owner) && isPersonalPublicIdentity(x.peer) && x.owner.id !== x.peer.id;
}

function validCiphertext(x: HpkeEnvelope): boolean {
  return !!x && Object.keys(x).sort().join(',') === 'ciphertext,enc' &&
    typeof x.enc === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x.enc) &&
    typeof x.ciphertext === 'string' && /^[A-Za-z0-9_-]{22,2048}$/.test(x.ciphertext);
}

const hpkeInfo = (context: JointHistoryContext, layer: 'owner' | 'peer') => bytes({ purpose: 'chamber-joint-history-key-v1', layer, context });
async function sealLayer(publicKey: string, payload: Uint8Array<ArrayBuffer>, context: JointHistoryContext, layer: 'owner' | 'peer'): Promise<HpkeEnvelope> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(fromBase64Url(publicKey));
  const info = hpkeInfo(context, layer);
  const sender = await suite.createSenderContext({ recipientPublicKey, info: info.buffer });
  return { enc: toBase64Url(sender.enc), ciphertext: toBase64Url(await sender.seal(payload.buffer, info.buffer)) };
}

async function openLayer(secret: Uint8Array<ArrayBuffer>, envelope: HpkeEnvelope, context: JointHistoryContext, layer: 'owner' | 'peer'): Promise<Uint8Array<ArrayBuffer>> {
  if (!validCiphertext(envelope)) throw fail();
  const recipientKey = await suite.kem.deserializePrivateKey(secret);
  const info = hpkeInfo(context, layer), enc = fromBase64Url(envelope.enc), ciphertext = fromBase64Url(envelope.ciphertext);
  const recipient = await suite.createRecipientContext({ recipientKey, enc: enc.buffer, info: info.buffer });
  return new Uint8Array(await recipient.open(ciphertext.buffer, info.buffer));
}

async function verifiedEnvelope(envelope: JointHistoryKeyEnvelope, pinnedContext: JointHistoryContext): Promise<void> {
  if (!envelope || Object.keys(envelope).sort().join(',') !== (envelope.author ? 'author,context,ownerSignature,purpose,sealed,v' : 'context,ownerSignature,purpose,sealed,v') ||
    envelope.v !== 1 || envelope.purpose !== 'chamber-joint-history-key-v1' || !validContext(envelope.context) ||
    !same(envelope.context, pinnedContext) || !validCiphertext(envelope.sealed) ||
    typeof envelope.ownerSignature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.ownerSignature)) throw fail();
  const { ownerSignature, ...unsigned } = envelope;
  if (envelope.author) {
    const { binding, bundle } = envelope.author;
    if (Object.keys(envelope.author).sort().join(',') !== 'binding,bundle' || !same(binding.identity, pinnedContext.owner) ||
      !await verifyPersonalDeviceBinding(binding, bundle)) throw fail();
    const key = await crypto.subtle.importKey('jwk', bundle.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(ownerSignature), bytes(unsigned))) throw fail();
    return;
  }
  if (!ed25519.verify(fromBase64Url(ownerSignature), bytes(unsigned), fromBase64Url(pinnedContext.owner.signingKey), { zip215: false })) throw fail();
}

/** Automatic backup uses the already authorized device, never a retained personal root. */
export async function sealJointHistoryKeyForDevice(dataKey: Uint8Array, context: JointHistoryContext,
  device: PrivateIdentity, binding: PersonalDeviceBinding): Promise<JointHistoryKeyEnvelope> {
  if (!validContext(context) || dataKey.length !== 32 || !same(binding.identity, context.owner) ||
    !await verifyPersonalDeviceBinding(binding, device.publicBundle)) throw fail();
  const copy = new Uint8Array(dataKey);
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    const inner = await sealLayer(context.owner.recoveryKey, copy, context, 'owner'); raw = bytes(inner);
    const sealed = await sealLayer(context.peer.recoveryKey, raw, context, 'peer');
    const unsigned = { v: 1 as const, purpose: 'chamber-joint-history-key-v1' as const, context, sealed,
      author: { binding, bundle: device.publicBundle } };
    const key = await crypto.subtle.importKey('jwk', device.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { ...unsigned, ownerSignature: toBase64Url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(unsigned))) };
  } finally { copy.fill(0); raw?.fill(0); }
}

/** Two RFC9180 layers: the peer can remove only the outer layer; only the owner opens the inner one.
 * The owner already knows its local data key. This never revokes previously decrypted copies.
 */
export async function sealJointHistoryKey(dataKey: Uint8Array, context: JointHistoryContext, ownerEntropy: Uint8Array): Promise<JointHistoryKeyEnvelope> {
  if (!validContext(context) || dataKey.length !== 32) throw fail();
  return withPersonalKeys(ownerEntropy, async keys => {
    if (!same(keys.publicIdentity, context.owner)) throw fail();
    const keyCopy = new Uint8Array(dataKey);
    let innerBytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      const inner = await sealLayer(context.owner.recoveryKey, keyCopy, context, 'owner');
      innerBytes = bytes(inner);
      const sealed = await sealLayer(context.peer.recoveryKey, innerBytes, context, 'peer');
      const unsigned = { v: 1 as const, purpose: 'chamber-joint-history-key-v1' as const, context, sealed };
      return { ...unsigned, ownerSignature: toBase64Url(ed25519.sign(bytes(unsigned), keys.signingSecret)) };
    } finally { keyCopy.fill(0); innerBytes?.fill(0); }
  });
}

function verifyOwnerRequest(envelope: JointHistoryKeyEnvelope, request: PersonalProof, signature: string, scope?: VerifiedJointHistoryScope): void {
  if (scope) {
    const grant = verifiedScopes.get(scope), unit = grant?.units.get(hash(envelope));
    if (!grant || !unit || !same(grant.proof, request) || grant.signature !== signature || Date.parse(request.expiresAt) <= Date.now() || request.roomId !== envelope.context.roomId ||
      !same(grant.owner, envelope.context.owner) || !same(grant.peer, envelope.context.peer) || unit.id !== envelope.context.backupId ||
      unit.revision !== envelope.context.revision || unit.deviceId !== envelope.author?.bundle.deviceId) throw fail();
    return;
  }
  if (request?.action !== 'restore-history' || request.roomId !== envelope.context.roomId ||
      request.version !== envelope.context.revision || request.payloadHash !== hash(envelope) ||
      !verifyPersonalProof(envelope.context.owner, request, signature)) throw fail();
}

export function jointHistoryEnvelopeHash(envelope: JointHistoryKeyEnvelope): string { return hash(envelope); }

/** Call only after explicit peer consent and fresh local reauthentication.
 * The service must bind and atomically consume the request challenge; signature checking alone is not replay prevention.
 */
export async function releaseJointHistoryLayer(envelope: JointHistoryKeyEnvelope, pinnedContext: JointHistoryContext,
  request: PersonalProof, ownerSignature: string, peerEntropy: Uint8Array, scope?: VerifiedJointHistoryScope): Promise<JointHistoryRelease> {
  await verifiedEnvelope(envelope, pinnedContext); verifyOwnerRequest(envelope, request, ownerSignature, scope);
  return withPersonalKeys(peerEntropy, async keys => {
    if (!same(keys.publicIdentity, pinnedContext.peer)) throw fail();
    const raw = await openLayer(keys.recoverySecret, envelope.sealed, pinnedContext, 'peer');
    try {
      const inner = JSON.parse(decoder.decode(raw)) as HpkeEnvelope;
      if (!validCiphertext(inner)) throw fail();
      const target = scope ? verifiedScopes.get(scope)!.target : undefined;
      const capsule = target ? { delivery: await sealDelivery(inner, request, hash(envelope), target) } : { inner };
      const peerProof = { ...request, identityId: keys.publicIdentity.id,
        payloadHash: hash({ purpose: 'chamber-history-release-v1', ownerRequestHash: hash(request), envelopeHash: hash(envelope), ...capsule }) };
      if (!validPersonalProof(peerProof, keys.publicIdentity)) throw fail();
      return { v: 1, envelopeHash: hash(envelope), ...capsule, peerProof,
        peerSignature: toBase64Url(ed25519.sign(bytes(peerProof), keys.signingSecret)) };
    } finally { raw.fill(0); }
  });
}

/** The owner receives the key only inside a bounded operation; no private root is transferred or uploaded. */
export async function useJointHistoryKey<T>(envelope: JointHistoryKeyEnvelope, pinnedContext: JointHistoryContext,
  request: PersonalProof, ownerSignature: string, release: JointHistoryRelease, ownerEntropy: Uint8Array,
  operation: (key: Uint8Array<ArrayBuffer>) => T | Promise<T>, scope?: VerifiedJointHistoryScope, target?: PrivateIdentity): Promise<T> {
  await verifiedEnvelope(envelope, pinnedContext); verifyOwnerRequest(envelope, request, ownerSignature, scope);
  const capsule = scope ? { delivery: release?.delivery } : { inner: release?.inner };
  if (!release || Object.keys(release).sort().join(',') !== (scope ? 'delivery,envelopeHash,peerProof,peerSignature,v' : 'envelopeHash,inner,peerProof,peerSignature,v') ||
    release.v !== 1 || release.envelopeHash !== hash(envelope) ||
    !same(release.peerProof, { ...request, identityId: pinnedContext.peer.id,
      payloadHash: hash({ purpose: 'chamber-history-release-v1', ownerRequestHash: hash(request), envelopeHash: hash(envelope), ...capsule }) }) ||
    !verifyPersonalProof(pinnedContext.peer, release.peerProof, release.peerSignature)) throw fail();
  return withPersonalKeys(ownerEntropy, async keys => {
    if (!same(keys.publicIdentity, pinnedContext.owner)) throw fail();
    const inner = scope && target && release.delivery ? await openDelivery(release.delivery, request, hash(envelope), target, verifiedScopes.get(scope)!.target) : release.inner;
    if (!inner) throw fail();
    const key = await openLayer(keys.recoverySecret, inner, pinnedContext, 'owner');
    try { if (key.length !== 32) throw fail(); return await operation(key); }
    finally { key.fill(0); }
  });
}
