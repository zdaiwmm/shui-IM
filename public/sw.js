const RELEASE_ID = '__QUIET_ROOM_RELEASE_ID__';
const CACHE = `quiet-room-shell-${RELEASE_ID}`;
const NOTIFICATION_POLICY_CACHE = 'quiet-room-notification-policy-v1';
const NOTIFICATION_POLICY_URL = '/__quiet-room-notification-policy';
const NOTIFICATION_COPY_URL = '/__quiet-room-notification-copy';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

function isCacheableAsset(url) {
  return url.origin === self.location.origin && (
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/icon.svg' ||
    url.pathname === '/manifest.webmanifest'
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter((key) => key !== CACHE && key !== NOTIFICATION_POLICY_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map(client => client.postMessage({
      type: 'quiet-room-release-ready',
      releaseId: RELEASE_ID,
    })));
  })());
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.pathname.startsWith('/api/') || requestUrl.pathname === '/ws') {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const isHtml = /^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '');
        if (response.ok && isHtml && !response.redirected) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => {}));
          return response;
        }
        // A deployment's 503 page or proxy error must not replace a working
        // offline shell. Keep local unlock available while the service recovers.
        return await caches.match('/') ?? response;
      } catch {
        return await caches.match('/') ?? Response.error();
      }
    })());
    return;
  }

  if (!isCacheableAsset(requestUrl)) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {}));
      }
      return response;
    })),
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const policy = await (await caches.open(NOTIFICATION_POLICY_CACHE)).match(NOTIFICATION_POLICY_URL);
    if (policy && await policy.text() !== 'on') return;
    let copy = { title: 'Quiet Room', body: '有一条新消息，解锁后查看。' };
    try {
      const response = await (await caches.open(NOTIFICATION_POLICY_CACHE)).match(NOTIFICATION_COPY_URL);
      const value = response ? await response.json() : null;
      const count = text => [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].length;
      if (value?.v === 1 && typeof value.title === 'string' && typeof value.body === 'string' && count(value.title) <= 24 && count(value.body) <= 80 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.title + value.body)) {
        copy = { title: value.title.trim() || copy.title, body: value.body.trim() || copy.body };
      }
    } catch { /* Corrupt/missing local copy must not suppress an otherwise allowed wake. */ }
    await self.registration.showNotification(copy.title, {
      body: copy.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'quiet-room-wake',
      renotify: false,
      silent: false,
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      return;
    }
    await self.clients.openWindow('/');
  })());
});
