import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notificationCapability, notificationPlatformCapability, notificationRegistration } from '../src/lib/push';
beforeEach(() => {
  vi.stubGlobal('window', { isSecureContext: true, Notification: {}, PushManager: {}, caches: {} });
  vi.stubGlobal('navigator', { userAgent: 'Desktop', platform: 'MacIntel', maxTouchPoints: 0, serviceWorker: { ready: new Promise(() => {}) }, locks: {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('Notification', { permission: 'default' });
});
afterEach(() => vi.unstubAllGlobals());
it('distinguishes iPhone/iPad home-screen setup from unsupported browsers and denied permission', () => {
  Object.assign(navigator, { userAgent: 'iPhone' }); expect(notificationPlatformCapability()).toBe('home-screen');
  Object.assign(navigator, { standalone: true }); expect(notificationPlatformCapability()).toBe('available');
  Object.assign(navigator, { userAgent: 'Desktop', standalone: false, maxTouchPoints: 5 }); expect(notificationPlatformCapability()).toBe('home-screen');
  Object.assign(navigator, { maxTouchPoints: 0 }); Object.defineProperty(Notification, 'permission', { value: 'denied' }); expect(notificationPlatformCapability()).toBe('blocked');
  delete (window as unknown as Record<string, unknown>).PushManager; expect(notificationPlatformCapability()).toBe('unsupported');
});
it('distinguishes an unconfigured service from a network failure without permission prompts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ enabled: false, publicKey: null }))));
  expect(await notificationCapability(new AbortController().signal)).toBe('unavailable');
  vi.mocked(fetch).mockRejectedValue(new TypeError('network'));
  expect(await notificationCapability(new AbortController().signal)).toBe('unknown');
});
it('cancels an indefinitely waiting worker when the runtime ends and rejects late readiness', async () => {
  const abort = new AbortController(); let ready!: (value: ServiceWorkerRegistration) => void;
  Object.assign(navigator.serviceWorker, { ready: new Promise(resolve => { ready = resolve; }) });
  const pending = notificationRegistration(abort.signal); abort.abort();
  await expect(pending).rejects.toThrow(); ready({} as ServiceWorkerRegistration);
  await expect(notificationRegistration(abort.signal)).rejects.toThrow();
});
