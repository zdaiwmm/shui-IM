import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { generateMlsKeyMaterial } from './mls';
import { isMessagePayload } from './message-payload';
import type {
  DeliveryReceipt,
  MessageEnvelope,
  MessagePayload,
  PrivateIdentity,
  PublicBundle,
  RoomMember,
  Vault,
} from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function aesParams(iv: Uint8Array<ArrayBuffer>, additionalData: Uint8Array<ArrayBuffer>): AesGcmParams {
  return { name: 'AES-GCM', iv, additionalData, tagLength: 128 };
}

export async function generateIdentity(): Promise<PrivateIdentity> {
  const encryptionPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const signingPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const deviceId = crypto.randomUUID();
  const [encryptionKey, encryptionPrivateKey, signingKey, signingPrivateKey] = await Promise.all([
    crypto.subtle.exportKey('jwk', encryptionPair.publicKey),
    crypto.subtle.exportKey('jwk', encryptionPair.privateKey),
    crypto.subtle.exportKey('jwk', signingPair.publicKey),
    crypto.subtle.exportKey('jwk', signingPair.privateKey),
  ]);
  const mls = await generateMlsKeyMaterial(deviceId, signingPrivateKey);
  return {
    publicBundle: { deviceId, encryptionKey, signingKey, mlsKeyPackage: mls.mlsKeyPackage },
    encryptionPrivateKey,
    signingPrivateKey,
    mlsPrivatePackage: mls.mlsPrivatePackage,
  };
}

export async function bundleFingerprint(bundle: PublicBundle): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalStringify(bundle)));
  return toBase64Url(digest);
}

export async function createJoinProof(pairingSecret: string, bundle: PublicBundle): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(pairingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalStringify(bundle))));
}

export async function verifyJoinProof(pairingSecret: string, bundle: PublicBundle, proof: string): Promise<boolean> {
  try {
    const expected = fromBase64Url(await createJoinProof(pairingSecret, bundle));
    const actual = fromBase64Url(proof);
    if (expected.length !== actual.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) difference |= expected[index]! ^ actual[index]!;
    return difference === 0;
  } catch {
    return false;
  }
}

function receiptBody(receipt: Omit<DeliveryReceipt, 'signature'>) {
  return {
    v: receipt.v,
    roomId: receipt.roomId,
    clientMsgId: receipt.clientMsgId,
    seq: receipt.seq,
    receiverId: receipt.receiverId,
    receivedAt: receipt.receivedAt,
  };
}

export async function createDeliveryReceipt(
  vault: Vault,
  message: { seq: number; envelope: MessageEnvelope },
): Promise<DeliveryReceipt> {
  if (message.envelope.roomId !== vault.roomId) throw new Error('回执会话不匹配');
  if (message.envelope.senderId === vault.identity.publicBundle.deviceId) throw new Error('不能为本机消息创建对端回执');
  const unsigned = receiptBody({
    v: 1,
    roomId: vault.roomId,
    clientMsgId: message.envelope.clientMsgId,
    seq: message.seq,
    receiverId: vault.identity.publicBundle.deviceId,
    receivedAt: new Date().toISOString(),
  });
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    vault.identity.signingPrivateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    encoder.encode(canonicalStringify(unsigned)),
  );
  return { ...unsigned, signature: toBase64Url(signature) };
}

export async function verifyDeliveryReceipt(vault: Vault, receipt: DeliveryReceipt): Promise<boolean> {
  if (
    receipt.v !== 1 ||
    receipt.roomId !== vault.roomId ||
    !Number.isSafeInteger(receipt.seq) ||
    receipt.seq < 1 ||
    !receipt.clientMsgId ||
    !receipt.receivedAt
  ) return false;
  const receiver = vault.members.find((member) => member.deviceId === receipt.receiverId);
  if (!receiver) return false;
  const { signature, ...unsigned } = receipt;
  try {
    const signingKey = await crypto.subtle.importKey(
      'jwk',
      receiver.signingKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      fromBase64Url(signature),
      encoder.encode(canonicalStringify(receiptBody(unsigned))),
    );
  } catch {
    return false;
  }
}

async function importEcdhPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function importEcdhPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

async function deriveWrapKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: string,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const keyMaterial = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function envelopeHeader(roomId: string, clientMsgId: string, senderId: string, ephemeralPublicKey: JsonWebKey) {
  return { v: 1 as const, roomId, clientMsgId, senderId, ephemeralPublicKey };
}

export async function encryptMessage(vault: Vault, payload: MessagePayload, clientMsgId: string = crypto.randomUUID()): Promise<MessageEnvelope> {
  if (vault.members.length !== 2) throw new Error('会话尚未完成双设备绑定');
  if (!vault.members.some((member) => member.deviceId === vault.identity.publicBundle.deviceId)) {
    throw new Error('本设备不在会话成员中');
  }

  const ephemeralPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const ephemeralPublicKey = await crypto.subtle.exportKey('jwk', ephemeralPair.publicKey);
  const header = envelopeHeader(vault.roomId, clientMsgId, vault.identity.publicBundle.deviceId, ephemeralPublicKey);
  const headerBytes = encoder.encode(canonicalStringify(header));
  const contentKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const contentKey = await crypto.subtle.importKey('raw', contentKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const contentIv = crypto.getRandomValues(new Uint8Array(12));
  const contentCiphertext = await crypto.subtle.encrypt(
    aesParams(contentIv, headerBytes),
    contentKey,
    encoder.encode(JSON.stringify(payload)),
  );

  const recipients = await Promise.all(vault.members.map(async (member: RoomMember) => {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const recipientPublicKey = await importEcdhPublic(member.encryptionKey);
    const wrapKey = await deriveWrapKey(
      ephemeralPair.privateKey,
      recipientPublicKey,
      salt,
      `quiet-room-wrap-v1:${vault.roomId}:${clientMsgId}:${member.deviceId}`,
    );
    const wrapAad = encoder.encode(canonicalStringify({ ...header, recipientId: member.deviceId }));
    const wrappedKey = await crypto.subtle.encrypt(aesParams(iv, wrapAad), wrapKey, contentKeyBytes);
    return {
      deviceId: member.deviceId,
      salt: toBase64Url(salt),
      iv: toBase64Url(iv),
      wrappedKey: toBase64Url(wrappedKey),
    };
  }));
  recipients.sort((left, right) => left.deviceId.localeCompare(right.deviceId));

  const unsigned = {
    ...header,
    content: { iv: toBase64Url(contentIv), ciphertext: toBase64Url(contentCiphertext) },
    recipients,
  };
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    vault.identity.signingPrivateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    encoder.encode(canonicalStringify(unsigned)),
  );
  return { ...unsigned, signature: toBase64Url(signature) };
}

export async function decryptMessage(vault: Vault, envelope: MessageEnvelope): Promise<MessagePayload> {
  if (envelope.v !== 1 || envelope.roomId !== vault.roomId) throw new Error('消息协议或会话不匹配');
  const sender = vault.members.find((member) => member.deviceId === envelope.senderId);
  if (!sender) throw new Error('消息发送设备不属于当前会话');
  const { signature, ...unsigned } = envelope;
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    sender.signingKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const authentic = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    fromBase64Url(signature),
    encoder.encode(canonicalStringify(unsigned)),
  );
  if (!authentic) throw new Error('消息签名验证失败');

  const recipient = envelope.recipients.find((entry) => entry.deviceId === vault.identity.publicBundle.deviceId);
  if (!recipient) throw new Error('消息没有为本设备加密');
  const privateKey = await importEcdhPrivate(vault.identity.encryptionPrivateKey);
  const ephemeralPublicKey = await importEcdhPublic(envelope.ephemeralPublicKey);
  const wrapKey = await deriveWrapKey(
    privateKey,
    ephemeralPublicKey,
    fromBase64Url(recipient.salt),
    `quiet-room-wrap-v1:${vault.roomId}:${envelope.clientMsgId}:${recipient.deviceId}`,
  );
  const header = envelopeHeader(envelope.roomId, envelope.clientMsgId, envelope.senderId, envelope.ephemeralPublicKey);
  const wrapAad = encoder.encode(canonicalStringify({ ...header, recipientId: recipient.deviceId }));
  const contentKeyBytes = await crypto.subtle.decrypt(
    aesParams(fromBase64Url(recipient.iv), wrapAad),
    wrapKey,
    fromBase64Url(recipient.wrappedKey),
  );
  const contentKey = await crypto.subtle.importKey('raw', contentKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    aesParams(fromBase64Url(envelope.content.iv), encoder.encode(canonicalStringify(header))),
    contentKey,
    fromBase64Url(envelope.content.ciphertext),
  );
  const payload: unknown = JSON.parse(decoder.decode(plaintext));
  if (!isMessagePayload(payload)) throw new Error('消息明文格式不正确');
  return payload;
}
