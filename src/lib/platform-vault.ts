import { fromBase64Url, toBase64Url } from './base64';
import type { PlatformCredentialRecord } from './types';

type PrfOutput = {
  enabled?: boolean;
  results?: { first?: ArrayBuffer };
};

type CredentialExtensionResults = AuthenticationExtensionsClientOutputs & {
  prf?: PrfOutput;
};

type PrfCredentialCreationOptions = CredentialCreationOptions & {
  publicKey: PublicKeyCredentialCreationOptions & {
    extensions: AuthenticationExtensionsClientInputs & {
      prf: { eval: { first: Uint8Array<ArrayBuffer> } };
    };
  };
};

type PrfCredentialRequestOptions = CredentialRequestOptions & {
  publicKey: PublicKeyCredentialRequestOptions & {
    extensions: AuthenticationExtensionsClientInputs & {
      prf: { eval: { first: Uint8Array<ArrayBuffer> } };
    };
  };
};

const encoder = new TextEncoder();

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function requireWebAuthn(): void {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('当前环境不支持安全的设备密钥，请使用最新版浏览器并通过 HTTPS 打开');
  }
}

function extensionResults(credential: PublicKeyCredential): CredentialExtensionResults {
  return credential.getClientExtensionResults() as CredentialExtensionResults;
}

function prfBytes(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | null {
  const output = extensionResults(credential).prf?.results?.first;
  if (!output || output.byteLength !== 32) return null;
  return new Uint8Array(output);
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

async function evaluatePrf(record: PlatformCredentialRecord): Promise<Uint8Array<ArrayBuffer>> {
  const rpId = record.rpId ?? location.hostname;
  if (rpId !== location.hostname) throw new Error(`此保险库绑定到 ${rpId}，当前域名无法使用原设备凭据`);
  const assertion = await navigator.credentials.get({
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
      extensions: { prf: { eval: { first: fromBase64Url(record.prfSalt) } } },
    },
  } as PrfCredentialRequestOptions);
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
  return output;
}

export function platformVaultSupported(): boolean {
  return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
}

export type PlatformCredentialResult = {
  record: PlatformCredentialRecord;
  prfOutput: Uint8Array<ArrayBuffer>;
};

export async function createPlatformCredential(): Promise<PlatformCredentialResult> {
  requireWebAuthn();
  const prfSalt = randomBytes(32);
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { id: location.hostname, name: 'Quiet Room' },
      user: {
        id: randomBytes(32),
        name: `vault-${crypto.randomUUID()}`,
        displayName: 'Quiet Room 本机保险库',
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
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  } as PrfCredentialCreationOptions);
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
    rpId: location.hostname,
    origin: location.origin,
    prfSalt: toBase64Url(prfSalt),
    transports: (response.getTransports?.() ?? []) as AuthenticatorTransport[],
    authenticatorAttachment: credential.authenticatorAttachment as AuthenticatorAttachment | null,
    backupEligible,
    createdAt: new Date().toISOString(),
  };
  const output = prfBytes(credential) ?? await evaluatePrf(record);
  prfSalt.fill(0);
  return { record, prfOutput: output };
}

export async function unlockPlatformCredential(record: PlatformCredentialRecord): Promise<Uint8Array<ArrayBuffer>> {
  requireWebAuthn();
  return evaluatePrf(record);
}

export function platformCredentialLabel(record: PlatformCredentialRecord): string {
  if (record.authenticatorAttachment === 'cross-platform') return '硬件安全密钥';
  if (record.backupEligible) return '可同步通行密钥';
  if (record.authenticatorAttachment === 'platform') return '本机通行密钥';
  return '通行密钥';
}
