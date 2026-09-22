import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformCredential,
  browserAccessCredential,
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

  it('allows any resident PRF-capable authenticator for setup', async () => {
    const credential = new FakePublicKeyCredential(
      new FakeAttestationResponse(),
      {
        prf: {
          enabled: true,
          results: { first: new Uint8Array(32).fill(7).buffer },
        },
      } as AuthenticationExtensionsClientOutputs,
    );
    const create = vi.fn().mockResolvedValue(credential as unknown as Credential);
    installCredentials({ create });

    await createPlatformCredential();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: expect.objectContaining({
        rp: { id: 'ai.shui.click', name: 'Quiet Room' },
        authenticatorSelection: expect.objectContaining({
          residentKey: 'required',
          userVerification: 'required',
        }),
      }),
    }));
    expect(create.mock.calls[0]![0]!.publicKey!.authenticatorSelection).not.toHaveProperty('authenticatorAttachment');
  });

  it('separates an untrusted HTTPS context from browser capability failures', async () => {
    vi.stubGlobal('navigator', { credentials: {} });
    vi.stubGlobal('window', { isSecureContext: false, PublicKeyCredential: FakePublicKeyCredential });
    await expect(createPlatformCredential()).rejects.toThrow('浏览器信任的 HTTPS');
  });

  it('reports a missing WebAuthn API without blaming the certificate', async () => {
    vi.stubGlobal('navigator', { credentials: undefined });
    vi.stubGlobal('window', { isSecureContext: true, PublicKeyCredential: undefined });
    await expect(createPlatformCredential()).rejects.toThrow('当前浏览器不支持通行密钥');
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

  it('starts browser discovery immediately, without a local ID or network lookup', async () => {
    const get = vi.fn().mockResolvedValue(new FakePublicKeyCredential(new FakeAssertionResponse(), {
      prf: { results: { first: new Uint8Array(32).fill(9).buffer } },
    } as AuthenticationExtensionsClientOutputs));
    installCredentials({ get });
    const pending = browserAccessCredential();
    expect(get).toHaveBeenCalledTimes(1); // Native UI starts in the click's call stack.
    const result = await pending;
    expect(result).toMatchObject({ credentialId: record.credentialId, rpId: record.rpId,
      origin: record.origin, backupEligible: false, prfOutput: new Uint8Array(32).fill(9) });
    const options = get.mock.calls[0]![0]!.publicKey;
    expect(options).not.toHaveProperty('allowCredentials');
    expect(options.userVerification).toBe('required');
    expect(new TextDecoder().decode(options.extensions.prf.eval.first)).toBe('quiet-room-browser-access-rendezvous-v1');
    await browserAccessCredential();
    expect(get.mock.calls[1]![0]!.publicKey.challenge).not.toEqual(options.challenge);
  });

  it('uses the same purpose-specific PRF input when preparing a known credential', async () => {
    const get = vi.fn().mockResolvedValue(new FakePublicKeyCredential(new FakeAssertionResponse(), {
      prf: { results: { first: new Uint8Array(32).fill(9).buffer } },
    } as AuthenticationExtensionsClientOutputs));
    installCredentials({ get });
    await browserAccessCredential(undefined, record);
    await browserAccessCredential();
    const known = get.mock.calls[0]![0]!.publicKey;
    expect(known.allowCredentials[0].id).toEqual(rawId);
    expect(known.extensions).toEqual(get.mock.calls[1]![0]!.publicKey.extensions);
    expect(known.extensions.prf.eval.first).not.toEqual(new Uint8Array(32));
  });

  it.each(['NotAllowedError', 'AbortError'])('does not retry or downgrade canceled discovery (%s)', async name => {
    const get = vi.fn().mockRejectedValue(new DOMException('private platform detail', name));
    installCredentials({ get });
    await expect(browserAccessCredential()).rejects.toSatisfy(isPlatformVaultCancellation);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([0x00, 0x01, 0x04])('rejects discovery without both UP and UV (%s)', async flags => {
    const response = new FakeAssertionResponse();
    new Uint8Array(response.authenticatorData)[32] = flags;
    installCredentials({ get: vi.fn().mockResolvedValue(new FakePublicKeyCredential(response, {
      prf: { results: { first: new Uint8Array(32).buffer } },
    } as AuthenticationExtensionsClientOutputs)) });
    await expect(browserAccessCredential()).rejects.toThrow('没有完成用户验证');
  });

  it.each([undefined, new ArrayBuffer(31), new ArrayBuffer(33)])('fails closed when a discovered credential has no valid PRF output', async first => {
    installCredentials({ get: vi.fn().mockResolvedValue(new FakePublicKeyCredential(new FakeAssertionResponse(), {
      prf: { results: { first } },
    } as AuthenticationExtensionsClientOutputs)) });
    await expect(browserAccessCredential()).rejects.toThrow('不支持安全接入');
  });

  it('does not use a known credential on a different origin', async () => {
    const get = vi.fn();
    installCredentials({ get });
    await expect(browserAccessCredential(undefined, { ...record, origin: 'https://other.example' })).rejects.toThrow('来源');
    expect(get).not.toHaveBeenCalled();
  });

  it('discards PRF output if the lifecycle ends while the native dialog is open', async () => {
    const controller = new AbortController(), output = new Uint8Array(32).fill(9);
    installCredentials({ get: vi.fn().mockImplementation(async () => {
      controller.abort();
      return new FakePublicKeyCredential(new FakeAssertionResponse(), {
        prf: { results: { first: output.buffer } },
      } as AuthenticationExtensionsClientOutputs);
    }) });
    await expect(browserAccessCredential(controller.signal)).rejects.toSatisfy(isPlatformVaultCancellation);
    expect(output.every(value => value === 0)).toBe(true);
  });
});
