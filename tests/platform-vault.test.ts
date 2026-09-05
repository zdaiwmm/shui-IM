import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformCredential,
  isPlatformVaultCancellation,
  PlatformVaultCancellationError,
  unlockPlatformCredential,
} from '../src/lib/platform-vault';
import type { PlatformCredentialRecord } from '../src/lib/types';

const rawId = new Uint8Array([1, 2, 3, 4]);

class FakeAttestationResponse {
  getAuthenticatorData(): ArrayBuffer {
    const data = new Uint8Array(33);
    data[32] = 0x05;
    return data.buffer;
  }

  getTransports(): AuthenticatorTransport[] {
    return ['internal'];
  }
}

class FakeAssertionResponse {
  readonly authenticatorData: ArrayBuffer;

  constructor() {
    const data = new Uint8Array(33);
    data[32] = 0x05;
    this.authenticatorData = data.buffer;
  }
}

class FakePublicKeyCredential {
  readonly type = 'public-key';
  readonly rawId = rawId;
  readonly authenticatorAttachment = 'platform';

  constructor(
    readonly response: FakeAttestationResponse | FakeAssertionResponse,
    private readonly extensions: AuthenticationExtensionsClientOutputs = {},
  ) {}

  getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
    return this.extensions;
  }
}

const record: PlatformCredentialRecord = {
  credentialId: 'AQIDBA',
  rpId: 'ai.shui.click',
  origin: 'https://ai.shui.click',
  prfSalt: 'A'.repeat(43),
  transports: ['internal'],
  authenticatorAttachment: 'platform',
  backupEligible: false,
  createdAt: '2026-09-05T00:00:00.000Z',
};

describe('platform vault WebAuthn cancellation', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { hostname: 'ai.shui.click', origin: 'https://ai.shui.click' });
    vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential);
    vi.stubGlobal('AuthenticatorAttestationResponse', FakeAttestationResponse);
    vi.stubGlobal('AuthenticatorAssertionResponse', FakeAssertionResponse);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function installCredentials(credentials: Partial<CredentialsContainer>): void {
    vi.stubGlobal('navigator', { credentials });
    vi.stubGlobal('window', { isSecureContext: true, PublicKeyCredential: FakePublicKeyCredential });
  }

  it.each(['NotAllowedError', 'AbortError'] as const)(
    'normalizes %s from credential creation without retaining native details',
    async (name) => {
      const native = new DOMException('native authenticator detail must not escape', name);
      installCredentials({ create: vi.fn().mockRejectedValue(native) });

      let caught: unknown;
      try {
        await createPlatformCredential();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(PlatformVaultCancellationError);
      expect(isPlatformVaultCancellation(caught)).toBe(true);
      expect(caught).not.toBe(native);
      expect(String(caught)).not.toContain(native.message);
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it.each(['NotAllowedError', 'AbortError'] as const)(
    'normalizes %s from credential assertion',
    async (name) => {
      installCredentials({ get: vi.fn().mockRejectedValue(new DOMException('native detail', name)) });

      await expect(unlockPlatformCredential(record)).rejects.toSatisfy(isPlatformVaultCancellation);
    },
  );

  it('also normalizes cancellation from the PRF assertion fallback after creation', async () => {
    const credential = new FakePublicKeyCredential(
      new FakeAttestationResponse(),
      { prf: { enabled: true } } as AuthenticationExtensionsClientOutputs,
    );
    const create = vi.fn().mockResolvedValue(credential as unknown as Credential);
    const get = vi.fn().mockRejectedValue(new DOMException('fallback detail', 'NotAllowedError'));
    installCredentials({
      create,
      get,
    });

    let createdRecord: PlatformCredentialRecord | null = null;
    await expect(createPlatformCredential(value => { createdRecord = value; })).rejects.toSatisfy(isPlatformVaultCancellation);
    expect(createdRecord).toMatchObject({ credentialId: 'AQIDBA', rpId: 'ai.shui.click' });
    expect(create).toHaveBeenCalledTimes(1);
    get.mockResolvedValue(new FakePublicKeyCredential(
      new FakeAssertionResponse(),
      { prf: { results: { first: new Uint8Array(32).fill(7).buffer } } } as AuthenticationExtensionsClientOutputs,
    ) as unknown as Credential);
    await expect(unlockPlatformCredential(createdRecord!)).resolves.toEqual(new Uint8Array(32).fill(7));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not classify policy failures or post-assertion credential mismatches as cancellation', async () => {
    const policyFailure = new DOMException('RP policy failure', 'SecurityError');
    installCredentials({ get: vi.fn().mockRejectedValue(policyFailure) });
    await expect(unlockPlatformCredential(record)).rejects.toBe(policyFailure);
    expect(isPlatformVaultCancellation(policyFailure)).toBe(false);

    const wrongCredential = new FakePublicKeyCredential(new FakeAssertionResponse());
    Object.defineProperty(wrongCredential, 'rawId', { value: new Uint8Array([9, 9, 9, 9]) });
    installCredentials({ get: vi.fn().mockResolvedValue(wrongCredential as unknown as Credential) });
    await expect(unlockPlatformCredential(record)).rejects.toThrow('设备安全凭据不匹配');
  });

  it('only recognizes the explicit normalized cancellation type', () => {
    expect(isPlatformVaultCancellation(new PlatformVaultCancellationError())).toBe(true);
    expect(isPlatformVaultCancellation(new DOMException('cancelled elsewhere', 'AbortError'))).toBe(false);
    expect(isPlatformVaultCancellation(new Error('未完成设备安全验证'))).toBe(false);
  });
});
