const CACHE = 'quiet-room-shell-v6';
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
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
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
  event.waitUntil(self.registration.showNotification('Quiet Room', {
    body: '有一条新消息，解锁后查看。',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'quiet-room-wake',
    renotify: false,
    silent: false,
    data: { url: '/' },
  }));
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
