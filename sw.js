const CACHE_VERSION = 'v5';
const CACHE_NAME = `chess-pwa-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json'
];

// Install: Cache core files
self.addEventListener('install', (event) => {
  // Force the waiting service worker to become the active service worker.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

// Activate: Clean up old caches
self.addEventListener('activate', (event) => {
  // Tell the active service worker to take control of the page immediately.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('chess-pwa-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: Network First Strategy for EVERYTHING
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Network success: update cache and return
        // We only cache valid 200 responses (Basic or CORS)
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed, try to get it from the cache
        return caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }
            // Fallback for navigation
            if (event.request.mode === 'navigate') {
                return caches.match('./index.html');
            }
        });
      })
  );
});
