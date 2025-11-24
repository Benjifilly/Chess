const CACHE_VERSION = 'v4';
const CACHE_NAME = `chess-pwa-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch((err) => {
      console.error('SW install cache error:', err);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('chess-pwa-') && key !== CACHE_NAME)
          .map((staleKey) => caches.delete(staleKey))
      )
    ).then(() => self.clients.claim())
  );
});

function isHttpRequest(request) {
  return request.url.startsWith('http://') || request.url.startsWith('https://');
}

function networkFirst(request) {
  if (!isHttpRequest(request)) {
    return fetch(request);
  }

  return fetch(request)
    .then((response) => {
      if (!response || response.status !== 200 || response.type !== 'basic') {
        return response;
      }
      const responseClone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
      return response;
    })
    .catch(() => caches.match(request));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (!isHttpRequest(request)) {
    return;
  }

  // Always try network first for navigation and core files
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (request.destination === 'style' || request.destination === 'script') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Default cache-first fallback
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
