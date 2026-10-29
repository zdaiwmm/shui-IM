import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminConfigId, encodeBase32, makeAdminConfig, totp, validateAdminConfig, verifyAdmin } from '../server/admin-auth.mjs';

// RFC 6238's public SHA-1 test vector, not an enrolled administrator secret.
const testSecret = encodeBase32(Buffer.from('12345678901234567890'));

describe('TOTP-only administrator factors', () => {
  it('creates a validated configuration without a password or password hash', async () => {
    const config = await makeAdminConfig();
    expect(config.v).toBe(2);
    expect(Object.keys(config).sort()).toEqual(['totpSecret', 'v']);
    expect(validateAdminConfig(config)).toBe(config);
    expect(await verifyAdmin(config, totp(config.totpSecret))).toBeGreaterThan(0);
    expect(() => validateAdminConfig({ v: 2, totpSecret: 'invalid' })).toThrow('INVALID_ADMIN_CONFIG');
    expect(() => validateAdminConfig({ v: 3, totpSecret: testSecret })).toThrow('INVALID_ADMIN_CONFIG');
  });

  it('preserves legacy configuration identity and binding while ignoring its retired password hash', async () => {
    const legacy = { v: 1, salt: Buffer.alloc(32, 1).toString('base64url'), hash: Buffer.alloc(32, 2).toString('base64url'), totpSecret: testSecret };
    const before = JSON.stringify(legacy);
    expect(validateAdminConfig(legacy)).toBe(legacy);
    expect(adminConfigId(legacy)).toBe(createHash('sha256').update(before).digest('hex'));
    expect(await verifyAdmin(legacy, '287082', -1, 59_000)).toBe(1);
    expect(await verifyAdmin(legacy, '287082', 1, 59_000)).toBeNull();
    expect(JSON.stringify(legacy)).toBe(before);
  });

  it('accepts only six digits within the clock window and rejects consumed counters', async () => {
    const config = await makeAdminConfig(testSecret);
    expect(await verifyAdmin(config, '287082', -1, 59_000)).toBe(1);
    expect(await verifyAdmin(config, '081804', -1, 1_111_111_109_000)).toBe(37_037_036);
    for (const code of ['', '28708', '0287082', '２８７０８２', 287082, null]) {
      expect(await verifyAdmin(config, code, -1, 59_000)).toBeNull();
    }
    expect(await verifyAdmin(config, '287082', -1, 120_000)).toBeNull();
    expect(await verifyAdmin(config, '287082', 1, 59_000)).toBeNull();
    expect(await verifyAdmin(config, totp(testSecret, 2), 1, 59_000)).toBe(2);
  });
});
