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
    throw new Error('浏览器无法证明凭据是设备绑定的，请升级浏览器或使用硬件安全密钥');
  }
  const data = new Uint8Array(modern.getAuthenticatorData());
  if (data.length < 33) throw new Error('设备凭据返回的数据不完整');
  return data[32]!;
}

async function evaluatePrf(record: PlatformCredentialRecord): Promise<Uint8Array<ArrayBuffer>> {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: location.hostname,
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
  if (!(assertion instanceof PublicKeyCredential) || assertion.type !== 'public-key') {
    throw new Error('设备安全验证没有返回有效凭据');
  }
  if (toBase64Url(assertion.rawId) !== record.credentialId) throw new Error('设备安全凭据不匹配');
  const output = prfBytes(assertion);
  if (!output) throw new Error('设备安全凭据不支持保险库密钥派生');
  return output;
}

export function platformVaultSupported(): boolean {
  return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
}

export async function createPlatformCredential(): Promise<{
  record: PlatformCredentialRecord;
  prfOutput: Uint8Array<ArrayBuffer>;
}> {
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
        residentKey: 'preferred',
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
  const backupEligible = Boolean(flags & 0x08);
  if (backupEligible) {
    throw new Error('该凭据可能同步到其他设备。高安全模式需要不可同步的设备凭据或硬件安全密钥');
  }
  if (extensionResults(credential).prf?.enabled !== true) {
    throw new Error('该安全设备不支持 WebAuthn PRF，无法绑定保险库密钥');
  }
  const response = credential.response;
  const record: PlatformCredentialRecord = {
    credentialId: toBase64Url(credential.rawId),
    prfSalt: toBase64Url(prfSalt),
    transports: (response.getTransports?.() ?? []) as AuthenticatorTransport[],
    authenticatorAttachment: credential.authenticatorAttachment as AuthenticatorAttachment | null,
    backupEligible: false,
    createdAt: new Date().toISOString(),
  };
  const output = prfBytes(credential) ?? await evaluatePrf(record);
  prfSalt.fill(0);
  return { record, prfOutput: output };
}

export async function unlockPlatformCredential(record: PlatformCredentialRecord): Promise<Uint8Array<ArrayBuffer>> {
  requireWebAuthn();
  if (record.backupEligible !== false) throw new Error('保险库凭据不满足严格设备绑定要求');
  return evaluatePrf(record);
}

export function platformCredentialLabel(record: PlatformCredentialRecord): string {
  if (record.authenticatorAttachment === 'cross-platform') return '硬件安全密钥';
  if (record.authenticatorAttachment === 'platform') return '本机生物识别或设备密码';
  return '设备安全凭据';
}
