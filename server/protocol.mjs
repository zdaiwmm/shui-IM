import { decodeMlsMessage } from 'ts-mls';

const encoder = new TextEncoder();

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

export function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isP256PublicJwk(value, use) {
  return Boolean(
    value &&
      value.kty === 'EC' &&
      value.crv === 'P-256' &&
      typeof value.x === 'string' && value.x.length >= 40 && value.x.length <= 64 &&
      typeof value.y === 'string' && value.y.length >= 40 && value.y.length <= 64 &&
      !value.d &&
      Array.isArray(value.key_ops) &&
      (use === null || value.key_ops.includes(use)),
  );
}

export function validatePublicBundle(bundle) {
  return Boolean(
    bundle &&
      isUuid(bundle.deviceId) &&
      isP256PublicJwk(bundle.encryptionKey, null) &&
      isP256PublicJwk(bundle.signingKey, 'verify') &&
      (bundle.mlsKeyPackage === undefined || (
        typeof bundle.mlsKeyPackage === 'string' &&
        bundle.mlsKeyPackage.length >= 64 &&
        bundle.mlsKeyPackage.length <= 64 * 1024 &&
        /^[A-Za-z0-9_-]+$/.test(bundle.mlsKeyPackage)
      )),
  );
}

export function validateEnvelopeShape(envelope, expectedRoomId) {
  if (!envelope || envelope.roomId !== expectedRoomId) return false;
  if (!isUuid(envelope.clientMsgId) || !isUuid(envelope.senderId)) return false;
  if (envelope.v === 2) {
    return envelope.protocol === 'mls-rfc9420' &&
      typeof envelope.ciphertext === 'string' && envelope.ciphertext.length >= 32 && envelope.ciphertext.length <= 128 * 1024 &&
      /^[A-Za-z0-9_-]+$/.test(envelope.ciphertext) &&
      typeof envelope.signature === 'string' && envelope.signature.length > 0 && envelope.signature.length <= 512;
  }
  if (envelope.v !== 1) return false;
  if (!isP256PublicJwk(envelope.ephemeralPublicKey, null)) return false;
  if (
    !envelope.content ||
    typeof envelope.content.iv !== 'string' || envelope.content.iv.length < 16 || envelope.content.iv.length > 32 ||
    typeof envelope.content.ciphertext !== 'string' || envelope.content.ciphertext.length < 20 || envelope.content.ciphertext.length > 64 * 1024
  ) return false;
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length !== 2) return false;
  if (new Set(envelope.recipients.map((recipient) => recipient.deviceId)).size !== 2) return false;
  if (!envelope.recipients.every((recipient) =>
    isUuid(recipient.deviceId) &&
    typeof recipient.salt === 'string' && recipient.salt.length >= 42 && recipient.salt.length <= 64 &&
    typeof recipient.iv === 'string' && recipient.iv.length >= 16 && recipient.iv.length <= 32 &&
    typeof recipient.wrappedKey === 'string' && recipient.wrappedKey.length >= 64 && recipient.wrappedKey.length <= 96)) return false;
  return typeof envelope.signature === 'string' && envelope.signature.length > 0 && envelope.signature.length <= 512;
}

export function validateMlsWelcomeShape(envelope, expectedRoomId) {
  return Boolean(
    envelope &&
    envelope.v === 1 &&
    envelope.protocol === 'mls-rfc9420' &&
    envelope.roomId === expectedRoomId &&
    isUuid(envelope.senderId) &&
    isUuid(envelope.recipientId) &&
    envelope.senderId !== envelope.recipientId &&
    typeof envelope.welcome === 'string' &&
    envelope.welcome.length >= 64 &&
    envelope.welcome.length <= 256 * 1024 &&
    /^[A-Za-z0-9_-]+$/.test(envelope.welcome) &&
    typeof envelope.signature === 'string' &&
    envelope.signature.length > 0 && envelope.signature.length <= 512
  );
}

export function validateMlsMembershipShape(envelope, expectedRoomId) {
  if (!envelope || envelope.v !== 1 || envelope.protocol !== 'mls-rfc9420' || envelope.roomId !== expectedRoomId) {
    return false;
  }
  if (
    !isUuid(envelope.eventId) ||
    !Number.isSafeInteger(envelope.previousEventSeq) ||
    envelope.previousEventSeq < 0 ||
    !['add', 'remove'].includes(envelope.action) ||
    !isUuid(envelope.senderId) ||
    !isUuid(envelope.targetId) ||
    envelope.senderId === envelope.targetId ||
    typeof envelope.commit !== 'string' ||
    envelope.commit.length < 32 ||
    envelope.commit.length > 256 * 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.commit) ||
    typeof envelope.signature !== 'string' ||
    envelope.signature.length < 1 ||
    envelope.signature.length > 512
  ) return false;
  if (envelope.action === 'add') {
    return validatePublicBundle(envelope.target) &&
      envelope.target.deviceId === envelope.targetId &&
      ['creator', 'joiner'].includes(envelope.target.role) &&
      envelope.target.status === 'pending' &&
      envelope.target.addedBy === envelope.senderId &&
      typeof envelope.welcome === 'string' &&
      envelope.welcome.length >= 64 &&
      envelope.welcome.length <= 256 * 1024 &&
      /^[A-Za-z0-9_-]+$/.test(envelope.welcome);
  }
  return envelope.target === undefined && envelope.welcome === undefined;
}

function safeEpoch(value) {
  return typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : null;
}

export function mlsPrivateMessageEpoch(ciphertext) {
  try {
    const bytes = fromBase64Url(ciphertext);
    const decoded = decodeMlsMessage(bytes, 0);
    if (!decoded || decoded[1] !== bytes.length || decoded[0].wireformat !== 'mls_private_message') return null;
    return safeEpoch(decoded[0].privateMessage.epoch);
  } catch {
    return null;
  }
}

export function mlsPublicMessageEpoch(commit) {
  try {
    const bytes = fromBase64Url(commit);
    const decoded = decodeMlsMessage(bytes, 0);
    if (!decoded || decoded[1] !== bytes.length || decoded[0].wireformat !== 'mls_public_message') return null;
    return safeEpoch(decoded[0].publicMessage.content.epoch);
  } catch {
    return null;
  }
}

export function validateReceiptShape(receipt, expectedRoomId) {
  return Boolean(
    receipt &&
      receipt.v === 1 &&
      receipt.roomId === expectedRoomId &&
      isUuid(receipt.clientMsgId) &&
      Number.isSafeInteger(receipt.seq) &&
      receipt.seq > 0 &&
      isUuid(receipt.receiverId) &&
      typeof receipt.receivedAt === 'string' &&
      Number.isFinite(Date.parse(receipt.receivedAt)) &&
      typeof receipt.signature === 'string' &&
      receipt.signature.length > 0 &&
      receipt.signature.length <= 512
  );
}

async function verifySignedObject(value, signingJwk) {
  const { signature, ...unsigned } = value;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      signingJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      fromBase64Url(signature),
      encoder.encode(canonicalStringify(unsigned)),
    );
  } catch {
    return false;
  }
}

export async function verifyEnvelopeSignature(envelope, signingJwk) {
  return verifySignedObject(envelope, signingJwk);
}

export async function verifyReceiptSignature(receipt, signingJwk) {
  return verifySignedObject(receipt, signingJwk);
}
