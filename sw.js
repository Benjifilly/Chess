// Service Worker for ChessMate — Push Notifications + Offline Cache
//
// Strategies:
//   - HTML (navigation): network-first, fall back to cache so updates ship fast
//   - Static (CSS/JS/img/pieces/sounds/wasm): cache-first, lazy-fill on miss
//   - Cross-origin CDNs (fonts, libs): cache-first, lazy-fill
//
// Bump CACHE_VERSION to invalidate the cache on a new deploy.

const CACHE_VERSION = 'chessmate-v6';
const PRECACHE = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './config.js',
    './manifest.json',
    './images/logo.png',
    './images/benji.png',
    './images/benji_robot.png',
    './images/sanaa.jpg',
    './sound/capture.mp3',
    './sound/echec.mp3',
    './sound/faaah.mp3',
    './sound/move-self.mp3',
    './pièces/default/white-king.png',
    './pièces/default/black-king.png',
    './pièces/default/white-queen.png',
    './pièces/default/black-queen.png',
    './pièces/default/white-rook.png',
    './pièces/default/black-rook.png',
    './pièces/default/white-bishop.png',
    './pièces/default/black-bishop.png',
    './pièces/default/white-knight.png',
    './pièces/default/black-knight.png',
    './pièces/default/white-pawn.png',
    './pièces/default/black-pawn.png'
];

// Allow the page to ask the new SW to take over immediately. The page sends
// `{type:'SKIP_WAITING'}` once it detects an installed update, then it
// reloads on `controllerchange`. This is what makes redeploys feel instant.
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => {
            // Precache the critical shell — failures on individual assets
            // shouldn't abort the install (e.g. piece set 2 may not ship).
            return Promise.all(PRECACHE.map((url) =>
                cache.add(url).catch((err) => {
                    console.warn('[SW] precache miss:', url, err && err.message);
                })
            ));
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            // Drop old versions
            caches.keys().then((keys) =>
                Promise.all(keys
                    .filter((k) => k !== CACHE_VERSION)
                    .map((k) => caches.delete(k))
                )
            ),
            clients.claim()
        ])
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Only handle GET; let everything else (POST to Supabase, etc.) hit the
    // network unmodified.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Don't intercept Supabase realtime (websocket-ish) or API calls — they
    // must always hit the network with auth headers.
    if (url.hostname.endsWith('supabase.co')) return;

    // Skip cross-origin fetches with credentials we shouldn't replay
    if (req.mode === 'cors' && url.origin !== self.location.origin && !isCachableCDN(url)) {
        return;
    }

    // HTML navigation: network-first
    if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
        event.respondWith(networkFirst(req));
        return;
    }

    // Everything else: cache-first
    event.respondWith(cacheFirst(req));
});

function isCachableCDN(url) {
    return (
        url.hostname === 'fonts.googleapis.com' ||
        url.hostname === 'fonts.gstatic.com' ||
        url.hostname === 'cdn.jsdelivr.net' ||
        url.hostname === 'cdnjs.cloudflare.com'
    );
}

async function networkFirst(req) {
    const cache = await caches.open(CACHE_VERSION);
    try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
    } catch (err) {
        const cached = await cache.match(req);
        if (cached) return cached;
        // Final fallback: serve shell so the PWA still opens offline
        const shell = await cache.match('./index.html');
        if (shell) return shell;
        throw err;
    }
}

async function cacheFirst(req) {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type !== 'opaque') {
            cache.put(req, fresh.clone());
        } else if (fresh && fresh.type === 'opaque') {
            // Opaque (CORS-less third party) — cache anyway, can't inspect
            cache.put(req, fresh.clone());
        }
        return fresh;
    } catch (err) {
        // Last-resort: nothing we can do
        throw err;
    }
}

// =================================================================
// Push notifications (unchanged from previous version)
// =================================================================

self.addEventListener('push', function (event) {

  // ── 1. Safe JSON parse ──────────────────────────────────────────────────────
  let data = {};
  try {
    if (event.data) {
      const raw = event.data.text();
      if (raw && raw.trim().startsWith('{')) {
        data = JSON.parse(raw);
      }
    }
  } catch (err) {
    console.warn('[SW] push payload parse error:', err);
  }

  const title   = data.title   || 'ChessMate';
  const body    = data.message || data.body || "Un adversaire vous invite à jouer !";
  const destUrl = data.url     || '/Chess/?from=push';
  const tag     = data.tag     || 'chessmate-invite';

  const notifOptions = {
    body,
    icon:             '/Chess/images/logo.png',
    badge:            '/Chess/images/logo.png',
    tag,
    renotify:         false,
    requireInteraction: true,
    data: { url: destUrl }
  };

  // ── 2. Main promise chain (kept alive by event.waitUntil) ──────────────────
  const promiseChain = clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {

      // Sur iOS PWA, clients.matchAll() ne retourne rien quand l'app est
      // en arrière-plan ou minimisée. On ne peut donc PAS se fier à
      // clientList.length > 0 pour supprimer la notification.
      // Stratégie : on cherche un client FOCUSED (vraiment actif au premier plan).
      const focusedChessClient = clientList.find(function (c) {
        return (
          c.url.includes('/Chess/') &&
          c.visibilityState === 'visible' &&
          c.focused === true
        );
      });

      if (focusedChessClient) {
        // L'utilisateur regarde l'app → pas de notification OS
        focusedChessClient.postMessage({
          type: 'PUSH_RECEIVED',
          data: data
        });
        return Promise.resolve();
      }

      return self.registration.showNotification(title, notifOptions);
    })
    .catch(function (err) {
      console.error('[SW] push handler error:', err);
      return self.registration.showNotification('ChessMate', {
        body: "Nouvelle activité dans votre partie.",
        tag:  'chessmate-fallback'
      });
    });

  // ── 3. Keep the Service Worker alive for the full async chain ─────────────
  event.waitUntil(promiseChain);
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  const promiseChain = clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {

      const existing = clientList.find(c => c.url.includes('/Chess/'));
      if (existing) {
        // Envoyer un message à l'app existante pour rejoindre la partie directement
        existing.postMessage({ type: 'NOTIFICATION_CLICK', action: 'join_game' });
        return existing.focus();
      }

      // Pas de client existant — ouvrir l'app avec ?from=push
      return clients.openWindow('/Chess/?from=push');
    })
    .catch(function (err) {
      console.error('[SW] notificationclick error:', err);
      return clients.openWindow('/Chess/?from=push');
    });

  event.waitUntil(promiseChain);
});
