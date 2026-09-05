import { fromBase64Url, toBase64Url } from './base64';

export type ParticipantInvite = {
  v: 1;
  roomId: string;
  accessToken: string;
  pairingSecret: string;
  creatorFingerprint: string;
};

export type DeviceInvite = {
  v: 1;
  kind: 'device-link';
  roomId: string;
  linkId: string;
  secret: string;
  role: 'creator' | 'joiner';
  authorizerId: string;
  authorizerFingerprint: string;
  creatorFingerprint: string;
  expiresAt: string;
};

export type ParsedInviteLink =
  | { kind: 'participant'; invite: ParticipantInvite }
  | { kind: 'device'; invite: DeviceInvite };

export type InviteLinkClassification = ParsedInviteLink | { kind: 'invalid' };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;
const FINGERPRINT_LENGTH = 43;
const MIN_CAPABILITY_LENGTH = 32;
const MAX_CAPABILITY_LENGTH = 512;
const MAX_ENCODED_INVITE_LENGTH = 4096;

const participantKeys = ['accessToken', 'creatorFingerprint', 'pairingSecret', 'roomId', 'v'] as const;
const deviceKeys = [
  'authorizerFingerprint',
  'authorizerId',
  'creatorFingerprint',
  'expiresAt',
  'kind',
  'linkId',
  'role',
  'roomId',
  'secret',
  'v',
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBase64UrlWithin(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum && BASE64_URL.test(value);
}

function isFingerprint(value: unknown): value is string {
  return isBase64UrlWithin(value, FINGERPRINT_LENGTH, FINGERPRINT_LENGTH);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function participantInvite(value: unknown): ParticipantInvite | null {
  if (!isRecord(value) || !hasExactKeys(value, participantKeys)) return null;
  if (
    value.v !== 1 ||
    typeof value.roomId !== 'string' || !UUID_V4.test(value.roomId) ||
    !isBase64UrlWithin(value.accessToken, MIN_CAPABILITY_LENGTH, MAX_CAPABILITY_LENGTH) ||
    !isBase64UrlWithin(value.pairingSecret, MIN_CAPABILITY_LENGTH, MAX_CAPABILITY_LENGTH) ||
    !isFingerprint(value.creatorFingerprint)
  ) return null;
  return {
    v: 1,
    roomId: value.roomId,
    accessToken: value.accessToken,
    pairingSecret: value.pairingSecret,
    creatorFingerprint: value.creatorFingerprint,
  };
}

function deviceInvite(value: unknown): DeviceInvite | null {
  if (!isRecord(value) || !hasExactKeys(value, deviceKeys)) return null;
  if (
    value.v !== 1 ||
    value.kind !== 'device-link' ||
    typeof value.roomId !== 'string' || !UUID_V4.test(value.roomId) ||
    typeof value.linkId !== 'string' || !UUID_V4.test(value.linkId) ||
    !isBase64UrlWithin(value.secret, MIN_CAPABILITY_LENGTH, MAX_CAPABILITY_LENGTH) ||
    (value.role !== 'creator' && value.role !== 'joiner') ||
    typeof value.authorizerId !== 'string' || !UUID_V4.test(value.authorizerId) ||
    !isFingerprint(value.authorizerFingerprint) ||
    !isFingerprint(value.creatorFingerprint) ||
    !isCanonicalTimestamp(value.expiresAt)
  ) return null;
  return {
    v: 1,
    kind: 'device-link',
    roomId: value.roomId,
    linkId: value.linkId,
    secret: value.secret,
    role: value.role,
    authorizerId: value.authorizerId,
    authorizerFingerprint: value.authorizerFingerprint,
    creatorFingerprint: value.creatorFingerprint,
    expiresAt: value.expiresAt,
  };
}

function decodeInvite(encoded: string): unknown {
  if (!encoded || encoded.length > MAX_ENCODED_INVITE_LENGTH || !BASE64_URL.test(encoded)) return null;
  try {
    return JSON.parse(decoder.decode(fromBase64Url(encoded)));
  } catch {
    return null;
  }
}

export function classifyInviteHash(hash: string): InviteLinkClassification {
  if (typeof hash !== 'string') return { kind: 'invalid' };
  const source = hash.startsWith('#') ? hash.slice(1) : hash;
  const parameters = new URLSearchParams(source);
  const entries = [...parameters.entries()];
  if (entries.length !== 1) return { kind: 'invalid' };
  const [key, encoded] = entries[0]!;
  const decoded = decodeInvite(encoded);
  if (key === 'invite') {
    const invite = participantInvite(decoded);
    return invite ? { kind: 'participant', invite } : { kind: 'invalid' };
  }
  if (key === 'device') {
    const invite = deviceInvite(decoded);
    return invite ? { kind: 'device', invite } : { kind: 'invalid' };
  }
  return { kind: 'invalid' };
}

function browserBaseUrl(): string | null {
  return typeof location === 'undefined' ? null : location.href;
}

export function parseInviteText(value: string, baseUrl?: string | URL): InviteLinkClassification {
  if (typeof value !== 'string' || !value.trim()) return { kind: 'invalid' };
  const base = baseUrl ?? browserBaseUrl();
  if (!base) return { kind: 'invalid' };
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'invalid' };
    return classifyInviteHash(url.hash);
  } catch {
    return { kind: 'invalid' };
  }
}

function validBaseUrl(baseUrl?: string | URL): URL {
  const base = baseUrl ?? browserBaseUrl();
  if (!base) throw new TypeError('A base URL is required');
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Invalid base URL');
  return url;
}

function encodedInvite(value: ParticipantInvite | DeviceInvite): string {
  return toBase64Url(encoder.encode(JSON.stringify(value)));
}

export function makeParticipantInviteUrl(invite: ParticipantInvite, baseUrl?: string | URL): string {
  const validated = participantInvite(invite);
  if (!validated) throw new TypeError('Invalid participant invite');
  const base = validBaseUrl(baseUrl);
  return `${base.origin}${base.pathname}#invite=${encodedInvite(validated)}`;
}

export function makeDeviceInviteUrl(invite: DeviceInvite, baseUrl?: string | URL): string {
  const validated = deviceInvite(invite);
  if (!validated) throw new TypeError('Invalid device invite');
  const base = validBaseUrl(baseUrl);
  return `${base.origin}${base.pathname}#device=${encodedInvite(validated)}`;
}
