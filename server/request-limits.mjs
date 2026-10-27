import { isIP } from 'node:net';

function normalizedAddress(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const address = value.trim();
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return null;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
    if (!mapped) return canonical;
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  } catch { return null; }
}

/** The edge overwrites XFF with one address; chains and malformed values fail closed. */
export function createClientAddress(trustedProxyAddresses = []) {
  const trusted = new Set(trustedProxyAddresses.map(normalizedAddress).filter(Boolean));
  return request => {
    const socket = normalizedAddress(request.socket?.remoteAddress) ?? 'unknown';
    if (!trusted.has(socket)) return socket;
    return normalizedAddress(request.headers['x-forwarded-for']) ?? socket;
  };
}

/** Active buckets are never evicted to admit attacker-controlled new keys. */
export function createRequestLimiter({ maxEntries = 10_000, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('INVALID_RATE_LIMIT_CAPACITY');
  const entries = new Map();
  let sweepAt = 0;
  return {
    take(key, limit, windowMs = 60_000) {
      const time = now();
      if (time >= sweepAt) {
        for (const [storedKey, entry] of entries) if (entry.resetAt <= time) entries.delete(storedKey);
        sweepAt = time + 1_000;
      }
      let entry = entries.get(key);
      if (!entry || entry.resetAt <= time) {
        if (!entry && entries.size >= maxEntries) return { allowed: false, retryAfter: 1 };
        entry = { count: 0, resetAt: time + windowMs };
        entries.set(key, entry);
      }
      entry.count = Math.min(entry.count + 1, limit + 1);
      return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - time) / 1_000)) };
    },
  };
}

// Source budgets accommodate multiple devices/NAT; device budgets survive IP changes.
export const WRITE_LIMITS = Object.freeze({
  'mls-events': { source: 720, device: 60 },
  'mls-welcome': { source: 240, device: 12 },
  'blob-complete': { source: 1_440, device: 120 },
  'push-delete': { source: 240, device: 12 },
});
