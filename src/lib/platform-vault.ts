import { fromBase64Url, toBase64Url } from './base64';
import type { PlatformCredentialRecord } from './types';

type PrfOutput = {
  enabled?: boolean;
  results?: { first?: ArrayBuffer; second?: ArrayBuffer };
};

type CredentialExtensionResults = AuthenticationExtensionsClientOutputs & {
  prf?: PrfOutput;
};

type PrfCredentialCreationOptions = CredentialCreationOptions & {
  publicKey: PublicKeyCredentialCreationOptions & {
    extensions: AuthenticationExtensionsClientInputs & {
      prf: { eval: { first: Uint8Array<ArrayBuffer>; second?: Uint8Array<ArrayBuffer> } };
    };
  };
};

type PrfCredentialRequestOptions = CredentialRequestOptions & {
  publicKey: PublicKeyCredentialRequestOptions & {
    extensions: AuthenticationExtensionsClientInputs & {
      prf: { eval: { first: Uint8Array<ArrayBuffer>; second?: Uint8Array<ArrayBuffer> } };
    };
  };
};

const encoder = new TextEncoder();
export const browserAccessPrfSalt = () => encoder.encode('quiet-room-browser-access-rendezvous-v1');
const assertionUsers = new WeakMap<Uint8Array<ArrayBuffer>, string>();
const accessPrfs = new WeakMap<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>();
/** Move the second PRF into the unlocked session; never persist it in a vault. */
export function takeBrowserAccessPrf(output: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | undefined {
  const access = accessPrfs.get(output); accessPrfs.delete(output); return access;
}

/**
 * A WebAuthn ceremony ended without a credential because the user or platform
 * cancelled it. The native exception is deliberately not retained as `cause`:
 * browser and authenticator messages can contain platform-specific details and
 * callers only need the stable cancellation classification.
 */
export class PlatformVaultCancellationError extends Error {
  readonly code = 'PLATFORM_VAULT_CANCELLED';

  constructor() {
    super('未完成设备安全验证');
    this.name = 'PlatformVaultCancellationError';
  }
}

export function isPlatformVaultCancellation(error: unknown): error is PlatformVaultCancellationError {
  return error instanceof PlatformVaultCancellationError;
}

function isNativeWebAuthnCancellation(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

async function runWebAuthnCeremony<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isNativeWebAuthnCancellation(error)) throw new PlatformVaultCancellationError();
    throw error;
  }
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function requireWebAuthn(): void {
  if (!window.isSecureContext) {
    throw new Error('当前连接不是浏览器信任的 HTTPS 安全环境。局域网测试请先信任开发证书，再重新打开此页面');
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('当前浏览器不支持通行密钥，请升级浏览器或改用支持 WebAuthn PRF 的浏览器');
  }
}

function extensionResults(credential: PublicKeyCredential): CredentialExtensionResults {
  return credential.getClientExtensionResults() as CredentialExtensionResults;
}

function prfBytes(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | null {
  const output = extensionResults(credential).prf?.results?.first;
  if (!output || output.byteLength !== 32) return null;
  const first = new Uint8Array(output), second = extensionResults(credential).prf?.results?.second;
  if (second?.byteLength === 32) accessPrfs.set(first, new Uint8Array(second.slice(0)));
  return first;
}

function authenticatorFlags(response: AuthenticatorAttestationResponse): number {
  const modern = response as AuthenticatorAttestationResponse & { getAuthenticatorData?: () => ArrayBuffer };
  if (typeof modern.getAuthenticatorData !== 'function') {
    throw new Error('浏览器无法读取通行密钥的安全属性，请升级浏览器或使用硬件安全密钥');
  }
  const data = new Uint8Array(modern.getAuthenticatorData());
  if (data.length < 33) throw new Error('设备凭据返回的数据不完整');
  return data[32]!;
}

function assertionFlags(response: AuthenticatorAssertionResponse): number {
  const data = new Uint8Array(response.authenticatorData);
  if (data.length < 33) throw new Error('通行密钥返回的数据不完整');
  return data[32]!;
}

function requireUserVerification(flags: number): void {
  // UP (bit 0) and UV (bit 2) are required by the request. Do not trust a
  // browser that returns a PRF value without proving user verification.
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) {
    throw new Error('通行密钥没有完成用户验证');
  }
}

async function evaluatePrf(record: PlatformCredentialRecord, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const rpId = record.rpId ?? location.hostname;
  if (rpId !== location.hostname) throw new Error(`此保险库绑定到 ${rpId}，当前域名无法使用原设备凭据`);
  const assertion = await runWebAuthnCeremony(() => navigator.credentials.get({
    signal,
    publicKey: {
      challenge: randomBytes(32),
      rpId,
      allowCredentials: [{
        type: 'public-key',
        id: fromBase64Url(record.credentialId),
        transports: record.transports,
      }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: fromBase64Url(record.prfSalt), second: browserAccessPrfSalt() } } },
    },
  } as PrfCredentialRequestOptions));
  if (
    !(assertion instanceof PublicKeyCredential) ||
    assertion.type !== 'public-key' ||
    !(assertion.response instanceof AuthenticatorAssertionResponse)
  ) {
    throw new Error('通行密钥验证没有返回有效凭据');
  }
  if (toBase64Url(assertion.rawId) !== record.credentialId) throw new Error('设备安全凭据不匹配');
  const flags = assertionFlags(assertion.response);
  requireUserVerification(flags);
  const backupEligible = Boolean(flags & 0x08);
  if (backupEligible !== record.backupEligible) throw new Error('通行密钥属性发生异常变化');
  const output = prfBytes(assertion);
  if (!output) throw new Error('该通行密钥不支持保险库密钥派生');
  const user = assertion.response.userHandle;
  if (user?.byteLength && user.byteLength <= 64) assertionUsers.set(output, toBase64Url(user));
  if (signal?.aborted) { output.fill(0); takeBrowserAccessPrf(output)?.fill(0); signal.throwIfAborted(); }
  return output;
}

export function platformVaultSupported(): boolean {
  return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
}

export type PlatformCredentialResult = {
  record: PlatformCredentialRecord;
  prfOutput: Uint8Array<ArrayBuffer>;
  /** Auxiliary purpose proof retained only for the current unlocked visit. */
  browserAccessPrf?: Uint8Array<ArrayBuffer>;
};

export async function createPlatformCredential(
  onCreated?: (record: PlatformCredentialRecord) => void,
  requestedName = defaultPasskeyName(),
): Promise<PlatformCredentialResult> {
  requireWebAuthn();
  const userName = normalizePasskeyName(requestedName), userId = randomBytes(32);
  const prfSalt = randomBytes(32);
  try {
    const credential = await runWebAuthnCeremony(() => navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { id: location.hostname, name: 'Quiet Room' },
        user: {
          id: userId,
          name: userName,
          displayName: userName,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -8 },
        ],
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        timeout: 60_000,
        attestation: 'none',
        extensions: { prf: { eval: { first: prfSalt, second: browserAccessPrfSalt() } } },
      },
    } as PrfCredentialCreationOptions));
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
      throw new Error('没有创建有效的设备安全凭据');
    }
    const flags = authenticatorFlags(credential.response);
    requireUserVerification(flags);
    const backupEligible = Boolean(flags & 0x08);
    if (extensionResults(credential).prf?.enabled !== true) {
      throw new Error('该通行密钥不支持 WebAuthn PRF，无法保护本机保险库');
    }
    const response = credential.response;
    const record: PlatformCredentialRecord = {
      credentialId: toBase64Url(credential.rawId),
      userId: toBase64Url(userId),
      userName,
      rpId: location.hostname,
      origin: location.origin,
      prfSalt: toBase64Url(prfSalt),
      transports: (response.getTransports?.() ?? []) as AuthenticatorTransport[],
      authenticatorAttachment: credential.authenticatorAttachment as AuthenticatorAttachment | null,
      backupEligible,
      createdAt: new Date().toISOString(),
    };
    // Registration is already durable in the authenticator at this point. Give
    // the caller the exact record before a possible fallback assertion so a
    // canceled PRF read can be retried without creating another orphan passkey.
    try { localStorage.setItem('quiet-room:passkey-sequence', String(passkeySequence())); } catch { /* Label hints are optional. */ }
    onCreated?.(structuredClone(record));
    const output = prfBytes(credential) ?? await evaluatePrf(record);
    return { record, prfOutput: output };
  } finally {
    prfSalt.fill(0);
  }
}

export async function unlockPlatformCredential(record: PlatformCredentialRecord, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  requireWebAuthn();
  return evaluatePrf(record, signal);
}

/**
 * Client-only material for the browser-access rendezvous. This is not a room
 * authorization or a remotely verified WebAuthn assertion. The PRF output must
 * never be sent to the service or reused as a vault wrapping key.
 *
 * With no local record, let the authenticator discover a credential for this RP.
 * A trusted endpoint can use its known record to prepare the same rendezvous.
 * Call directly from the user's click handler: no network or page transition
 * precedes the native ceremony, and cancellation never selects a fallback.
 */
export async function browserAccessCredential(
  signal?: AbortSignal,
  record?: PlatformCredentialRecord,
): Promise<{
  credentialId: string;
  rpId: string;
  origin: string;
  backupEligible: boolean;
  prfOutput: Uint8Array<ArrayBuffer>;
}> {
  requireWebAuthn();
  const rpId = location.hostname;
  if (record?.rpId && record.rpId !== rpId || record?.origin && record.origin !== location.origin) {
    throw new Error('此通行密钥绑定的来源与当前网站不一致');
  }
  const assertion = await runWebAuthnCeremony(() => navigator.credentials.get({
    signal,
    publicKey: {
      challenge: randomBytes(32),
      rpId,
      ...(record ? { allowCredentials: [{
        type: 'public-key', id: fromBase64Url(record.credentialId), transports: record.transports,
      }] } : {}),
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: browserAccessPrfSalt() } } },
    },
  } as PrfCredentialRequestOptions));
  if (!(assertion instanceof PublicKeyCredential) || assertion.type !== 'public-key' ||
    !(assertion.response instanceof AuthenticatorAssertionResponse) ||
    assertion.rawId.byteLength < 1 || assertion.rawId.byteLength > 1024) {
    throw new Error('通行密钥验证没有返回有效凭据');
  }
  const credentialId = toBase64Url(assertion.rawId);
  if (record && credentialId !== record.credentialId) throw new Error('设备安全凭据不匹配');
  const flags = assertionFlags(assertion.response);
  requireUserVerification(flags);
  const backupEligible = Boolean(flags & 0x08);
  if (record && backupEligible !== record.backupEligible) throw new Error('通行密钥属性发生异常变化');
  const prfOutput = prfBytes(assertion);
  if (!prfOutput) throw new Error('该通行密钥不支持安全接入，请在支持 WebAuthn PRF 的浏览器中重试');
  if (signal?.aborted) {
    prfOutput.fill(0);
    throw new PlatformVaultCancellationError();
  }
  return { credentialId, rpId, origin: location.origin, backupEligible, prfOutput };
}

export function platformCredentialLabel(record: PlatformCredentialRecord): string {
  if (record.authenticatorAttachment === 'cross-platform') return '硬件安全密钥';
  if (record.backupEligible) return '可同步通行密钥';
  if (record.authenticatorAttachment === 'platform') return '本机通行密钥';
  return '通行密钥';
}


export function normalizePasskeyName(value: string): string {
  if (value.length > 4096) throw new Error('名称过长，请使用简短名称');
  const name = value.trim();
  const length = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].length;
  if (!length || length > 40 || /[\p{Cc}\p{Zl}\p{Zp}\u200b\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error('请输入 1–40 个字符的名称，不包含控制字符');
  }
  return name;
}
function passkeySequence(): number {
  try { const previous = Number(localStorage.getItem('quiet-room:passkey-sequence')); return Number.isSafeInteger(previous) && previous >= 0 && previous < 9999 ? previous + 1 : 1; }
  catch { return 1; }
}
export function defaultPasskeyName(): string {
  const date = new Date();
  // A readable local hint, never a device fingerprint or a uniqueness claim.
  const suffix = String(passkeySequence()).padStart(2, '0');
  return `Quiet Room · ${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日 · ${suffix}`;
}
type UserDetailsApi = typeof PublicKeyCredential & {
  signalCurrentUserDetails?: (details: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
};
export function passkeyNamingSupported(): boolean {
  return platformVaultSupported() && typeof (PublicKeyCredential as UserDetailsApi).signalCurrentUserDetails === 'function';
}
/** Fresh assertion, bound to the credential AND the proof which unlocked the vault. */
export async function verifyPasskeyDetails(current: PlatformCredentialResult, signal: AbortSignal): Promise<string | undefined> {
  if (current.record.origin && current.record.origin !== location.origin) throw new Error('通行密钥来源不匹配');
  const output = await unlockPlatformCredential(current.record, signal);
  try {
    signal.throwIfAborted();
    let difference = output.length ^ current.prfOutput.length;
    for (let i = 0; i < output.length; i++) difference |= output[i]! ^ (current.prfOutput[i] ?? 0);
    if (difference) throw new Error('通行密钥验证结果不匹配');
    const userId = assertionUsers.get(output);
    if (current.record.userId && userId && current.record.userId !== userId) throw new Error('通行密钥用户标识不匹配');
    return current.record.userId ?? userId;
  } finally { output.fill(0); takeBrowserAccessPrf(output)?.fill(0); assertionUsers.delete(output); }
}
export async function signalPasskeyName(record: PlatformCredentialRecord, userId: string, value: string, signal: AbortSignal): Promise<void> {
  const name = normalizePasskeyName(value);
  if (!passkeyNamingSupported()) throw new Error('当前浏览器不支持修改系统通行密钥名称');
  if (!userId || fromBase64Url(userId).length > 64) throw new Error('无法取得通行密钥用户标识');
  if ((record.rpId ?? location.hostname) !== location.hostname || (record.origin && record.origin !== location.origin)) throw new Error('通行密钥来源不匹配');
  signal.throwIfAborted();
  await (PublicKeyCredential as UserDetailsApi).signalCurrentUserDetails!({ rpId: record.rpId ?? location.hostname, userId, name, displayName: name });
}
