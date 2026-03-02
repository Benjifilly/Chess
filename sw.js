// Service Worker for ChessMate Push Notifications
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});


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

      const visibleChessClient = clientList.find(function (c) {
        return (
          c.url.includes('/Chess/') &&
          c.visibilityState === 'visible'
        );
      });

      if (visibleChessClient) {
        visibleChessClient.postMessage({
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

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/Chess/?from=push';

  const promiseChain = clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {

      const existing = clientList.find(c => c.url.includes('/Chess/'));
      if (existing) {
        return existing.focus().then(function (fc) {
          return fc.navigate(targetUrl);
        });
      }

      return clients.openWindow(targetUrl);
    })
    .catch(function (err) {
      console.error('[SW] notificationclick error:', err);
      return clients.openWindow('/Chess/?from=push');
    });

  event.waitUntil(promiseChain);
});
