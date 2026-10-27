import { describe, expect, it } from 'vitest';
import { createClientAddress, createRequestLimiter } from '../server/request-limits.mjs';

const request = (remoteAddress: string, forwarded?: string | string[]) => ({
  socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded },
});

describe('trusted client addresses', () => {
  it('ignores forwarding from untrusted peers and normalizes mapped socket addresses', () => {
    const address = createClientAddress(['127.0.0.1']);
    expect(address(request('192.0.2.10', '198.51.100.1'))).toBe('192.0.2.10');
    expect(address(request('::ffff:127.0.0.1', '198.51.100.1'))).toBe('198.51.100.1');
    expect(address(request('::ffff:7f00:1', '::ffff:c633:6401'))).toBe('198.51.100.1');
  });
  it('rejects forged chains, duplicate headers, ports and malformed addresses', () => {
    const address = createClientAddress(['127.0.0.1']);
    for (const forwarded of ['fake, 198.51.100.1', '192.0.2.1, 198.51.100.1',
      ['192.0.2.1', '198.51.100.1'], '198.51.100.1:443', 'fake', '', 'a'.repeat(100)]) {
      expect(address(request('127.0.0.1', forwarded))).toBe('127.0.0.1');
    }
    expect(address(request('127.0.0.1'))).toBe('127.0.0.1');
  });
  it('canonicalizes equivalent IPv6 spellings into one rate-limit identity', () => {
    const address = createClientAddress(['::1']);
    expect(address(request('::1', '2001:0DB8:0:0:0:0:0:1'))).toBe('2001:db8::1');
    expect(address(request('::1', '2001:db8::1'))).toBe('2001:db8::1');
  });
});

describe('bounded request budgets', () => {
  it('isolates keys, reports remaining wait and restores admission at the fixed deadline', () => {
    let time = 1_000;
    const limiter = createRequestLimiter({ now: () => time });
    expect(limiter.take('a', 1).allowed).toBe(true);
    expect(limiter.take('a', 1)).toEqual({ allowed: false, retryAfter: 60 });
    expect(limiter.take('b', 1).allowed).toBe(true);
    time += 15_100;
    expect(limiter.take('a', 1)).toEqual({ allowed: false, retryAfter: 45 });
    time = 61_000;
    expect(limiter.take('a', 1).allowed).toBe(true);
  });
  it('does not reset active budgets when an attacker floods new keys at capacity', () => {
    let time = 0;
    const limiter = createRequestLimiter({ maxEntries: 2, now: () => time });
    expect(limiter.take('blocked', 1).allowed).toBe(true);
    expect(limiter.take('other', 2).allowed).toBe(true);
    for (let i = 0; i < 100; i++) expect(limiter.take(`flood-${i}`, 1).allowed).toBe(false);
    expect(limiter.take('blocked', 1).allowed).toBe(false);
    expect(limiter.take('other', 2).allowed).toBe(true);
    time = 60_000;
    expect(limiter.take('new-client', 1).allowed).toBe(true);
  });
});
