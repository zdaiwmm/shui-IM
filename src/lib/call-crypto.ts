import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { isAuthenticatedCallRoster } from './call-membership';
import { CALL_CAPABILITY, CALL_PROTOCOL, type CallAction, type CallEnvelope, type CallPayload } from './call-types';
import type { RoomMember, Vault } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const ACTIONS = new Set<CallAction>(['invite', 'accept', 'signal', 'decline', 'end']);
const ENVELOPE_KEYS = ['v', 'protocol', 'roomId', 'callId', 'eventId', 'senderId', 'recipientId', 'action', 'createdAt', 'expiresAt', 'iv', 'ciphertext', 'signature'];
const MAX_SIGNAL_BYTES = 96 * 1024;
const IDENTIFIER = /^[a-zA-Z0-9_-]{8,128}$/;
const BASE64 = /^[a-zA-Z0-9_-]+$/;
const FINGERPRINT = /^a=fingerprint:sha-256 (?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function assert(condition: unknown, message = '通话安全验证失败'): asserts condition {
  if (!condition) throw new Error(message);
}

/** Only the already authenticated MLS roster may supply identity keys. */
export function trustedCallMember(vault: Vault, deviceId: string): RoomMember {
  const own = vault.members.find((member) => member.deviceId === vault.identity.publicBundle.deviceId);
  const peer = vault.members.find((member) => member.deviceId === deviceId);
  assert(vault.protocol === 'mls-rfc9420' && vault.mls?.phase === 'active', '安全会话尚未就绪');
  assert(isAuthenticatedCallRoster(vault), '通话成员尚未完成本机 MLS 身份验证');
  assert(own?.status === 'active' && own.role === vault.role && !own.revokedAt, '本设备已无法通话');
  assert(peer?.status === 'active' && !peer.revokedAt && peer.role !== own.role, '对方设备尚未通过验证');
  assert(peer.capabilities?.includes(CALL_CAPABILITY), '对方设备暂不支持实时通话');
  return peer;
}

/** Require DTLS-SRTP on every media section, with a signed SHA-256 fingerprint. */
function validDescription(value: unknown): value is RTCSessionDescriptionInit {
  if (!record(value) || !onlyKeys(value, ['type', 'sdp']) || !['offer', 'answer'].includes(String(value.type))) return false;
  if (typeof value.sdp !== 'string' || value.sdp.length < 40 || value.sdp.length > 64 * 1024 || value.sdp.includes('\0')) return false;
  const lines = value.sdp.split(/\r?\n/);
  if (lines[0] !== 'v=0') return false;
  const firstMedia = lines.findIndex((line) => line.startsWith('m='));
  if (firstMedia < 0) return false;
  const sessionFingerprint = lines.slice(0, firstMedia).some((line) => FINGERPRINT.test(line));
  let mediaSections = 0;
  let hasAudio = false;
  for (let index = firstMedia; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith('m=')) continue;
    const match = /^m=(audio|video) \d+ (?:UDP\/TLS|TCP\/DTLS)\/RTP\/SAVPF \d+(?: \d+)*$/.exec(line);
    if (!match || ++mediaSections > 4) return false;
    if (match[1] === 'audio') hasAudio = true;
    let end = index + 1;
    while (end < lines.length && !lines[end]!.startsWith('m=')) end += 1;
    if (!sessionFingerprint && !lines.slice(index + 1, end).some((item) => FINGERPRINT.test(item))) return false;
  }
  return hasAudio;
}

function validCandidate(value: unknown): value is RTCIceCandidateInit {
  if (!record(value) || !onlyKeys(value, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'])) return false;
  if (typeof value.candidate !== 'string' || value.candidate.length > 2048 || !value.candidate.startsWith('candidate:') || /[\r\n\0]/.test(value.candidate)) return false;
  if (value.sdpMid !== undefined && value.sdpMid !== null && (typeof value.sdpMid !== 'string' || value.sdpMid.length > 80)) return false;
  if (value.sdpMLineIndex !== undefined && value.sdpMLineIndex !== null && (!Number.isSafeInteger(value.sdpMLineIndex) || (value.sdpMLineIndex as number) < 0 || (value.sdpMLineIndex as number) > 16)) return false;
  if (value.usernameFragment !== undefined && value.usernameFragment !== null && (typeof value.usernameFragment !== 'string' || value.usernameFragment.length > 256)) return false;
  return value.sdpMid != null || value.sdpMLineIndex != null;
}

export function validateCallPayload(value: unknown, action: CallAction): asserts value is CallPayload {
  assert(record(value) && onlyKeys(value, ['kind', 'description', 'candidate', 'cameraEnabled', 'micMuted', 'reason']));
  assert(value.kind === 'audio' || value.kind === 'video');
  if (value.description !== undefined) assert(validDescription(value.description), '通话证书或媒体协商无效');
  if (value.candidate !== undefined) assert(validCandidate(value.candidate));
  if (value.cameraEnabled !== undefined) assert(typeof value.cameraEnabled === 'boolean');
  if (value.micMuted !== undefined) assert(typeof value.micMuted === 'boolean');
  if (value.reason !== undefined) assert(typeof value.reason === 'string' && value.reason.length <= 160);
  if (action === 'invite') assert(record(value.description) && value.description.type === 'offer' && value.candidate === undefined);
  if (action === 'accept') assert(record(value.description) && value.description.type === 'answer' && value.candidate === undefined);
  if (action === 'end' || action === 'decline') assert(value.description === undefined && value.candidate === undefined);
  if (action === 'signal') assert(value.description !== undefined || value.candidate !== undefined || value.cameraEnabled !== undefined || value.micMuted !== undefined);
}

function header(envelope: Omit<CallEnvelope, 'iv' | 'ciphertext' | 'signature'>) {
  return {
    v: envelope.v, protocol: envelope.protocol, roomId: envelope.roomId, callId: envelope.callId,
    eventId: envelope.eventId, senderId: envelope.senderId, recipientId: envelope.recipientId,
    action: envelope.action, createdAt: envelope.createdAt, expiresAt: envelope.expiresAt,
  };
}

async function deriveCallKey(vault: Vault, peer: RoomMember, metadata: ReturnType<typeof header>): Promise<CryptoKey> {
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey('jwk', vault.identity.encryptionPrivateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    crypto.subtle.importKey('jwk', peer.encryptionKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []),
  ]);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
  try {
    const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(metadata.callId),
      info: encoder.encode(canonicalStringify({ domain: `${CALL_PROTOCOL}:signaling:sender-to-recipient`, roomId: metadata.roomId, senderId: metadata.senderId, recipientId: metadata.recipientId })),
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    shared.fill(0);
  }
}

/** Signaling uses static device ECDH: it does not promise forward secrecy after device-key compromise. Media DTLS has separate ephemeral keys. */
export async function sealCallSignal(vault: Vault, recipientId: string, callId: string, action: CallAction, payload: CallPayload, now = Date.now()): Promise<CallEnvelope> {
  const peer = trustedCallMember(vault, recipientId);
  assert(IDENTIFIER.test(callId) && IDENTIFIER.test(vault.roomId) && ACTIONS.has(action));
  assert(Number.isSafeInteger(now) && now > 0);
  validateCallPayload(payload, action);
  const metadata = header({
    v: 1, protocol: CALL_PROTOCOL, roomId: vault.roomId, callId, eventId: crypto.randomUUID(),
    senderId: vault.identity.publicBundle.deviceId, recipientId, action, createdAt: now,
    expiresAt: now + (action === 'invite' ? 45_000 : 30_000),
  });
  const key = await deriveCallKey(vault, peer, metadata);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(canonicalStringify(metadata)), tagLength: 128 }, key, encoder.encode(JSON.stringify(payload)));
  const unsigned = { ...metadata, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
  const signingKey = await crypto.subtle.importKey('jwk', vault.identity.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, encoder.encode(canonicalStringify(unsigned)));
  return { ...unsigned, signature: toBase64Url(signature) };
}

export async function openCallSignal(vault: Vault, envelope: CallEnvelope, now = Date.now()): Promise<CallPayload> {
  assert(record(envelope) && Object.keys(envelope).length === ENVELOPE_KEYS.length && onlyKeys(envelope, ENVELOPE_KEYS));
  assert(envelope.v === 1 && envelope.protocol === CALL_PROTOCOL && envelope.roomId === vault.roomId);
  assert(envelope.recipientId === vault.identity.publicBundle.deviceId && envelope.senderId !== envelope.recipientId);
  for (const id of [envelope.callId, envelope.roomId, envelope.eventId, envelope.senderId, envelope.recipientId]) assert(typeof id === 'string' && IDENTIFIER.test(id));
  assert(ACTIONS.has(envelope.action));
  assert(Number.isSafeInteger(envelope.createdAt) && Number.isSafeInteger(envelope.expiresAt));
  assert(envelope.createdAt > 0 && envelope.createdAt <= now + 10_000 && envelope.expiresAt > now && envelope.expiresAt > envelope.createdAt && envelope.expiresAt - envelope.createdAt <= (envelope.action === 'invite' ? 45_000 : 30_000), '通话请求已过期');
  for (const value of [envelope.iv, envelope.ciphertext, envelope.signature]) assert(typeof value === 'string' && value.length <= MAX_SIGNAL_BYTES && BASE64.test(value));
  assert(fromBase64Url(envelope.iv).length === 12 && fromBase64Url(envelope.signature).length === 64 && fromBase64Url(envelope.ciphertext).length >= 16);
  const peer = trustedCallMember(vault, envelope.senderId);
  const { signature, ...unsigned } = envelope;
  const signingKey = await crypto.subtle.importKey('jwk', peer.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, fromBase64Url(signature), encoder.encode(canonicalStringify(unsigned))));
  const metadata = header(envelope);
  const key = await deriveCallKey(vault, peer, metadata);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(envelope.iv), additionalData: encoder.encode(canonicalStringify(metadata)), tagLength: 128 }, key, fromBase64Url(envelope.ciphertext));
  const payload: unknown = JSON.parse(decoder.decode(plaintext));
  validateCallPayload(payload, envelope.action);
  // A membership removal that happened during crypto must be honored by the controller too.
  return payload;
}
