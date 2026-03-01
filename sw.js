const CACHE_VERSION = 'hydrosense-v5';
const APP_SHELL_CACHE = `app-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.png',
  './icon.png',
  './css/style.css',
  './js/data-loader.js',
  './js/map-renderer.js',
  './js/ble-sync.js',
  './js/pwa.js',
  './js/app.js',
  './data/sensors.geojson'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![APP_SHELL_CACHE, RUNTIME_CACHE].includes(key))
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isApiRequest =
    url.pathname.includes('/obruk-api/') ||
    url.pathname.endsWith('/data/latest.json') ||
    url.pathname.endsWith('/data/history.json');

  const isNavigationRequest = request.mode === 'navigate';

  // API isteklerinde her zaman ağdan oku; cache sadece fallback olsun.
  if (isApiRequest) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => networkResponse)
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return new Response(JSON.stringify({ error: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  if (isNavigationRequest) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const cloned = networkResponse.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, cloned));
          return networkResponse;
        })
        .catch(async () => {
          const cachedPage = await caches.match(request);
          if (cachedPage) return cachedPage;
          return caches.match('./index.html');
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(request)
        .then((networkResponse) => {
          if (!networkResponse) return networkResponse;
          if (networkResponse.ok || networkResponse.type === 'opaque') {
            const cloned = networkResponse.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, cloned));
          }
          return networkResponse;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
