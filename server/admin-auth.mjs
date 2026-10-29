import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export const encodeBase32 = bytes => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
};
const decodeBase32 = secret => {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32}$/.test(secret)) throw new Error('INVALID_ADMIN_CONFIG');
  let bits = 0, value = 0; const bytes = [];
  for (const char of secret) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
};

export function totp(secret, counter = Math.floor(Date.now() / 30_000)) {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(bytes).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export async function makeAdminConfig(totpSecret = encodeBase32(randomBytes(20))) {
  return validateAdminConfig({ v: 2, totpSecret });
}

export function validateAdminConfig(config) {
  if (config?.v === 2 && Object.keys(config).sort().join(',') !== 'totpSecret,v') throw new Error('INVALID_ADMIN_CONFIG');
  // Preserve deployed v1 files verbatim: their identity owns the persisted replay counter.
  if (config?.v !== 2 && (config?.v !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(config.salt) || !/^[A-Za-z0-9_-]{43}$/.test(config.hash))) throw new Error('INVALID_ADMIN_CONFIG');
  decodeBase32(config.totpSecret);
  return config;
}

export function adminConfigId(config) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }

export async function verifyAdmin(config, code, lastCounter = -1, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(now / 30_000);
  for (const candidate of [counter, counter - 1, counter + 1]) {
    if (candidate > lastCounter && timingSafeEqual(Buffer.from(code), Buffer.from(totp(config.totpSecret, candidate)))) return candidate;
  }
  return null;
}
