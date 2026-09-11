import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCallConfiguration } from '../src/lib/api';
import { parseIceUrl, validateCallConfiguration } from '../src/lib/call-configuration';
const direct = { iceServers: [], iceTransportPolicy: 'all', relayConfigured: false };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('bounded configuration and strict ICE validation', () => {
  it('retries network/429/5xx with 250/500/1000ms delays', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response('{}', { status: 429 })).mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValue(new Response(JSON.stringify(direct)));
    vi.stubGlobal('fetch', fetcher); const result = getCallConfiguration('room', 'test-only');
    await vi.advanceTimersByTimeAsync(1749); expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); expect(await result).toMatchObject(direct);
    expect(fetcher).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });
  for (const status of [401, 403]) it(`does not retry HTTP ${status}`, async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status })); vi.stubGlobal('fetch', fetcher);
    await expect(getCallConfiguration('room', 'test-only')).rejects.toMatchObject({ status }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects malformed JSON immediately and bounds a never resolving request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{')); vi.stubGlobal('fetch', fetcher);
    await expect(getCallConfiguration('room', 'test-only')).rejects.toMatchObject({ code: 'CALL_CONFIG_INVALID' }); expect(fetcher).toHaveBeenCalledOnce();
    vi.useFakeTimers(); fetcher.mockReset().mockImplementation(() => new Promise(() => {}));
    const result = expect(getCallConfiguration('room', 'test-only')).rejects.toMatchObject({ code: 'CALL_CONFIG_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(17_750); await result; expect(fetcher).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });
  it('canonicalizes duplicate endpoints and keeps all protocols and region metadata', () => {
    const urls = ['turn:EU.test', 'turn:eu.test:3478?transport=udp', 'turn:eu.test?transport=tcp', 'turns:ap.test'];
    const config = validateCallConfiguration({ iceServers: [{ urls, username: 'fixture', credential: 'fixture' }, { urls: 'stun:stun.test' }], iceRoutes: [{ url: 'turn:EU.test', region: 'eu' }], iceTransportPolicy: 'all', relayConfigured: true, expiresAt: Date.now() + 7200000, verifiedPeerIds: ['untrusted'] });
    expect(config.iceRoutes).toHaveLength(4); expect(config.iceRoutes?.[0]?.region).toBe('eu'); expect(config.verifiedPeerIds).toBeUndefined();
    expect(config.iceRoutes?.map(route => route.protocol)).toEqual(['udp', 'tcp', 'tls', 'udp']);
  });
  for (const url of ['https://turn.test', 'turn:256.1.1.1', 'turn:[::xyz]', 'turn:host:0', 'turn:host:65536', 'turns:host?transport=udp', 'turn:host?transport=tls', 'stun:host?transport=udp', 'turn:user@host', 'turn:host/path']) it(`rejects invalid route ${url}`, () => expect(() => parseIceUrl(url)).toThrow());
  it('rejects empty relay configuration and expired TURN credentials', () => {
    expect(() => validateCallConfiguration({ ...direct, iceTransportPolicy: 'relay' })).toThrow();
    expect(() => validateCallConfiguration({ ...direct, relayConfigured: true })).toThrow();
    expect(() => validateCallConfiguration({ iceServers: [{ urls: 'turn:host', username: 'fixture', credential: 'fixture' }], iceTransportPolicy: 'relay', relayConfigured: true, expiresAt: Date.now() - 1 })).toThrow();
  });
});
